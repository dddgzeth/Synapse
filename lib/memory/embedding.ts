/**
 * Local embedding — bge-m3 GGUF via node-llama-cpp. No external API.
 *
 * Singleton per process (globalThis cache survives Next dev hot-reload, same
 * pattern as the better-sqlite3 handle). If the model file is missing or the
 * native backend fails to load, every call returns null and callers fall back
 * to FTS-only search — the feature degrades, never breaks chat.
 *
 * Measured on dev (M-series) and the 6-core EPYC server: load ~3s once,
 * then ~15–80ms per short text. bge-m3 is multilingual (zh/en cross-lingual
 * cosine ≈0.82 for same-meaning pairs), dim 1024.
 */
import path from "node:path";
import fs from "node:fs";

export const EMBEDDING_DIM = 1024;
// Truncate embed input — bge-m3 handles long ctx but recall units are short;
// 2000 chars covers L1 memories and the meat of L0 turns.
const MAX_EMBED_CHARS = 2000;

type EmbeddingCtx = {
  getEmbeddingFor(text: string): Promise<{ vector: readonly number[] }>;
};

type EmbState = {
  ctx: EmbeddingCtx | null;
  loading: Promise<EmbeddingCtx | null> | null;
  failed: boolean;
};

const g = globalThis as unknown as { __synapseEmb?: EmbState };
function state(): EmbState {
  if (!g.__synapseEmb) g.__synapseEmb = { ctx: null, loading: null, failed: false };
  return g.__synapseEmb;
}

export function embeddingModelPath(): string {
  return process.env.SYNAPSE_EMBED_MODEL
    ?? path.join(process.cwd(), "data", "models", "bge-m3-Q8_0.gguf");
}

export function isEmbeddingConfigured(): boolean {
  return fs.existsSync(embeddingModelPath());
}

async function loadCtx(): Promise<EmbeddingCtx | null> {
  const s = state();
  if (s.ctx) return s.ctx;
  if (s.failed) return null;
  if (s.loading) return s.loading;

  s.loading = (async () => {
    try {
      const modelPath = embeddingModelPath();
      if (!fs.existsSync(modelPath)) {
        console.warn(`[embedding] model not found at ${modelPath} — semantic search disabled`);
        s.failed = true;
        return null;
      }
      // Dynamic import: node-llama-cpp is ESM-only with a native backend;
      // importing lazily keeps it out of the Next bundle graph.
      const { getLlama } = await import("node-llama-cpp");
      const llama = await getLlama();
      const model = await llama.loadModel({ modelPath });
      const ctx = await model.createEmbeddingContext({ contextSize: 2048 });
      s.ctx = ctx as unknown as EmbeddingCtx;
      console.log("[embedding] bge-m3 loaded, semantic search active");
      return s.ctx;
    } catch (err) {
      console.error("[embedding] load failed — semantic search disabled:", err);
      s.failed = true;
      return null;
    } finally {
      s.loading = null;
    }
  })();
  return s.loading;
}

/** Strip Synapse-internal markers so they don't pollute the vector. */
function cleanForEmbedding(text: string): string {
  return text
    .replace(/\[img:(att_[A-Za-z0-9_]+\.[a-z0-9]+)\]/g, "")
    .replace(/\[img-desc\]/g, " ")
    .replace(/\[\/img-desc\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_EMBED_CHARS);
}

/**
 * Embed one text. Returns null when the model is unavailable or input is
 * empty — callers treat null as "FTS-only mode".
 */
export async function embedText(text: string): Promise<Float32Array | null> {
  const cleaned = cleanForEmbedding(text);
  if (!cleaned) return null;
  const ctx = await loadCtx();
  if (!ctx) return null;
  try {
    const e = await ctx.getEmbeddingFor(cleaned);
    return Float32Array.from(e.vector);
  } catch (err) {
    console.error("[embedding] embed failed:", err);
    return null;
  }
}

/** Float32Array → Buffer for sqlite-vec BLOB binding. */
export function vecToBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
