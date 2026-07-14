/**
 * Personal Access Tokens for the MCP endpoint (and future external APIs).
 *
 * Web login is NextAuth cookies; terminal clients (Claude Code / Codex /
 * Cursor) can't carry those, so they present `Authorization: Bearer syn_…`
 * instead. Plaintext is shown exactly once at creation; only sha256 hashes
 * are stored, so a DB leak doesn't leak usable tokens.
 */
import crypto from "node:crypto";
import { getDb } from "./memory/store";

const PREFIX = "syn_";

function hash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Create a token for a user. Returns the PLAINTEXT — display once, never again. */
export function createToken(userId: string, label = ""): string {
  const token = PREFIX + crypto.randomBytes(32).toString("hex");
  getDb().prepare(`
    INSERT INTO api_tokens (token_hash, user_id, label, created_at)
    VALUES (?, ?, ?, ?)
  `).run(hash(token), userId, label, new Date().toISOString());
  return token;
}

/** Bearer string → userId, or null. Touches last_used_at on success. */
export function verifyToken(bearer: string | null | undefined): string | null {
  if (!bearer || !bearer.startsWith(PREFIX)) return null;
  const row = getDb().prepare(
    "SELECT user_id FROM api_tokens WHERE token_hash = ?",
  ).get(hash(bearer)) as { user_id: string } | undefined;
  if (!row) return null;
  getDb().prepare("UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?")
    .run(new Date().toISOString(), hash(bearer));
  return row.user_id;
}

export function revokeToken(userId: string, tokenHash: string): boolean {
  const res = getDb().prepare(
    "DELETE FROM api_tokens WHERE token_hash = ? AND user_id = ?",
  ).run(tokenHash, userId);
  return res.changes > 0;
}

export function listTokens(userId: string): Array<{ tokenHash: string; label: string; createdAt: string; lastUsedAt: string | null }> {
  return (getDb().prepare(`
    SELECT token_hash, label, created_at, last_used_at
    FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC
  `).all(userId) as any[]).map((r) => ({
    tokenHash: r.token_hash,
    label: r.label,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at ?? null,
  }));
}

// ── Naive per-token rate limit (sliding window, in-memory) ──
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 60;
const hits = new Map<string, number[]>();

/** true = allowed. Keyed by userId so multiple tokens share one budget. */
export function rateLimitOk(key: string): boolean {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX_PER_WINDOW) {
    hits.set(key, arr);
    return false;
  }
  arr.push(now);
  hits.set(key, arr);
  return true;
}
