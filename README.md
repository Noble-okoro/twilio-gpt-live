# Twilio GPT-Live bridge

This service connects a bidirectional Twilio Media Stream to OpenAI GPT-Live 1.
It passes G.711 mu-law audio through at 8 kHz without transcoding.

## Required environment variables

- `OPENAI_API_KEY`: OpenAI project API key with access to `gpt-live-1`.
- `PUBLIC_BASE_URL`: Public HTTPS origin of this service, without a trailing slash.
- `TWILIO_AUTH_TOKEN`: Twilio Auth Token used to verify Twilio's request signature.
- `TWILIO_ACCOUNT_SID`: Twilio account that owns the phone number. Required
  when optional call recording is enabled.

Optional variables are documented in `.env.example`.

`BACKEND_REASONING_EFFORT` accepts a reasoning level supported by the selected
backend model, such as `low`, `medium`, `high`, or `xhigh`.

`OPENING_GREETING_INSTRUCTIONS` controls the greeting GPT-Live speaks as soon
as a call connects. Keep the instruction short and tell the model to pause and
listen after greeting.

Set `RECORD_CALLS=true` to start a dual-channel Twilio recording for every call.
The service plays `RECORDING_NOTICE` before connecting the media stream. Recording
laws vary; configure an appropriate notice and consent flow for your callers.

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
