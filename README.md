# Twilio GPT-Live bridge

This service connects a bidirectional Twilio Media Stream to OpenAI GPT-Live 1.
It passes G.711 mu-law audio through at 8 kHz without transcoding.

## Required environment variables

- `OPENAI_API_KEY`: OpenAI project API key with access to `gpt-live-1`.
- `PUBLIC_BASE_URL`: Public HTTPS origin of this service, without a trailing slash.
- `TWILIO_AUTH_TOKEN`: Twilio Auth Token used to verify Twilio's request signature.

Optional variables are documented in `.env.example`.

## Deploy

Deploy this directory as a persistent web service on Railway or Render. Vercel
serverless functions are not suitable because phone calls require long-lived
WebSocket connections.

Use Node.js 22.6 or later. The start command is:

```text
npm start
```

After deployment, set `PUBLIC_BASE_URL` to the service's public HTTPS origin and
redeploy.

## Twilio configuration

Configure the Twilio phone number's incoming voice webhook as:

```text
POST https://YOUR_SERVICE_DOMAIN/incoming-call
```

Twilio will fetch TwiML from that endpoint and open a bidirectional WebSocket at
`wss://YOUR_SERVICE_DOMAIN/media-stream`.

## Health check

```text
GET /health
```

Expected response:

```json
{"status":"ok"}
```

## Security notes

- Never commit API keys or the Twilio Auth Token.
- Set all secrets through the deployment platform's environment-variable UI.
- Keep `TWILIO_AUTH_TOKEN` configured so incoming webhook signatures are checked.
