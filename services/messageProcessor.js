const { getAIReply, getVisionReply } = require('./aiService');
const { transcribeVoiceNote, downloadWhatsAppMedia } = require('./transcriptionService');
const { sendText, sendButtons, markRead } = require('./whatsappService');
const Conversation            = require('../models/Conversation');
const Client                  = require('../models/Client');
const logger                  = require('../utils/logger');

/**
 * Message Processor
 *
 * This is the brain. It handles every incoming WhatsApp message:
 * text → AI reply
 * voice note → transcribe → AI reply
 * image → describe → AI reply
 * "agent" keyword → escalation alert
 */
async function processMessage(client, waMessage, customerPhone, customerName) {
  // 1. Load (or create) conversation history for this customer
  let convo = await Conversation.findOne({
    clientId: client._id,
    customerPhone,
  });

  if (!convo) {
    convo = new Conversation({
      clientId:      client._id,
      clientSlug:    client.slug,
      customerPhone,
      customerName,
      messages:      [],
    });
  }

  // 2. Extract message content based on type
  let userText = '';
  let messageType = 'text';

  if (waMessage.type === 'text') {
    userText = waMessage.text.body;

  } else if (waMessage.type === 'audio' && client.features.voiceNotes) {
    messageType = 'audio';
    logger.info(`[${client.slug}] Voice note received from ${customerPhone}, transcribing…`);

    try {
      userText = await transcribeVoiceNote(
        waMessage.audio.id,
        client.fbToken,
        { provider: process.env.TRANSCRIPTION_PROVIDER }
      );
      logger.info(`[${client.slug}] Transcribed: "${userText}"`);
      // Prefix so AI knows it was a voice note
      userText = `[Voice note]: ${userText}`;
    } catch (err) {
      logger.error(`[${client.slug}] Transcription failed: ${err.message}`);
      await sendText(client.phoneNumberId, client.fbToken, customerPhone,
        '🎤 Sorry, I couldn\'t understand that voice note. Could you type your question?');
      return;
    }

  } else if (waMessage.type === 'image' && client.features.imageUnderstanding) {
    messageType = 'image';
    const caption = waMessage.image.caption || null;
    logger.info(`[${client.slug}] Image received from ${customerPhone}, analyzing…`);

    try {
      const { buffer, mimeType } = await downloadWhatsAppMedia(waMessage.image.id, client.fbToken);
      const imageBase64 = buffer.toString('base64');

      await recordMessage(convo, 'user', caption ? `[Image]: ${caption}` : '[Image]', messageType);

      const visionResult = await getVisionReply(imageBase64, mimeType, caption, client.systemPrompt, {
        aiProvider: client.aiProvider,
        aiModel:    client.aiModel,
        aiApiKey:   client.aiApiKey,
        maxTokens:  client.maxTokens,
      });

      await sendText(client.phoneNumberId, client.fbToken, customerPhone, visionResult.reply);
      await recordMessage(convo, 'assistant', visionResult.reply, 'text', visionResult.provider, visionResult.latencyMs);

      await Client.updateOne({ _id: client._id }, {
        $inc: { 'stats.totalMessages': 1, 'stats.todayMessages': 1 },
        $set: { 'stats.lastMessageAt': new Date() }
      });
    } catch (err) {
      logger.error(`[${client.slug}] Image understanding failed: ${err.message}`);
      await sendText(client.phoneNumberId, client.fbToken, customerPhone,
        '🖼️ Sorry, I couldn\'t process that image right now. Could you describe it in text?');
    }
    return; // image flow is fully handled above, skip the standard text pipeline below

  } else {
    // Unsupported message type
    await sendText(client.phoneNumberId, client.fbToken, customerPhone,
      'Sorry, I can only handle text messages and voice notes right now.');
    return;
  }

  // 3. Check for human escalation keywords
  if (client.features.humanEscalation) {
    const lowerText = userText.toLowerCase();
    const triggered = client.escalationKeywords.some(kw => lowerText.includes(kw.toLowerCase()));

    if (triggered && !convo.escalated) {
      convo.escalated   = true;
      convo.escalatedAt = new Date();
      await convo.save();

      // Notify via webhook if configured
      if (client.escalationWebhookUrl) {
        notifyEscalation(client, customerPhone, userText).catch(e =>
          logger.warn(`Escalation webhook failed: ${e.message}`)
        );
      }

      await sendText(client.phoneNumberId, client.fbToken, customerPhone,
        '✋ I\'m connecting you with a team member right away. They\'ll be with you shortly. Thank you for your patience!');

      await recordMessage(convo, 'user', userText, messageType);
      await recordMessage(convo, 'assistant', '[Escalated to human]', 'escalation');
      return;
    }
  }

  // 4. Record the user message
  await recordMessage(convo, 'user', userText, messageType);

  // 5. Build message history for AI (last N messages)
  const history = convo.messages
    .slice(-(client.memoryLength * 2))   // *2 because user+assistant pairs
    .map(m => ({ role: m.role, content: m.content }));

  // 6. Get AI reply
  let aiResult;
  try {
    aiResult = await getAIReply(history, client.systemPrompt, {
      aiProvider: client.aiProvider,
      aiModel:    client.aiModel,
      aiApiKey:   client.aiApiKey,
      maxTokens:  client.maxTokens,
    });
  } catch (err) {
    logger.error(`[${client.slug}] AI error: ${err.message}`);
    await sendText(client.phoneNumberId, client.fbToken, customerPhone,
      'Sorry, I\'m having trouble right now. Please try again in a moment!');
    return;
  }

  const { reply, provider, model, latencyMs } = aiResult;
  logger.info(`[${client.slug}] AI (${provider}/${model}) replied in ${latencyMs}ms`);

  // 7. Send reply to customer
  await sendText(client.phoneNumberId, client.fbToken, customerPhone, reply);

  // 8. Record AI reply + update stats
  await recordMessage(convo, 'assistant', reply, 'text', provider, latencyMs);

  await Client.updateOne({ _id: client._id }, {
    $inc: { 'stats.totalMessages': 1, 'stats.todayMessages': 1 },
    $set: { 'stats.lastMessageAt': new Date() }
  });
}

/**
 * Save a message to conversation history
 */
async function recordMessage(convo, role, content, type = 'text', aiProvider = null, latencyMs = null) {
  convo.messages.push({ role, content, type, aiProvider, latencyMs });
  // Keep only last 200 messages per conversation to save DB space
  if (convo.messages.length > 200) {
    convo.messages = convo.messages.slice(-200);
  }
  await convo.save();
}

/**
 * Fire escalation webhook (non-blocking)
 */
async function notifyEscalation(client, customerPhone, lastMessage) {
  const axios = require('axios');
  await axios.post(client.escalationWebhookUrl, {
    event:         'escalation',
    clientName:    client.name,
    customerPhone,
    lastMessage,
    timestamp:     new Date().toISOString(),
  }, { timeout: 5000 });
}

module.exports = { processMessage };
