import { config } from "dotenv";
config({ path: ".env.local" });

const BASE = process.env.MIROMIND_BASE_URL;
const KEY = process.env.MIROMIND_API_KEY;
const MODEL = process.env.MIROMIND_MODEL;

// Reproduce what ai-sdk/openai sends for generateText (non-streaming)
const r = await fetch(`${BASE}/chat/completions`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${KEY}`,
  },
  body: JSON.stringify({
    model: MODEL,
    messages: [{ role: "user", content: "Say hi in 3 words" }],
    max_tokens: 100,
    stream: false,
  }),
});

console.log("HTTP:", r.status, "type:", r.headers.get("content-type"));
const text = await r.text();
console.log("len:", text.length);
console.log("first 500:", text.slice(0, 500));
console.log("last 300:", text.slice(-300));

// Try parsing
try {
  const obj = JSON.parse(text);
  console.log("\n--- parsed ---");
  console.log("keys:", Object.keys(obj));
  console.log("content:", obj.choices?.[0]?.message?.content);
  console.log("finish:", obj.choices?.[0]?.finish_reason);
} catch (e) {
  console.log("JSON parse err:", e.message);
}
