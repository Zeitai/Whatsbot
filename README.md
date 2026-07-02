# WhatsBOT — WhatsApp AI SaaS

Multi-tenant WhatsApp chatbot platform. One backend, many clients, each with their own
WhatsApp number, AI provider, and system prompt. Includes an admin dashboard to manage
clients, watch live conversations, take over from the AI, and view analytics.

## What's in here

```
server.js              # entry point — starts Express, connects Mongo, mounts routes
package.json
.env.example            # copy to .env and fill in
models/
  Client.js              # per-client config (WhatsApp creds, AI provider, features)
  Conversation.js         # per-customer message history
routes/
  webhook.js             # Meta webhook verify + incoming message receiver (per client slug)
  admin.js               # dashboard REST API (auth, clients CRUD, conversations, analytics)
services/
  whatsappService.js      # send text/buttons/lists via WhatsApp Cloud API
  transcriptionService.js # voice note → text (Groq or OpenAI Whisper)
  aiService.js             # routes to Gemini/Groq/Mistral/OpenAI/Claude/Cohere + vision
  messageProcessor.js       # the brain — handles every incoming message end to end
utils/
  logger.js
public/
  index.html              # the admin dashboard (served at http://localhost:3000)
```

## 1. Install

```bash
npm install
cp .env.example .env
```

Edit `.env`:
- `MONGODB_URI` — get a free MongoDB Atlas cluster at mongodb.com/atlas (M0 tier, 512MB free forever)
- `JWT_SECRET` — any long random string
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` — your login for the dashboard
- `DEFAULT_AI_PROVIDER` + at least one API key (Gemini's free tier is the easiest to start with — get a key at aistudio.google.com)
- Everything else can stay as-is for local testing.

## 2. Run it

```bash
npm run dev      # with auto-reload (nodemon)
# or
npm start
```

Open **http://localhost:3000** — you'll get a login screen using your `ADMIN_EMAIL`/`ADMIN_PASSWORD`
from `.env`. From there:

1. **Add a client** (top right "Add Client") — just a name to start, you can add the WhatsApp
   token later.
2. **Connect WhatsApp** — in [Meta Business Suite](https://business.facebook.com), create a WhatsApp
   app, get a temporary access token + Phone Number ID, and paste them into the client's edit
   panel (Clients page → click the client).
3. **Set the webhook** — Meta needs a public HTTPS URL, so you'll need to deploy first (see below)
   or use a tunnel like `ngrok http 3000` for local testing. Webhook URL is shown per-client on
   the **Webhooks** page: `https://yourdomain.com/webhook/{client-slug}`. Use the Verify Token
   shown there too.
4. Send a WhatsApp message to that number — it'll flow through `webhook.js` →
   `messageProcessor.js` → your chosen AI → back to the customer, and you'll see it live on the
   **Conversations** page.

## 3. Deploy (free tier)

Railway, Render, or Fly.io all work — push this repo, set the same env vars from `.env` in
their dashboard, and point Meta's webhook at the deployed URL instead of localhost.

## Notes on what's real vs. what's a placeholder

- **Fully working**: multi-provider AI routing, voice transcription, image understanding
  (Gemini/OpenAI vision), webhook handling, per-client config, escalation detection, the full
  admin API, and a dashboard wired to all of it (login, clients CRUD, live conversations,
  human-override replies, analytics).
- **Not built** (mockup only, since there's no backend for it): the **Billing** page. It's
  informational/manual — you track client payments and update their tokens yourself; there's
  no Stripe integration.
- **Image messages**: handled via Gemini or OpenAI vision. If a client's AI provider is Groq/
  Mistral/Claude/Cohere, image messages will get a polite fallback message since those aren't
  wired for vision here — switch that client to Gemini or OpenAI if image support matters to
  them.
