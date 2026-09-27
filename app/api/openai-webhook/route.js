import OpenAI from "openai";

export const runtime = "nodejs";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  webhookSecret: process.env.OPENAI_WEBHOOK_SECRET,
});

export async function POST(request) {
  const rawBody = await request.text();

  let event;

  try {
    event = openai.webhooks.unwrap(rawBody, request.headers);
  } catch (error) {
    console.error("Invalid webhook signature", error);
    return new Response("Invalid signature", { status: 400 });
  }

  if (event.type !== "live.transport.incoming") {
    return new Response("Ignored", { status: 200 });
  }

  const sessionId = event.data?.session_id;

  if (!sessionId) {
    return new Response("Missing session ID", { status: 400 });
  }

  const response = await fetch(
    `https://api.openai.com/v1/live/sessions/${sessionId}/accept`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session: {
          type: "live",
          model: "gpt-live-1",
          instructions:
            "You are a friendly telephone assistant. Speak naturally, keep responses concise, and ask one question at a time.",
          audio: {
            output: {
              voice: "marin",
            },
          },
          delegation: {
            type: "responses",
            responses: {
              model: "gpt-6-luna",
              instructions:
                "Answer the caller accurately and concisely. Do not claim an action succeeded unless it is confirmed.",
            },
          },
        },
      }),
    }
  );

  if (!response.ok) {
    const details = await response.text();
    console.error("Call acceptance failed", response.status, details);

    if (details.includes("decision_already_made")) {
      return new Response("Already handled", { status: 200 });
    }

    return new Response("Call acceptance failed", { status: 500 });
  }

  return new Response("Call accepted", { status: 200 });
}
