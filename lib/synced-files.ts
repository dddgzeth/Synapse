/**
 * Synced-files index & content reader (browser-side).
 *
 * Architectural contract:
 *   - collectSyncedFilesIndex() returns ONLY metadata (path/kind/size/mtime).
 *     This is what travels in the chat HTTP body. ~50-100 bytes per file.
 *   - readSyncedFileContent(path) reads + parses ONE file on demand. Result
 *     goes into the AI SDK tool-call result, which transits our server in
 *     memory on its way to the LLM. The server NEVER stores it.
 *   - Parsed PDF text is cached in IndexedDB keyed by (path, lastModified)
 *     so re-opens are instant.
 *
 * Browser-only; caller must guard against SSR.
 */

import type { FolderTreeNode } from "./synced-files-types";
import { getCachedPdfText, putCachedPdfText } from "./synced-files-cache";

export interface SyncedFileEntry {
  path: string;          // e.g. "ELN/Murray-Rust 1999.pdf"
  kind: "text" | "pdf" | "unsupported";
  size: number;          // bytes (from file.size)
  mtime: number;         // epoch ms (from file.lastModified)
}

const TEXT_EXTS = [".txt", ".md", ".tex", ".rst", ".csv", ".json", ".yaml", ".yml"];

function classifyKind(name: string): SyncedFileEntry["kind"] {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (TEXT_EXTS.some((e) => lower.endsWith(e))) return "text";
  return "unsupported";
}

/**
 * Walk a tree of FolderTreeNode and collect a flat metadata index.
 * Reads file SIZE via .getFile() but NOT content.
 */
export async function collectSyncedFilesIndex(
  trees: Array<FolderTreeNode | null>,
): Promise<SyncedFileEntry[]> {
  const out: SyncedFileEntry[] = [];
  for (const root of trees) {
    if (!root) continue;
    await walk(root, out);
  }
  return out;
}

async function walk(node: FolderTreeNode, out: SyncedFileEntry[]): Promise<void> {
  if (node.kind === "directory") {
    for (const child of node.children ?? []) {
      await walk(child, out);
    }
    return;
  }
  // file
  const kind = classifyKind(node.name);
  let size = 0;
  let mtime = 0;
  try {
    const f = await (node.handle as FileSystemFileHandle).getFile();
    size = f.size;
    mtime = f.lastModified;
  } catch {
    // unreadable; still include with zeros so LLM can see it exists
  }
  out.push({ path: node.path, kind, size, mtime });
}

/**
 * Resolve a file path back to its FileSystemFileHandle by walking the
 * provided trees. O(N) — acceptable for hackathon scale.
 */
export function findHandleByPath(
  trees: Array<FolderTreeNode | null>,
  path: string,
): FileSystemFileHandle | null {
  for (const root of trees) {
    if (!root) continue;
    const found = searchTree(root, path);
    if (found) return found;
  }
  return null;
}

function searchTree(node: FolderTreeNode, path: string): FileSystemFileHandle | null {
  if (node.kind === "file" && node.path === path) {
    return node.handle as FileSystemFileHandle;
  }
  if (node.kind === "directory") {
    for (const child of node.children ?? []) {
      const f = searchTree(child, path);
      if (f) return f;
    }
  }
  return null;
}

/**
 * Read + parse a single file. text returns content directly; pdf goes through
 * pdfjs-dist (lazy-loaded) with an IDB cache keyed by (path, lastModified).
 *
 * Returns the textual representation (UTF-8) for the LLM. Truncates at
 * `maxChars` (default 80k) to avoid blowing the LLM context with one file.
 */
export async function readSyncedFileContent(
  trees: Array<FolderTreeNode | null>,
  path: string,
  maxChars = 80_000,
): Promise<{ ok: true; text: string; truncated: boolean; size: number; kind: SyncedFileEntry["kind"] } | { ok: false; error: string }> {
  const handle = findHandleByPath(trees, path);
  if (!handle) return { ok: false, error: `file not found in synced folders: ${path}` };
  const file = await handle.getFile().catch((e: Error) => {
    throw new Error(`getFile failed: ${e.message}`);
  });
  const kind = classifyKind(file.name);

  if (kind === "unsupported") {
    return { ok: false, error: `unsupported file format: ${file.name}` };
  }

  let text: string;
  if (kind === "text") {
    text = await file.text();
  } else {
    // pdf
    const cached = await getCachedPdfText(path, file.lastModified).catch(() => null);
    if (cached !== null) {
      text = cached;
    } else {
      text = await parsePdfToText(file);
      await putCachedPdfText(path, file.lastModified, text).catch(() => {});
    }
  }

  const truncated = text.length > maxChars;
  return {
    ok: true,
    text: truncated ? text.slice(0, maxChars) + `\n\n[...truncated; original ${text.length} chars]` : text,
    truncated,
    size: file.size,
    kind,
  };
}

async function parsePdfToText(file: File): Promise<string> {
  // Lazy import to keep initial bundle small.
  const pdfjs = await import("pdfjs-dist");
  // Tell pdfjs where the worker is. Vite/webpack handles this transform.
  // For Next.js, point at the CDN-hosted worker to avoid bundler config.
  (pdfjs as any).GlobalWorkerOptions.workerSrc =
    `https://cdn.jsdelivr.net/npm/pdfjs-dist@${(pdfjs as any).version}/build/pdf.worker.min.mjs`;

  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((it: any) => ("str" in it ? it.str : ""))
      .join(" ");
    parts.push(`--- Page ${i} ---\n${pageText}`);
  }
  return parts.join("\n\n");
}
