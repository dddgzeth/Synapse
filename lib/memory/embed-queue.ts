/**
 * Fire-and-forget write-path embedding.
 *
 * insertL0 / upsertL1 stay synchronous (better-sqlite3); vectors are computed
 * off the critical path and upserted when ready. A failed embed just means
 * that row is vec-invisible until the backfill script sweeps it — FTS still
 * covers it, chat latency is never affected.
 *
 * In-process serial queue: node-llama-cpp's embedding context handles one
 * text at a time; serializing avoids contention without extra deps.
 */
import { embedText, vecToBuffer } from "./embedding";
import { upsertL0Embedding, upsertL1Embedding } from "./store";

let chain: Promise<void> = Promise.resolve();

function enqueue(job: () => Promise<void>): void {
  chain = chain.then(job).catch((err) => {
    console.error("[embed-queue] job failed:", err);
  });
}

export function queueEmbedL0(recordId: string, text: string): void {
  enqueue(async () => {
    const v = await embedText(text);
    if (v) upsertL0Embedding(recordId, vecToBuffer(v));
  });
}

export function queueEmbedL1(recordId: string, content: string): void {
  enqueue(async () => {
    const v = await embedText(content);
    if (v) upsertL1Embedding(recordId, vecToBuffer(v));
  });
}
