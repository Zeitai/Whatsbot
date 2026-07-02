const axios = require('axios');

const WA_API_VERSION = 'v18.0';
const WA_BASE = `https://graph.facebook.com/${WA_API_VERSION}`;

/**
 * WhatsApp Cloud API Service
 * Handles sending text, buttons, and list messages back to customers
 */

/**
 * Send a plain text message
 */
async function sendText(phoneNumberId, fbToken, to, text) {
  return waRequest(phoneNumberId, fbToken, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: false, body: text }
  });
}

/**
 * Send a message with up to 3 quick-reply buttons
 * @param {Array} buttons - [{ id: 'btn_1', title: 'Yes please' }]
 */
async function sendButtons(phoneNumberId, fbToken, to, bodyText, buttons, headerText = null, footerText = null) {
  return waRequest(phoneNumberId, fbToken, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      ...(headerText && { header: { type: 'text', text: headerText } }),
      body: { text: bodyText },
      ...(footerText && { footer: { text: footerText } }),
      action: {
        buttons: buttons.slice(0, 3).map(b => ({
          type: 'reply',
          reply: { id: b.id, title: b.title.slice(0, 20) } // WA limit: 20 chars
        }))
      }
    }
  });
}

/**
 * Send a list message (like a menu) with sections
 * @param {Array} sections - [{ title: 'Food', rows: [{ id, title, description }] }]
 */
async function sendList(phoneNumberId, fbToken, to, bodyText, buttonLabel, sections) {
  return waRequest(phoneNumberId, fbToken, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: {
        button: buttonLabel.slice(0, 20),
        sections: sections.map(s => ({
          title: s.title,
          rows: s.rows.map(r => ({
            id: r.id,
            title: r.title.slice(0, 24),
            description: (r.description || '').slice(0, 72)
          }))
        }))
      }
    }
  });
}

/**
 * Send a "typing…" indicator (appears for 25 seconds or until next message)
 */
async function sendTyping(phoneNumberId, fbToken, to) {
  return waRequest(phoneNumberId, fbToken, {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: to, // WA requires a message ID here; use "to" as fallback
  });
}

/**
 * Mark a message as read (shows double blue tick to customer)
 */
async function markRead(phoneNumberId, fbToken, messageId) {
  return waRequest(phoneNumberId, fbToken, {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
  });
}

/**
 * Core request function
 */
async function waRequest(phoneNumberId, fbToken, body) {
  try {
    const res = await axios.post(
      `${WA_BASE}/${phoneNumberId}/messages`,
      body,
      {
        headers: {
          Authorization: `Bearer ${fbToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return res.data;
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    throw new Error(`WhatsApp API error: ${msg}`);
  }
}

module.exports = { sendText, sendButtons, sendList, sendTyping, markRead };
