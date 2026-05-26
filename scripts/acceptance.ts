// End-to-end acceptance tests for Synapse.
// Drives the real API + dev server. Run with `npm run acceptance`.
//
// Tests:
//   1. /api/chat — streaming reply, L0 write
//   2. /api/memories — sidebar payload (l0Count, l1Count, persona, scenes)
//   3. /api/search — FTS over L1
//   4. /api/upload — file ingestion to L0
//   5. L1 pipeline — accumulate ≥5 turns and verify L1 records appear
//   6. /api/insight — Deep Research with miromind tool calls
//
// All output is appended to acceptance.log + stdout.

import fs from "node:fs";
import path from "node:path";

const BASE = process.env.SYNAPSE_BASE ?? "http://localhost:3000";
const LOG = path.join(process.cwd(), "acceptance.log");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function log(s: string) {
  console.log(s);
  fs.appendFileSync(LOG, s + "\n");
}

async function step(name: string, fn: () => Promise<void>) {
  log(`\n──── ${name} ────`);
  const t0 = Date.now();
  try {
    await fn();
    const dt = Date.now() - t0;
    log(`✅ PASS (${dt}ms) — ${name}`);
    passed++;
  } catch (e: any) {
    const dt = Date.now() - t0;
    log(`❌ FAIL (${dt}ms) — ${name}\n   ${e?.stack ?? e?.message ?? e}`);
    failed++;
    failures.push(name);
  }
}

function assert(cond: any, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function readSSE(res: Response): Promise<{ events: any[]; text: string }> {
  const events: any[] = [];
  let text = "";
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;
      try {
        const obj = JSON.parse(data);
        events.push(obj);
        if (obj.type === "text-delta" && obj.delta) text += obj.delta;
      } catch {
        // ignore
      }
    }
  }
  return { events, text };
}

const SESSION_KEY = `acceptance_${Date.now()}`;
const SESSION_ID = `sess_${Date.now()}`;

async function postChat(userText: string): Promise<{ text: string; events: any[] }> {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      messages: [{ role: "user", parts: [{ type: "text", text: userText }] }],
    }),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  return await readSSE(res);
}

async function main() {
  fs.writeFileSync(LOG, `# Synapse Acceptance Run — ${new Date().toISOString()}\n`);
  log(`Base: ${BASE}\nSession: ${SESSION_KEY}`);

  // 1. Health
  await step("01 server is up", async () => {
    const res = await fetch(BASE);
    assert(res.ok, `home page returned ${res.status}`);
  });

  // 2. Chat — basic reply with text-delta events
  await step("02 chat returns streaming reply", async () => {
    const { text, events } = await postChat("用中文一句话告诉我：水的化学式是什么？");
    log(`   reply: "${text}"`);
    const hasStart = events.some((e) => e.type === "start");
    const hasDelta = events.some((e) => e.type === "text-delta");
    const hasFinish = events.some((e) => e.type === "finish");
    assert(hasStart && hasDelta && hasFinish, `missing events: start=${hasStart} delta=${hasDelta} finish=${hasFinish}`);
    assert(text.length > 0, "reply text empty");
    assert(text.includes("H") || text.includes("水") || text.includes("2"), "reply doesn't mention water/H2O");
  });

  // 3. Memories endpoint shape
  let l0CountAfterChat = 0;
  await step("03 /api/memories returns proper shape", async () => {
    const res = await fetch(`${BASE}/api/memories`);
    const j = await res.json();
    log(`   l0Count=${j.l0Count} l1Count=${j.l1Count} scenes=${j.scenes?.length} recent=${j.recentMemories?.length}`);
    assert(typeof j.l0Count === "number", "l0Count missing");
    assert(typeof j.l1Count === "number", "l1Count missing");
    assert(Array.isArray(j.scenes), "scenes missing");
    assert(Array.isArray(j.recentMemories), "recentMemories missing");
    assert(j.l0Count >= 2, `expected at least 2 L0 records after chat, got ${j.l0Count}`);
    l0CountAfterChat = j.l0Count;
  });

  // 4. (formerly /api/upload — route removed; files now enter L0 only via chat)
  log("\n──── 04 /api/upload removed (files now enter L0 via chat attachment only) — SKIPPED ────");

  // 5. Drive L1 pipeline: send 5 substantive turns so it fires
  await step("05 drive 5 chat turns to trigger L1 pipeline", async () => {
    const turns = [
      "我正在研究 FAIR data infrastructure 中的催化剂溯源问题。当前 ELN 系统都没有标准化的 catalyst provenance 字段。",
      "我们的方法是扩展 Chemotion 的 schema，引入 PROV-O 本体来追溯催化剂来源。",
      "实验观察：在过去 8 周内，我在 3 篇不同的论文中都看到了相同的 catalyst provenance gap。",
      "数据集方面，我们打算用 RSC 上 2020-2024 年的催化反应数据做评估。",
      "目标是在 2026 年底前发表一篇关于 FAIR catalyst data layer 的论文。",
    ];
    for (let i = 0; i < turns.length; i++) {
      const { text } = await postChat(turns[i]);
      log(`   turn ${i + 1}: "${text.slice(0, 60)}..."`);
      assert(text.length > 0, `turn ${i + 1} produced empty reply`);
    }
  });

  // 6. Wait for L1 pipeline (background) and verify L1 records appear
  await step("06 L1 pipeline writes records within 60s", async () => {
    const deadline = Date.now() + 60_000;
    let l1Count = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const res = await fetch(`${BASE}/api/memories`);
      const j = await res.json();
      l1Count = j.l1Count;
      log(`   poll: l1Count=${l1Count} scenes=${j.scenes?.length}`);
      if (l1Count > 0) break;
    }
    assert(l1Count > 0, `no L1 records after 60s (l1Count=${l1Count})`);
  });

  // 7. Search L1 — strict: must return hits for both Chinese trigram + English
  await step("07 /api/search returns L1 hits (Chinese + English)", async () => {
    const r1 = await fetch(`${BASE}/api/search?q=${encodeURIComponent("催化剂")}`);
    const j1 = await r1.json();
    log(`   "催化剂" hits: ${j1.results?.length ?? 0}`);
    if (j1.results?.[0]) log(`     first: "${j1.results[0].content.slice(0, 70)}..."`);
    assert(Array.isArray(j1.results), "Chinese: results not array");
    assert(j1.results.length > 0, "Chinese search returned 0 hits");

    const r2 = await fetch(`${BASE}/api/search?q=${encodeURIComponent("Chemotion")}`);
    const j2 = await r2.json();
    log(`   "Chemotion" hits: ${j2.results?.length ?? 0}`);
    assert(j2.results.length > 0, "English search returned 0 hits");
  });

  // 7b. Vision: chat with image attachment (proxy needs Anthropic-style blocks)
  await step("07b chat accepts image attachment (vision)", async () => {
    const PNG = await import("node:zlib");
    const w = 8, h = 8;
    const raw = Buffer.alloc(h * (1 + w * 3));
    for (let y = 0; y < h; y++) {
      raw[y * (1 + w * 3)] = 0;
      for (let x = 0; x < w; x++) {
        const o = y * (1 + w * 3) + 1 + x * 3;
        raw[o] = 255; raw[o + 1] = 0; raw[o + 2] = 0;
      }
    }
    const idat = PNG.deflateSync(raw);
    const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; };
    const chunk = (type: string, data: Buffer) => {
      const t = Buffer.from(type, "ascii");
      const td = Buffer.concat([t, data]);
      let c = -1;
      for (let i = 0; i < td.length; i++) {
        c = c ^ td[i];
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
      }
      c = (c ^ -1) >>> 0;
      return Buffer.concat([u32(data.length), t, data, u32(c)]);
    };
    const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const ihdr = Buffer.concat([u32(w), u32(h), Buffer.from([8, 2, 0, 0, 0])]);
    const png = Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
    const dataUrl = `data:image/png;base64,${png.toString("base64")}`;

    const res = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionKey: `${SESSION_KEY}_vision`,
        sessionId: `${SESSION_ID}_vision`,
        messages: [{
          role: "user",
          parts: [
            // Terse prompt — verbose prompts on a tiny image trigger the model
            // to reply "no image" even when vision is wired correctly.
            { type: "text", text: "what color? one word" },
            { type: "file", mediaType: "image/png", url: dataUrl },
          ],
        }],
      }),
    });
    const { text } = await readSSE(res);
    log(`   vision reply: "${text}"`);
    assert(text.length > 0, "empty vision reply");
    assert(
      !/don't see|no image|没有.*图|未见图|cannot see/i.test(text),
      `model claims no image: "${text}"`,
    );
    assert(
      /red|green|blue|orange|yellow|black|white|gray|grey|红|绿|蓝/i.test(text),
      `model didn't identify a color: "${text}"`,
    );
  });

  // 8. Insight (Deep Research) — best-effort, miromind may be slow
  if (process.env.SKIP_INSIGHT === "1") {
    log("\n──── 08 deep research (SKIPPED via SKIP_INSIGHT=1) ────");
  } else {
    await step("08 /api/insight returns deep research result", async () => {
      // Use a fresh session so deep research doesn't pull in heavy catalyst context
      const res = await fetch(`${BASE}/api/insight`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "What is the FAIR data movement? Give a short summary.",
          sessionKey: `${SESSION_KEY}_insight`,
          sessionId: `${SESSION_ID}_insight`,
        }),
        signal: AbortSignal.timeout(260_000),
      });
      const j = await res.json();
      log(`   insight response: ${JSON.stringify(j).slice(0, 200)}...`);
      if (j.error) throw new Error(`insight returned error: ${j.error}`);
      assert(typeof j.result === "string", "result not a string");
      assert(j.result.length > 0, "insight result empty");
    });
  }

  // Summary
  log(`\n${"═".repeat(60)}\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    log("Failed:");
    for (const f of failures) log(`  - ${f}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  log(`\n💥 RUNNER CRASHED: ${e?.stack ?? e}`);
  process.exit(2);
});
