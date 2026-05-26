// Test streamText against fucheers.top to figure out why it returns empty.
import { config } from "dotenv";
config({ path: ".env.local" });

import { streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";

const BASE_URL = process.env.ANTHROPIC_BASE_URL;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

console.log("BASE:", BASE_URL, "MODEL:", MODEL, "KEY len:", API_KEY?.length);

async function testOpenAI() {
  console.log("\n--- TEST 1: @ai-sdk/openai (createOpenAI().chat) ---");
  const provider = createOpenAI({
    baseURL: BASE_URL + "/v1",
    apiKey: API_KEY,
  });
  try {
    const result = await streamText({
      model: provider.chat(MODEL),
      prompt: "say hi in 3 words",
      maxOutputTokens: 30,
    });
    let text = "";
    for await (const chunk of result.textStream) {
      text += chunk;
      process.stdout.write(chunk);
    }
    console.log("\nfinal text:", JSON.stringify(text));
    console.log("finishReason:", await result.finishReason);
  } catch (e) {
    console.error("ERR:", e.message);
  }
}

async function testCompatible() {
  console.log("\n--- TEST 2: @ai-sdk/openai-compatible ---");
  const provider = createOpenAICompatible({
    name: "fucheers",
    baseURL: BASE_URL + "/v1",
    apiKey: API_KEY,
  });
  try {
    const result = await streamText({
      model: provider.chatModel(MODEL),
      prompt: "say hi in 3 words",
      maxOutputTokens: 30,
    });
    let text = "";
    for await (const chunk of result.textStream) {
      text += chunk;
      process.stdout.write(chunk);
    }
    console.log("\nfinal text:", JSON.stringify(text));
    console.log("finishReason:", await result.finishReason);
  } catch (e) {
    console.error("ERR:", e.message);
  }
}

async function testAnthropic() {
  console.log("\n--- TEST 3: @ai-sdk/anthropic ---");
  const provider = createAnthropic({
    baseURL: BASE_URL + "/v1",
    apiKey: API_KEY,
  });
  try {
    const result = await streamText({
      model: provider(MODEL),
      prompt: "say hi in 3 words",
      maxOutputTokens: 30,
    });
    let text = "";
    for await (const chunk of result.textStream) {
      text += chunk;
      process.stdout.write(chunk);
    }
    console.log("\nfinal text:", JSON.stringify(text));
    console.log("finishReason:", await result.finishReason);
  } catch (e) {
    console.error("ERR:", e.message);
  }
}

await testOpenAI();
await testCompatible();
await testAnthropic();
