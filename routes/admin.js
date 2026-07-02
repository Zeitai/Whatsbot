const express  = require('express');
const router   = express.Router();
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');
const Client   = require('../models/Client');
const Conversation = require('../models/Conversation');
const { sendText } = require('../services/whatsappService');
const logger   = require('../utils/logger');

// ── Auth middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ── POST /admin/login ────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (
    email    !== process.env.ADMIN_EMAIL ||
    password !== process.env.ADMIN_PASSWORD
  ) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token });
});

// ── GET /admin/verify ────────────────────────────────────────────────────────
// Used by the dashboard on page load to check if the stored token is still valid
router.get('/verify', requireAuth, (req, res) => {
  res.json({ ok: true, email: req.admin.email });
});

// ── GET /admin/dashboard ─────────────────────────────────────────────────────
router.get('/dashboard', requireAuth, async (req, res) => {
  const [clients, totalConvos] = await Promise.all([
    Client.find({}, 'name slug active stats aiProvider'),
    Conversation.countDocuments(),
  ]);

  const totalMessages = clients.reduce((s, c) => s + (c.stats.totalMessages || 0), 0);
  const todayMessages = clients.reduce((s, c) => s + (c.stats.todayMessages || 0), 0);

  res.json({
    activeClients:  clients.filter(c => c.active).length,
    totalClients:   clients.length,
    totalMessages,
    todayMessages,
    totalConvos,
    clients: clients.map(c => ({
      id:     c._id,
      name:   c.name,
      slug:   c.slug,
      active: c.active,
      stats:  c.stats,
      aiProvider: c.aiProvider,
    }))
  });
});

// ── GET /admin/clients ───────────────────────────────────────────────────────
router.get('/clients', requireAuth, async (req, res) => {
  const clients = await Client.find(); // full docs so we can compute hasToken, then strip secrets below
  res.json(clients.map(c => {
    const obj = c.toObject();
    obj.hasToken = !!obj.fbToken;
    obj.hasAiKey = !!obj.aiApiKey;
    delete obj.fbToken;
    delete obj.aiApiKey;
    return obj;
  }));
});

// ── POST /admin/clients ──────────────────────────────────────────────────────
router.post('/clients', requireAuth, async (req, res) => {
  try {
    const body = { ...req.body };
    if (!body.verifyToken) {
      const base = (body.name || 'client').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      body.verifyToken = `${base}_${Math.random().toString(36).slice(2, 10)}`;
    }
    const client = new Client(body);
    await client.save();
    logger.info(`New client created: ${client.name} (${client.slug})`);
    res.status(201).json({
      ...client.toObject(),
      fbToken:  '***',   // mask sensitive fields in response
      aiApiKey: '***',
    });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Slug already exists' });
    res.status(400).json({ error: err.message });
  }
});

// ── GET /admin/clients/:id ───────────────────────────────────────────────────
router.get('/clients/:id', requireAuth, async (req, res) => {
  const client = await Client.findById(req.params.id);
  if (!client) return res.status(404).json({ error: 'Not found' });
  const obj = client.toObject();
  obj.hasToken = !!obj.fbToken;
  obj.hasAiKey = !!obj.aiApiKey;
  delete obj.fbToken;
  delete obj.aiApiKey;
  res.json(obj);
});

// ── PATCH /admin/clients/:id ─────────────────────────────────────────────────
// Update any client field — including fbToken and aiApiKey when customer pays
router.patch('/clients/:id', requireAuth, async (req, res) => {
  try {
    const allowed = [
      'name', 'businessType', 'emoji', 'active',
      'fbToken', 'phoneNumberId', 'wabaId', 'verifyToken',   // tokens customer pays for
      'aiProvider', 'aiModel', 'aiApiKey', 'systemPrompt', 'maxTokens',
      'features', 'memoryLength', 'escalationKeywords', 'escalationWebhookUrl'
    ];

    const update = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }

    const client = await Client.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true }
    ).select('-fbToken -aiApiKey');

    if (!client) return res.status(404).json({ error: 'Not found' });
    logger.info(`Client updated: ${client.name}`);
    res.json(client);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── DELETE /admin/clients/:id ────────────────────────────────────────────────
router.delete('/clients/:id', requireAuth, async (req, res) => {
  await Client.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

// ── GET /admin/clients/:id/conversations ─────────────────────────────────────
router.get('/clients/:id/conversations', requireAuth, async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const convos = await Conversation
    .find({ clientId: req.params.id })
    .sort({ updatedAt: -1 })
    .skip((page - 1) * limit)
    .limit(Number(limit))
    .select('customerPhone customerName escalated updatedAt messages');

  // Return only last message preview, not full history (save bandwidth)
  const result = convos.map(c => ({
    id:            c._id,
    customerPhone: c.customerPhone,
    customerName:  c.customerName,
    escalated:     c.escalated,
    updatedAt:     c.updatedAt,
    lastMessage:   c.messages[c.messages.length - 1] || null,
    messageCount:  c.messages.length,
  }));

  res.json(result);
});

// ── GET /admin/conversations ──────────────────────────────────────────────────
// Most recently active conversations across ALL clients (dashboard feed + conversations page)
router.get('/conversations', requireAuth, async (req, res) => {
  const { limit = 30 } = req.query;
  const convos = await Conversation
    .find()
    .sort({ updatedAt: -1 })
    .limit(Number(limit))
    .populate('clientId', 'name slug emoji aiProvider');

  const result = convos.map(c => ({
    id:            c._id,
    clientId:      c.clientId?._id,
    clientName:    c.clientId?.name || '(deleted client)',
    clientSlug:    c.clientId?.slug,
    clientEmoji:   c.clientId?.emoji || '🤖',
    aiProvider:    c.clientId?.aiProvider,
    customerPhone: c.customerPhone,
    customerName:  c.customerName,
    escalated:     c.escalated,
    humanTookOver: c.humanTookOver,
    updatedAt:     c.updatedAt,
    lastMessage:   c.messages[c.messages.length - 1] || null,
    messageCount:  c.messages.length,
  }));

  res.json(result);
});

// ── GET /admin/conversations/:id ─────────────────────────────────────────────
router.get('/conversations/:id', requireAuth, async (req, res) => {
  const convo = await Conversation.findById(req.params.id).populate('clientId', 'name slug emoji aiProvider phoneNumberId fbToken');
  if (!convo) return res.status(404).json({ error: 'Not found' });
  res.json(convo);
});

// ── POST /admin/conversations/:id/reply ──────────────────────────────────────
// Human override: send a message to the customer directly as the business, bypassing the AI
router.post('/conversations/:id/reply', requireAuth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });

    const convo = await Conversation.findById(req.params.id).populate('clientId');
    if (!convo) return res.status(404).json({ error: 'Conversation not found' });
    const client = convo.clientId;
    if (!client) return res.status(400).json({ error: 'Client no longer exists' });

    await sendText(client.phoneNumberId, client.fbToken, convo.customerPhone, text);

    convo.messages.push({ role: 'assistant', content: text, type: 'text', aiProvider: 'human' });
    convo.humanTookOver = true;
    await convo.save();

    logger.info(`[${client.slug}] Human override sent to ${convo.customerPhone}`);
    res.json({ ok: true });
  } catch (err) {
    logger.error(`Human override failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/conversations/:id/resolve ────────────────────────────────────
// Clear the escalation flag once a human has handled it
router.post('/conversations/:id/resolve', requireAuth, async (req, res) => {
  const convo = await Conversation.findByIdAndUpdate(
    req.params.id,
    { $set: { escalated: false } },
    { new: true }
  );
  if (!convo) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── GET /admin/analytics ──────────────────────────────────────────────────────
router.get('/analytics', requireAuth, async (req, res) => {
  const clients = await Client.find({}, 'name slug stats aiProvider');

  // Messages by client
  const byClient = clients.map(c => ({
    name:    c.name,
    slug:    c.slug,
    total:   c.stats.totalMessages,
    today:   c.stats.todayMessages,
    aiProvider: c.aiProvider,
  }));

  // AI provider breakdown
  const providerCounts = {};
  clients.forEach(c => {
    const p = c.aiProvider === 'global' ? (process.env.DEFAULT_AI_PROVIDER || 'gemini') : c.aiProvider;
    providerCounts[p] = (providerCounts[p] || 0) + (c.stats.totalMessages || 0);
  });

  // Escalations
  const escalations = await Conversation.countDocuments({ escalated: true });
  const totalConvos = await Conversation.countDocuments();

  res.json({
    byClient,
    providerBreakdown: providerCounts,
    escalations,
    totalConversations: totalConvos,
    resolutionRate: totalConvos > 0
      ? Math.round(((totalConvos - escalations) / totalConvos) * 100) + '%'
      : 'N/A',
  });
});

// ── POST /admin/clients/:id/reset-stats ───────────────────────────────────────
router.post('/clients/:id/reset-stats', requireAuth, async (req, res) => {
  await Client.findByIdAndUpdate(req.params.id, {
    $set: { 'stats.todayMessages': 0, 'stats.lastResetAt': new Date() }
  });
  res.json({ ok: true });
});

module.exports = router;
