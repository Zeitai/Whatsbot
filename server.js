require('dotenv').config();
const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const path     = require('path');
const logger   = require('./utils/logger');

const webhookRoutes = require('./routes/webhook');
const adminRoutes   = require('./routes/admin');

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '5mb' })); // WA payloads + base64 images can be chunky
app.use(express.urlencoded({ extended: true }));

// Serve the dashboard (whatsapp_ai_saas_dashboard.html -> public/index.html)
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ────────────────────────────────────────────────────────────────
app.use('/webhook', webhookRoutes);
app.use('/admin', adminRoutes);

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    dbState: mongoose.connection.readyState, // 1 = connected
    uptime: process.uptime(),
  });
});

// Fallback to dashboard for any other GET (simple SPA-style serving)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/admin') || req.path.startsWith('/webhook')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Error handler ─────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.stack || err.message}`);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Daily stats reset (resets todayMessages at midnight server time) ───────
const Client = require('./models/Client');
function scheduleMidnightReset() {
  const now = new Date();
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  const msUntilMidnight = nextMidnight - now;

  setTimeout(async () => {
    try {
      await Client.updateMany({}, { $set: { 'stats.todayMessages': 0, 'stats.lastResetAt': new Date() } });
      logger.info('Daily stats reset for all clients');
    } catch (err) {
      logger.error(`Daily reset failed: ${err.message}`);
    }
    scheduleMidnightReset(); // reschedule for the next day
  }, msUntilMidnight);
}

// ── Startup ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    logger.info('MongoDB connected');

    app.listen(PORT, () => {
      logger.info(`WhatsBOT server running on port ${PORT}`);
      logger.info(`Dashboard:      http://localhost:${PORT}`);
      logger.info(`Webhook base:   http://localhost:${PORT}/webhook/:clientSlug`);
      logger.info(`Admin API base: http://localhost:${PORT}/admin`);
    });

    scheduleMidnightReset();
  } catch (err) {
    logger.error(`Failed to start server: ${err.message}`);
    process.exit(1);
  }
}

start();

module.exports = app;
