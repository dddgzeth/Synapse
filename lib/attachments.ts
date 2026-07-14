/**
 * Chat image attachments — persistence + retrieval.
 *
 * Pasted images used to live only in the browser's useChat state (data URLs),
 * so a page refresh dropped them: L0 only stored the text placeholder
 * "[附件：1 张图片]". Now the chat route saves each image under
 * `data/users/<userId>/attachments/` and records `[img:<name>]` markers in the
 * L0 message_text. The history route parses the markers back into file parts
 * pointing at /api/attachment/<name>, and the chat route inlines those back to
 * data URLs before calling the LLM so vision keeps working on old images.
 */
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { getUserDataDir } from "@/lib/memory/user-scope";

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** Matches persisted markers like `[img:att_1699999999_ab12cd34.png]`. */
export const IMG_MARKER_RE = /\[img:(att_[A-Za-z0-9_]+\.[a-z0-9]+)\]/g;

/**
 * Matches the vision-transcript block persisted alongside the markers:
 * `[img-desc]…[/img-desc]`. It lives in L0 so image content is FTS-searchable
 * and visible to the L1 pipeline, but must be stripped from any user-facing
 * rendering of the message text.
 */
export const IMG_DESC_RE = /\[img-desc\][\s\S]*?\[\/img-desc\]/g;

function attachmentsDir(userId: string): string {
  const dir = path.join(getUserDataDir(userId), "attachments");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Strict name check — also prevents path traversal. */
function isSafeName(name: string): boolean {
  return /^att_[A-Za-z0-9_]+\.[a-z0-9]+$/.test(name);
}

/** Persist a data-URL image; returns the attachment file name, or null. */
export function saveDataUrlAttachment(userId: string, dataUrl: string): string | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  const ext = EXT_BY_MIME[m[1]] ?? "bin";
  const name = `att_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.${ext}`;
  try {
    fs.writeFileSync(path.join(attachmentsDir(userId), name), Buffer.from(m[2], "base64"));
    return name;
  } catch (err) {
    console.error("[attachments] save failed:", err);
    return null;
  }
}

export function mimeForAttachment(name: string): string {
  const ext = name.split(".").pop() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** Read an attachment scoped to the user. Returns null if missing/invalid. */
export function readAttachment(userId: string, name: string): { buf: Buffer; mime: string } | null {
  if (!isSafeName(name)) return null;
  const p = path.join(attachmentsDir(userId), name);
  if (!fs.existsSync(p)) return null;
  try {
    return { buf: fs.readFileSync(p), mime: mimeForAttachment(name) };
  } catch {
    return null;
  }
}

/** Re-inline a stored attachment as a data URL (for LLM vision calls). */
export function attachmentToDataUrl(userId: string, name: string): string | null {
  const r = readAttachment(userId, name);
  return r ? `data:${r.mime};base64,${r.buf.toString("base64")}` : null;
}

/**
 * Vision transcript cache — one `.txt` next to each attachment.
 *
 * fucheers rejects requests that carry both images and `tools`, so the chat
 * route transcribes each image once (OCR + description) and feeds the tool
 * loop the transcript text instead of the image. The `.txt` suffix makes the
 * transcript unreachable via /api/attachment (isSafeName only allows a single
 * extension segment).
 */
export function saveAttachmentDescription(userId: string, name: string, desc: string): void {
  if (!isSafeName(name)) return;
  try {
    fs.writeFileSync(path.join(attachmentsDir(userId), `${name}.txt`), desc, "utf8");
  } catch (err) {
    console.error("[attachments] description save failed:", err);
  }
}

export function readAttachmentDescription(userId: string, name: string): string | null {
  if (!isSafeName(name)) return null;
  const p = path.join(attachmentsDir(userId), `${name}.txt`);
  try {
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  } catch {
    return null;
  }
}

/**
 * Content-hash index: dataUrl → attachment name.
 *
 * Same-session messages kept in the browser's chat state still carry their
 * original data URLs (not /api/attachment paths), so on follow-up turns the
 * chat route can't match them to a stored attachment by URL. Hashing the data
 * URL bridges that: saved once at upload, looked up on later turns to reuse
 * the cached transcript instead of degrading to a placeholder.
 */
function hashDataUrl(dataUrl: string): string {
  return crypto.createHash("sha256").update(dataUrl).digest("hex").slice(0, 32);
}

export function saveAttachmentHashIndex(userId: string, dataUrl: string, name: string): void {
  if (!isSafeName(name)) return;
  try {
    fs.writeFileSync(path.join(attachmentsDir(userId), `hash_${hashDataUrl(dataUrl)}.idx`), name, "utf8");
  } catch {
    // index is best-effort
  }
}

export function findAttachmentByDataUrl(userId: string, dataUrl: string): string | null {
  const p = path.join(attachmentsDir(userId), `hash_${hashDataUrl(dataUrl)}.idx`);
  try {
    if (!fs.existsSync(p)) return null;
    const name = fs.readFileSync(p, "utf8").trim();
    return isSafeName(name) ? name : null;
  } catch {
    return null;
  }
}
