const axios = require('axios');
const FormData = require('form-data');

/**
 * Voice Note Transcription Service
 *
 * Flow:
 * 1. WhatsApp sends a webhook with audio message + media_id
 * 2. We download the audio file from Meta's servers
 * 3. We transcribe it with Whisper (Groq = free, OpenAI = paid)
 * 4. The transcribed text is treated like a normal text message
 */

/**
 * Download audio from WhatsApp's media server
 * @param {string} mediaId  - from the webhook payload
 * @param {string} fbToken  - client's Facebook token
 * @returns {Buffer} - audio file buffer
 */
async function downloadWhatsAppMedia(mediaId, fbToken) {
  // Step 1: Get the media URL from Meta
  const metaRes = await axios.get(
    `https://graph.facebook.com/v18.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${fbToken}` } }
  );
  const mediaUrl = metaRes.data.url;

  // Step 2: Download the actual file
  const fileRes = await axios.get(mediaUrl, {
    headers: { Authorization: `Bearer ${fbToken}` },
    responseType: 'arraybuffer'
  });

  return {
    buffer: Buffer.from(fileRes.data),
    mimeType: fileRes.headers['content-type'] || 'audio/ogg'
  };
}

/**
 * Transcribe audio buffer using Groq Whisper (free tier)
 * Groq offers free Whisper transcription with 7,200 audio seconds/day
 */
async function transcribeWithGroq(audioBuffer, mimeType, apiKey) {
  const formData = new FormData();
  const ext = mimeType.includes('ogg') ? 'ogg' : 'mp3';
  formData.append('file', audioBuffer, { filename: `audio.${ext}`, contentType: mimeType });
  formData.append('model', 'whisper-large-v3');
  formData.append('response_format', 'text');
  // Auto-detect language (great for multilingual WhatsApp bots)
  // formData.append('language', 'en'); // uncomment to force English

  const res = await axios.post(
    'https://api.groq.com/openai/v1/audio/transcriptions',
    formData,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...formData.getHeaders()
      }
    }
  );
  return res.data; // plain text string
}

/**
 * Transcribe audio using OpenAI Whisper ($0.006 per minute)
 */
async function transcribeWithOpenAI(audioBuffer, mimeType, apiKey) {
  const formData = new FormData();
  const ext = mimeType.includes('ogg') ? 'ogg' : 'mp3';
  formData.append('file', audioBuffer, { filename: `audio.${ext}`, contentType: mimeType });
  formData.append('model', 'whisper-1');
  formData.append('response_format', 'text');

  const res = await axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    formData,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...formData.getHeaders()
      }
    }
  );
  return res.data;
}

/**
 * Main export: download + transcribe a WhatsApp voice note
 * @param {string} mediaId   - from webhook
 * @param {string} fbToken   - client's FB token
 * @param {Object} options   - { provider: 'groq'|'openai', apiKey: '...' }
 * @returns {string} transcribed text
 */
async function transcribeVoiceNote(mediaId, fbToken, options = {}) {
  const provider = options.provider || process.env.TRANSCRIPTION_PROVIDER || 'groq';
  const apiKey   = options.apiKey
    || (provider === 'groq' ? process.env.GROQ_API_KEY : process.env.OPENAI_API_KEY);

  if (!apiKey) {
    throw new Error(`No API key for transcription provider "${provider}"`);
  }

  // Download from WhatsApp
  const { buffer, mimeType } = await downloadWhatsAppMedia(mediaId, fbToken);

  // Transcribe
  let transcript;
  if (provider === 'groq') {
    transcript = await transcribeWithGroq(buffer, mimeType, apiKey);
  } else {
    transcript = await transcribeWithOpenAI(buffer, mimeType, apiKey);
  }

  return typeof transcript === 'string' ? transcript.trim() : transcript;
}

module.exports = { transcribeVoiceNote, downloadWhatsAppMedia };
