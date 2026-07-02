const axios = require('axios');

/**
 * AI Service — routes to the right AI provider based on client config.
 * Add a new provider by adding a case to PROVIDERS below.
 */

// Default models for each provider (cheapest/fastest tier)
const DEFAULT_MODELS = {
  gemini:  'gemini-1.5-flash',      // Free: 15 req/min, 1M tokens/day
  groq:    'llama3-70b-8192',       // Free: 14,400 req/day, very fast
  mistral: 'mistral-small-latest',  // Free tier available
  openai:  'gpt-4o-mini',           // Paid but cheapest GPT-4 class
  claude:  'claude-haiku-4-5-20251001', // Paid but cheapest Claude
  cohere:  'command-r',             // Free: 1000 req/month
};

/**
 * Main entry point.
 * @param {Array}  messages   - [{role:'user'|'assistant', content:'...'}]
 * @param {string} systemPrompt
 * @param {Object} clientConfig - { aiProvider, aiModel, aiApiKey, maxTokens }
 * @returns {Promise<string>} - AI reply text
 */
async function getAIReply(messages, systemPrompt, clientConfig = {}) {
  const provider = resolveProvider(clientConfig.aiProvider);
  const model    = clientConfig.aiModel || DEFAULT_MODELS[provider];
  const apiKey   = clientConfig.aiApiKey || getGlobalKey(provider);
  const maxTokens = clientConfig.maxTokens || 500;

  if (!apiKey) {
    throw new Error(`No API key for provider "${provider}". Set it in .env or client config.`);
  }

  const start = Date.now();

  let reply;
  switch (provider) {
    case 'gemini':  reply = await callGemini(messages, systemPrompt, model, apiKey, maxTokens); break;
    case 'groq':    reply = await callGroq(messages, systemPrompt, model, apiKey, maxTokens); break;
    case 'mistral': reply = await callMistral(messages, systemPrompt, model, apiKey, maxTokens); break;
    case 'openai':  reply = await callOpenAI(messages, systemPrompt, model, apiKey, maxTokens); break;
    case 'claude':  reply = await callClaude(messages, systemPrompt, model, apiKey, maxTokens); break;
    case 'cohere':  reply = await callCohere(messages, systemPrompt, model, apiKey, maxTokens); break;
    default: throw new Error(`Unknown AI provider: ${provider}`);
  }

  return { reply, provider, model, latencyMs: Date.now() - start };
}

function resolveProvider(clientProvider) {
  if (!clientProvider || clientProvider === 'global') {
    return process.env.DEFAULT_AI_PROVIDER || 'gemini';
  }
  return clientProvider;
}

function getGlobalKey(provider) {
  const keys = {
    gemini:  process.env.GEMINI_API_KEY,
    groq:    process.env.GROQ_API_KEY,
    mistral: process.env.MISTRAL_API_KEY,
    openai:  process.env.OPENAI_API_KEY,
    claude:  process.env.ANTHROPIC_API_KEY,
    cohere:  process.env.COHERE_API_KEY,
  };
  return keys[provider];
}

// ── Provider implementations ────────────────────────────────────────────────

async function callGemini(messages, systemPrompt, model, apiKey, maxTokens) {
  // Convert OpenAI-style messages to Gemini format
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      contents,
      systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 }
    }
  );
  return res.data.candidates[0].content.parts[0].text;
}

async function callGroq(messages, systemPrompt, model, apiKey, maxTokens) {
  const msgs = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;

  const res = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    { model, messages: msgs, max_tokens: maxTokens, temperature: 0.7 },
    { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }
  );
  return res.data.choices[0].message.content;
}

async function callMistral(messages, systemPrompt, model, apiKey, maxTokens) {
  const msgs = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;

  const res = await axios.post(
    'https://api.mistral.ai/v1/chat/completions',
    { model, messages: msgs, max_tokens: maxTokens },
    { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }
  );
  return res.data.choices[0].message.content;
}

async function callOpenAI(messages, systemPrompt, model, apiKey, maxTokens) {
  const msgs = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;

  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    { model, messages: msgs, max_tokens: maxTokens },
    { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }
  );
  return res.data.choices[0].message.content;
}

async function callClaude(messages, systemPrompt, model, apiKey, maxTokens) {
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
    },
    {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      }
    }
  );
  return res.data.content[0].text;
}

async function callCohere(messages, systemPrompt, model, apiKey, maxTokens) {
  // Cohere uses chat_history format
  const chatHistory = messages.slice(0, -1).map(m => ({
    role: m.role === 'assistant' ? 'CHATBOT' : 'USER',
    message: m.content
  }));
  const lastMessage = messages[messages.length - 1].content;

  const res = await axios.post(
    'https://api.cohere.com/v1/chat',
    {
      model,
      message: lastMessage,
      chat_history: chatHistory,
      preamble: systemPrompt,
      max_tokens: maxTokens,
    },
    { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }
  );
  return res.data.text;
}

/**
 * Vision reply — used when a customer sends an image.
 * Supports Gemini (native vision) and OpenAI (gpt-4o-mini vision).
 * Falls back to a text-only "describe" prompt for providers without vision support.
 */
async function getVisionReply(imageBase64, mimeType, caption, systemPrompt, clientConfig = {}) {
  const provider = resolveProvider(clientConfig.aiProvider);
  const apiKey   = clientConfig.aiApiKey || getGlobalKey(provider);
  const maxTokens = clientConfig.maxTokens || 500;

  if (!apiKey) throw new Error(`No API key for provider "${provider}"`);

  const start = Date.now();
  const prompt = caption || 'The customer sent this image. Respond helpfully based on what you see.';

  let reply, model;
  if (provider === 'gemini') {
    model = clientConfig.aiModel || DEFAULT_MODELS.gemini;
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data: imageBase64 } }
          ]
        }],
        systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 }
      }
    );
    reply = res.data.candidates[0].content.parts[0].text;
  } else if (provider === 'openai') {
    model = clientConfig.aiModel || 'gpt-4o-mini';
    const msgs = [
      ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
        ]
      }
    ];
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      { model, messages: msgs, max_tokens: maxTokens },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }
    );
    reply = res.data.choices[0].message.content;
  } else {
    // Provider has no vision support in this integration — degrade gracefully
    throw new Error(`Provider "${provider}" doesn't support image understanding. Switch this client to Gemini or OpenAI for image support.`);
  }

  return { reply, provider, model, latencyMs: Date.now() - start };
}

module.exports = { getAIReply, getVisionReply };
