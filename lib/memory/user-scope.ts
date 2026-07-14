/**
 * Per-user data scoping helpers.
 *
 * Synapse's TencentDB pipeline was originally single-user (one global
 * `data/scene_blocks/` and `data/persona.md`). We namespace L2/L3 output
 * and Aha state under `data/users/<userId>/` so different signed-in users
 * see their own memories.
 *
 * L0/L1 (SQLite) are filtered by `session_key = chat_<userId>` instead —
 * see store.ts query helpers.
 */
import path from "node:path";
import fs from "node:fs";

const BASE_FALLBACK_USER = "_anon";
const SESSION_KEY_PREFIX = "chat_";

/** Root data directory (shared, contains memory.db + per-user subdirs). */
export function getBaseDataDir(): string {
  return process.env.TDAI_DATA_DIR ?? path.join(process.cwd(), "data");
}

/**
 * DEPRECATED — DO NOT USE.
 *
 * Parsing userId out of a sessionKey is ambiguous because userIds contain
 * underscores (e.g. `user_test_123qq`, `user_3272bfb9-...`) and child sessions
 * append `_<sessionId>` to make `chat_<userId>_<sessionId>`. There is no
 * unambiguous split.
 *
 * Always thread userId in from `getCurrentUserId()` instead. Kept here only
 * to fail loudly if any caller still relies on the old behavior.
 */
export function userIdFromSessionKey(_sessionKey: string | null | undefined): string {
  throw new Error(
    "userIdFromSessionKey is deprecated — parsing userId from sessionKey is " +
    "ambiguous (userIds contain underscores). Pass userId explicitly from " +
    "getCurrentUserId() in lib/auth-session.ts.",
  );
}

/** Build the chat session_key for a userId. */
export function sessionKeyForUser(userId: string): string {
  return `${SESSION_KEY_PREFIX}${userId}`;
}

/**
 * External-tool session keys: `chat_<userId>_ext_<source>_<project>`.
 *
 * source/project are slugged to [a-z0-9-] (underscores stripped) so the
 * `_ext_<source>_<project>` suffix parses unambiguously even though userIds
 * themselves contain underscores. `project` is optional — omitting it yields
 * the legacy two-level `chat_<userId>_ext_<source>` (kept for back-compat).
 */
function slug(s: string, max = 40): string {
  // Keep unicode letters/digits (so Chinese project names survive), turn
  // spaces/underscores into hyphens, drop everything else. NO underscores
  // remain, which keeps the `_ext_<source>_<project>` suffix unambiguous.
  return (s || "")
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "")
    .slice(0, max);
}

export function extSessionKeyForUser(userId: string, source: string, project?: string): string {
  const src = slug(source) || "mcp";
  const base = `${sessionKeyForUser(userId)}_ext_${src}`;
  const proj = project ? slug(project) : "";
  return proj ? `${base}_${proj}` : base;
}

/** Parse the `_ext_<source>_<project>` suffix. Returns null for non-ext keys. */
export function parseExtSessionKey(sessionKey: string): { source: string; project: string } | null {
  // source/project contain no underscores (slugged), so split on the last
  // `_ext_` then on the single project separator.
  const m = sessionKey.match(/_ext_([^_]+)(?:_([^_]+))?$/u);
  if (!m) return null;
  return { source: m[1], project: m[2] ?? "" };
}

/**
 * Per-user data directory. Creates the dir + the L2 scene_blocks/.metadata
 * subdirs on first use so callers don't need to mkdir themselves.
 */
export function getUserDataDir(userId: string | null | undefined): string {
  const safe = sanitizeUserId(userId);
  const dir = path.join(getBaseDataDir(), "users", safe);
  try {
    fs.mkdirSync(path.join(dir, "scene_blocks"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".metadata"), { recursive: true });
  } catch {
    // best-effort; downstream readers handle missing dirs
  }
  return dir;
}

/** Persona file path for a user. */
export function getUserPersonaPath(userId: string | null | undefined): string {
  return path.join(getUserDataDir(userId), "persona.md");
}

/** Scene blocks dir path for a user. */
export function getUserSceneBlocksDir(userId: string | null | undefined): string {
  return path.join(getUserDataDir(userId), "scene_blocks");
}

function sanitizeUserId(userId: string | null | undefined): string {
  if (!userId) return BASE_FALLBACK_USER;
  // user IDs come from NextAuth (random hex / Google subs). Strip anything
  // exotic so they're safe as a directory name.
  const cleaned = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned || BASE_FALLBACK_USER;
}
