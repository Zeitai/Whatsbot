const express = require('express');
const router  = express.Router();
const Client  = require('../models/Client');
const { processMessage } = require('../services/messageProcessor');
const { markRead }       = require('../services/whatsappService');
const logger             = require('../utils/logger');

/**
 * WEBHOOK ROUTES
 *
 * Each client gets their own webhook URL:
 * GET  /webhook/:clientSlug  → Meta verification challenge
 * POST /webhook/:clientSlug  → Incoming messages
 *
 * In Meta Business Suite, set webhook URL to:
 *   https://yourserver.com/webhook/pizza-palace
 *   https://yourserver.com/webhook/style-boutique
 *   etc.
 */

// ── GET: Meta webhook verification ──────────────────────────────────────────
// Meta sends this when you first set up the webhook in Business Suite
router.get('/:clientSlug', async (req, res) => {
  const { clientSlug } = req.params;
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  try {
    const client = await Client.findOne({ slug: clientSlug, active: true });

    if (!client) {
      logger.warn(`Webhook verify: unknown client "${clientSlug}"`);
      return res.sendStatus(404);
    }

    if (mode === 'subscribe' && token === client.verifyToken) {
      logger.info(`Webhook verified for client: ${client.name}`);
      return res.status(200).send(challenge);
    }

    logger.warn(`Webhook verify failed for "${clientSlug}": token mismatch`);
    return res.sendStatus(403);

  } catch (err) {
    logger.error(`Webhook verify error: ${err.message}`);
    return res.sendStatus(500);
  }
});

// ── POST: Incoming messages ──────────────────────────────────────────────────
router.post('/:clientSlug', async (req, res) => {
  // Always respond 200 immediately — Meta will retry if you take too long
  res.sendStatus(200);

  const { clientSlug } = req.params;
  const body = req.body;

  // Validate it's a WhatsApp message event
  if (body.object !== 'whatsapp_business_account') return;

  try {
    const client = await Client.findOne({ slug: clientSlug, active: true });
    if (!client) {
      logger.warn(`Incoming message for unknown client: "${clientSlug}"`);
      return;
    }

    // Process each entry (usually just one)
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;

        const value = change.value;

        // Handle status updates (read receipts, delivery) — just log them
        if (value.statuses) {
          for (const status of value.statuses) {
            logger.debug(`[${clientSlug}] Message ${status.id} status: ${status.status}`);
          }
          continue;
        }

        // Process actual messages
        for (const waMessage of value.messages || []) {
          const customerPhone = waMessage.from;
          const customerName  = value.contacts?.[0]?.profile?.name || null;

          logger.info(`[${client.name}] ${customerName || customerPhone}: ${waMessage.type} message`);

          // Mark as read (shows double blue tick)
          markRead(client.phoneNumberId, client.fbToken, waMessage.id)
            .catch(e => logger.warn(`markRead failed: ${e.message}`));

          // Process message (async, non-blocking)
          processMessage(client, waMessage, customerPhone, customerName)
            .catch(err => logger.error(`[${clientSlug}] processMessage error: ${err.message}`));
        }
      }
    }

  } catch (err) {
    logger.error(`Webhook POST error for "${clientSlug}": ${err.message}`);
  }
});

module.exports = router;
