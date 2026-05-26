// Verify the scheduler batches L1 instead of firing per-turn.
//
//   Tests:
//     1) Fresh session, 4 turns → /api/pipeline/flush after each turn 1..4
//        returns triggeredL1=true (pending count > 0). After turn 5 the
//        scheduler auto-fires and resets the counter; flush then is noop.
//     2) After auto-fire via threshold, flush returns triggeredL1=false.
//     3) On a fresh session, 2 turns → flush returns triggeredL1=true
//        (forceFlush bypasses the count threshold).
//
// We rely on the /api/pipeline/flush response shape rather than memory-count
// deltas because L1 may legitimately produce 0 new memories when the chats
// are generic test stubs the LLM filters out as low-value.
//
// Run:  node scripts/test-scheduler.mjs

const BASE = process.env.SYNAPSE_BASE ?? "http://localhost:3000";

async function postChat(sessionKey, userText) {
  const r = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionKey,
      sessionId: `sch_${Date.now()}`,
      messages: [{ id: `m${Date.now()}`, role: "user", parts: [{ type: "text", text: userText }] }],
    }),
  });
  // Drain stream to ensure onFinish (and thus scheduler.notifyTurn) runs.
  const reader = r.body.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

async function flush(sessionKey) {
  const r = await fetch(`${BASE}/api/pipeline/flush`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionKey }),
  });
  return r.json();
}

const SESSION_A = `sch_a_${Date.now()}`;
const SESSION_B = `sch_b_${Date.now()}`;
let pass = 0, fail = 0;

// ─────────────────────────────────────
// Test 1: 4 turns < threshold, scheduler does NOT auto-fire L1.
//         Flush at this point fires it (because pending > 0).
// ─────────────────────────────────────
console.log("\n=== Test 1: 4 turns < threshold(5), then flush fires L1 ===");
for (let i = 1; i <= 4; i++) {
  await postChat(SESSION_A, `第 ${i} 轮：简短回答即可。`);
  process.stdout.write(`turn ${i}... `);
}
console.log();
const r1 = await flush(SESSION_A);
console.log("flush after 4 turns:", JSON.stringify(r1));
if (r1.triggeredL1 === true) {
  console.log("✅ PASS — flush fired L1 (pending=4)");
  pass++;
} else {
  console.log("❌ FAIL — flush did NOT fire L1 after 4 pending turns");
  fail++;
}

// ─────────────────────────────────────
// Test 2: After flush, counter is reset → next flush is noop.
// ─────────────────────────────────────
console.log("\n=== Test 2: after flush, counter reset → noop ===");
const r2 = await flush(SESSION_A);
console.log("flush again:", JSON.stringify(r2));
if (r2.triggeredL1 === false) {
  console.log("✅ PASS — second flush noop");
  pass++;
} else {
  console.log("❌ FAIL — second flush fired L1 unexpectedly");
  fail++;
}

// ─────────────────────────────────────
// Test 3: Fire 5 turns on a fresh session — the 5th hits the threshold
//         and scheduler auto-fires. After that, flush is noop.
// ─────────────────────────────────────
console.log("\n=== Test 3: 5th turn auto-fires (no flush needed); flush after = noop ===");
for (let i = 1; i <= 5; i++) {
  await postChat(SESSION_B, `第 ${i} 轮：简短回答。`);
  process.stdout.write(`turn ${i}... `);
}
console.log();
// Give the fire-and-forget notifyTurn time to complete L1.
await new Promise((r) => setTimeout(r, 15_000));
const r3 = await flush(SESSION_B);
console.log("flush after 5 turns:", JSON.stringify(r3));
if (r3.triggeredL1 === false) {
  console.log("✅ PASS — scheduler auto-fired on turn 5, counter is reset");
  pass++;
} else {
  console.log("❌ FAIL — counter not reset; threshold didn't fire");
  fail++;
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`} (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
