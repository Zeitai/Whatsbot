const mongoose = require('mongoose');

/**
 * Client model — one document per customer (e.g. "Pizza Palace")
 * You update fbToken and aiApiKey when a customer pays.
 */
const clientSchema = new mongoose.Schema({
  // Basic info
  name:         { type: String, required: true },
  slug:         { type: String, required: true, unique: true }, // pizza-palace
  businessType: { type: String, default: 'general' },
  emoji:        { type: String, default: '🤖' },
  active:       { type: Boolean, default: true },

  // ── WhatsApp / Meta credentials ──────────────────────────
  // You get these from Meta Business Suite per client
  fbToken:        { type: String },                   // Page Access Token (EAAxx...) — set once client is connected
  phoneNumberId:  { type: String },                   // WhatsApp Phone Number ID — set once client is connected
  wabaId:         { type: String },                   // WhatsApp Business Account ID
  verifyToken:    { type: String, required: true },   // Webhook verify token (auto-generated if not provided)

  // ── AI configuration ──────────────────────────────────────
  aiProvider: {
    type: String,
    enum: ['gemini', 'groq', 'mistral', 'openai', 'claude', 'cohere', 'global'],
    default: 'global'   // 'global' = use the server's DEFAULT_AI_PROVIDER
  },
  aiModel:    { type: String },          // e.g. 'gemini-1.5-flash' — blank = provider default
  aiApiKey:   { type: String },          // client's own key; blank = use global key from .env
  systemPrompt: {
    type: String,
    default: 'You are a helpful AI assistant. Be concise, friendly, and professional. Always reply in the same language the customer uses.'
  },
  maxTokens:  { type: Number, default: 500 },

  // ── Feature flags ─────────────────────────────────────────
  features: {
    voiceNotes:       { type: Boolean, default: true },   // transcribe & reply to audio
    imageUnderstanding:{ type: Boolean, default: true },  // read images customer sends
    humanEscalation:  { type: Boolean, default: true },   // "agent" keyword → flag for human
    conversationMemory:{ type: Boolean, default: true },  // remember last N messages
    autoLanguage:     { type: Boolean, default: true },   // reply in customer's language
    sentimentAlert:   { type: Boolean, default: false },  // alert on negative sentiment
    interactiveMenus: { type: Boolean, default: true },   // send WA buttons/lists
  },

  memoryLength: { type: Number, default: 10 }, // how many past messages to remember

  // ── Escalation ────────────────────────────────────────────
  escalationKeywords: {
    type: [String],
    default: ['agent', 'human', 'person', 'manager', 'help me', 'real person']
  },
  escalationWebhookUrl: { type: String }, // optional: POST here when escalated

  // ── Stats (lightweight counters) ─────────────────────────
  stats: {
    totalMessages:   { type: Number, default: 0 },
    todayMessages:   { type: Number, default: 0 },
    lastMessageAt:   { type: Date },
    lastResetAt:     { type: Date, default: Date.now },
  },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

clientSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Auto-generate slug from name
clientSchema.pre('validate', function(next) {
  if (!this.slug && this.name) {
    this.slug = this.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }
  next();
});

module.exports = mongoose.model('Client', clientSchema);
