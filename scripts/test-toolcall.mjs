// Verify the new manual tool loop in /api/chat:
//
//   Test 1: User asks "list my files" → LLM should call list_synced_files
//           (server-execute) → return a final answer mentioning the file paths.
//
//   Test 2: User asks "summarize X" → LLM should call list_synced_files
//           then call read_synced_file(path), which has no server execute and
//           should be streamed back as a pending tool call (UI message stream
//           with tool-input-available event).
//
// Run:  node scripts/test-toolcall.mjs

const BASE = process.env.SYNAPSE_BASE ?? "http://localhost:3000";

const fakeIndex = [
  { path: "notes/quick-test.md", kind: "text", size: 124, mtime: Date.now() },
  { path: "notes/another-file.md", kind: "text", size: 80, mtime: Date.now() },
  { path: "papers/Smith2024.pdf", kind: "pdf", size: 412_000, mtime: Date.now() },
];

async function postChat(userText, opts = {}) {
  const body = {
    sessionKey: "test_toolcall",
    sessionId: `tc_${Date.now()}`,
    syncedFilesIndex: fakeIndex,
    messages: [
      { id: "m1", role: "user", parts: [{ type: "text", text: userText }] },
    ],
    ...opts,
  };
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return parseStream(res);
}

async function parseStream(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;
      try { events.push(JSON.parse(data)); } catch {}
    }
  }
  const text = events
    .filter((e) => e.type === "text-delta")
    .map((e) => e.delta)
    .join("");
  return { events, text };
}

let failed = 0;

// ──────────────────────────────────────
// Test 1: list files
// ──────────────────────────────────────
console.log("\n=== Test 1: 'what files do I have' → LLM should list them ===");
try {
  const { events, text } = await postChat("我连接的文件夹里有哪些文件？请列出来。");
  const finish = events.find((e) => e.type === "finish");
  console.log("text:", text);
  console.log("finishReason:", finish?.finishReason);
  const ok =
    finish?.finishReason === "stop" &&
    text.length > 0 &&
    /quick-test|another-file|Smith2024/.test(text);
  console.log(ok ? "✅ PASS" : "❌ FAIL");
  if (!ok) failed++;
} catch (e) {
  console.log("❌ FAIL:", e.message);
  failed++;
}

// ──────────────────────────────────────
// Test 2: summarize → LLM should call read_synced_file (pending client tool)
// ──────────────────────────────────────
console.log("\n=== Test 2: 'summarize quick-test.md' → expect pending read_synced_file ===");
try {
  const { events, text } = await postChat("请概括 notes/quick-test.md 这个文件的内容。");
  const finish = events.find((e) => e.type === "finish");
  const toolInput = events.find((e) => e.type === "tool-input-available");
  console.log("text:", text);
  console.log("finishReason:", finish?.finishReason);
  console.log("tool-input-available event:", toolInput ? JSON.stringify(toolInput) : "(none)");

  const ok =
    finish?.finishReason === "tool-calls" &&
    toolInput?.toolName === "read_synced_file" &&
    typeof toolInput?.input?.path === "string" &&
    toolInput.input.path.includes("quick-test");
  console.log(ok ? "✅ PASS" : "❌ FAIL");
  if (!ok) failed++;
} catch (e) {
  console.log("❌ FAIL:", e.message);
  failed++;
}

console.log(`\n${failed === 0 ? "✅ ALL PASS" : `❌ ${failed} FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
