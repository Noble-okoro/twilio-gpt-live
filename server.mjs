import Fastify from "fastify";
import formbody from "@fastify/formbody";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import twilio from "twilio";

const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const RECORD_CALLS = process.env.RECORD_CALLS?.toLowerCase() === "true";

if (!OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is required");
}

const app = Fastify({ logger: true, trustProxy: true });
await app.register(formbody);
await app.register(websocket);

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

function publicHttpUrl(request, path = "") {
  if (PUBLIC_BASE_URL) {
    return `${PUBLIC_BASE_URL.replace(/\/$/, "")}${path}`;
  }

  const proto = request.headers["x-forwarded-proto"] || "https";
  const host = request.headers["x-forwarded-host"] || request.headers.host;
  return `${proto}://${host}${path}`;
}

function publicWebSocketUrl(request) {
  return publicHttpUrl(request, "/media-stream").replace(/^http/, "ws");
}

function validTwilioRequest(request) {
  if (!TWILIO_AUTH_TOKEN) {
    app.log.warn("TWILIO_AUTH_TOKEN is unset; Twilio request validation is disabled");
    return true;
  }

  const signature = request.headers["x-twilio-signature"];
  if (!signature) return false;

  return twilio.validateRequest(
    TWILIO_AUTH_TOKEN,
    signature,
    publicHttpUrl(request, request.url),
    request.body || {},
  );
}

app.get("/", async () => ({ status: "ok", service: "twilio-gpt-live-bridge" }));
app.get("/health", async () => ({ status: "ok" }));

app.post("/incoming-call", async (request, reply) => {
  if (!validTwilioRequest(request)) {
    return reply.code(403).send("Invalid Twilio signature");
  }

  const response = new twilio.twiml.VoiceResponse();

  if (RECORD_CALLS) {
    if (!twilioClient || !request.body?.CallSid) {
      request.log.error("Recording is enabled but Twilio credentials or CallSid are missing");
    } else {
      try {
        await twilioClient.calls(request.body.CallSid).recordings.create({
          recordingChannels: "dual",
          recordingTrack: "both",
        });
        const recordingNotice =
          process.env.RECORDING_NOTICE ||
          "This call may be recorded for quality and training. By continuing, you consent to the recording.";
        if (!["none", "off"].includes(recordingNotice.trim().toLowerCase())) {
          response.say(recordingNotice);
        }
      } catch (error) {
        request.log.error({ err: error }, "Could not start Twilio call recording");
      }
    }
  }

  const connect = response.connect();
  connect.stream({ url: publicWebSocketUrl(request) });

  reply.type("text/xml").send(response.toString());
});

app.get("/media-stream", { websocket: true }, (twilioSocket, request) => {
  let streamSid = null;
  let openaiStarted = false;
  let closing = false;
  const queuedAudio = [];
  const maxQueuedChunks = 500;

  const openaiSocket = new WebSocket("wss://api.openai.com/v1/live/sessions", {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
  });

  function sendOpenAI(event) {
    if (openaiSocket.readyState === WebSocket.OPEN) {
      openaiSocket.send(JSON.stringify(event));
    }
  }

  function sendTwilio(event) {
    if (twilioSocket.readyState === WebSocket.OPEN) {
      twilioSocket.send(JSON.stringify(event));
    }
  }

  function closeSession() {
    if (closing) return;
    closing = true;

    if (openaiStarted) {
      sendOpenAI({ type: "session.close" });
      setTimeout(() => openaiSocket.close(), 2_000).unref();
    } else {
      openaiSocket.close();
    }
  }

  openaiSocket.on("open", () => {
    sendOpenAI({
      type: "session.start",
      event_id: `start_${Date.now()}`,
      session: {
        model: "gpt-live-1",
        instructions:
          process.env.LIVE_INSTRUCTIONS ||
          "You are a friendly telephone assistant. Speak naturally and concisely. Ask one question at a time. Tell the caller when you need to check something.",
        audio: {
          format: { type: "audio/pcmu", rate: 8000 },
          output: { voice: process.env.OPENAI_VOICE || "marin" },
        },
        delegation: {
          type: "responses",
          responses: {
            model: process.env.BACKEND_MODEL || "gpt-6-luna",
            reasoning: {
              effort: process.env.BACKEND_REASONING_EFFORT || "medium",
            },
            instructions:
              process.env.BACKEND_INSTRUCTIONS ||
              "Answer accurately and briefly. Never claim an external action succeeded unless it is confirmed.",
          },
        },
      },
    });
  });

  openaiSocket.on("message", (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      request.log.warn("Received invalid JSON from OpenAI");
      return;
    }

    if (event.type === "session.started") {
      openaiStarted = true;
      request.log.info({ sessionId: event.session?.id }, "GPT-Live session started");

      while (queuedAudio.length) {
        sendOpenAI({ type: "session.input_audio.append", audio: queuedAudio.shift() });
      }

      sendOpenAI({
        type: "session.instructions.append",
        event_id: `greeting_${Date.now()}`,
        delegation_id: null,
        content:
          process.env.OPENING_GREETING_INSTRUCTIONS ||
          "Greet the person now in English. Introduce yourself as the assistant and ask how you can help. Then pause and listen.",
      });
      return;
    }

    if (event.type === "session.output_audio.delta" && streamSid && event.delta) {
      sendTwilio({
        event: "media",
        streamSid,
        media: { payload: event.delta },
      });
      return;
    }

    if (
      streamSid &&
      (event.type === "session.input_audio.speech_started" ||
        event.type === "input_audio_buffer.speech_started")
    ) {
      sendTwilio({ event: "clear", streamSid });
      return;
    }

    if (event.type === "error") {
      request.log.error({ error: event.error }, "OpenAI session error");
      return;
    }

    if (event.type === "session.closed") {
      request.log.info({ usage: event.usage }, "GPT-Live session closed");
      openaiSocket.close();
    }
  });

  openaiSocket.on("error", (error) => {
    request.log.error({ err: error }, "OpenAI WebSocket error");
    if (twilioSocket.readyState === WebSocket.OPEN) twilioSocket.close(1011);
  });

  openaiSocket.on("close", () => {
    if (twilioSocket.readyState === WebSocket.OPEN) twilioSocket.close();
  });

  twilioSocket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      request.log.warn("Received invalid JSON from Twilio");
      return;
    }

    if (message.event === "start") {
      streamSid = message.start?.streamSid || message.streamSid;
      request.log.info(
        { streamSid, callSid: message.start?.callSid },
        "Twilio media stream started",
      );
      return;
    }

    if (message.event === "media" && message.media?.payload) {
      if (openaiStarted) {
        sendOpenAI({
          type: "session.input_audio.append",
          audio: message.media.payload,
        });
      } else {
        if (queuedAudio.length >= maxQueuedChunks) queuedAudio.shift();
        queuedAudio.push(message.media.payload);
      }
      return;
    }

    if (message.event === "stop") {
      closeSession();
    }
  });

  twilioSocket.on("close", closeSession);
  twilioSocket.on("error", (error) => {
    request.log.error({ err: error }, "Twilio WebSocket error");
    closeSession();
  });
});

await app.listen({ port: PORT, host: "0.0.0.0" });
