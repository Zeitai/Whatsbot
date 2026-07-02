const mongoose = require('mongoose');

/**
 * Stores per-user conversation history for memory + analytics.
 * One document per (clientId + customerPhone) pair.
 */
const messageSchema = new mongoose.Schema({
  role:      { type: String, enum: ['user', 'assistant'], required: true },
  content:   { type: String, required: true },
  type:      { type: String, enum: ['text', 'audio', 'image', 'escalation'], default: 'text' },
  aiProvider:{ type: String },       // which AI replied
  latencyMs: { type: Number },       // how long AI took
  timestamp: { type: Date, default: Date.now },
}, { _id: false });

const conversationSchema = new mongoose.Schema({
  clientId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
  clientSlug:    { type: String, required: true },

  // Customer info from WhatsApp
  customerPhone: { type: String, required: true },   // e.g. "919876543210"
  customerName:  { type: String },                   // from WA profile if available

  messages:      { type: [messageSchema], default: [] },

  // Escalation state
  escalated:      { type: Boolean, default: false },
  escalatedAt:    { type: Date },
  humanTookOver:  { type: Boolean, default: false },

  // Sentiment tracking
  lastSentiment:  { type: String, enum: ['positive', 'neutral', 'negative'] },

  createdAt:  { type: Date, default: Date.now },
  updatedAt:  { type: Date, default: Date.now },
});

// Compound index: fast lookup per client + customer
conversationSchema.index({ clientId: 1, customerPhone: 1 }, { unique: true });
conversationSchema.index({ clientSlug: 1, updatedAt: -1 });

conversationSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Conversation', conversationSchema);
