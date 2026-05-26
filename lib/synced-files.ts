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
  kind: "text" | "pdf" | "docx" | "pptx" | "xlsx" | "unsupported";
  size: number;          // bytes (from file.size)
  mtime: number;         // epoch ms (from file.lastModified)
}

const TEXT_EXTS = [".txt", ".md", ".tex", ".rst", ".csv", ".json", ".yaml", ".yml"];

export function classifyKind(name: string): SyncedFileEntry["kind"] {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".pptx")) return "pptx";
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) return "xlsx";
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
  } else if (kind === "pdf") {
    const cached = await getCachedPdfText(path, file.lastModified).catch(() => null);
    if (cached !== null) {
      text = cached;
    } else {
      text = await parsePdfToText(file);
      await putCachedPdfText(path, file.lastModified, text).catch(() => {});
    }
  } else if (kind === "docx") {
    const cached = await getCachedPdfText(path, file.lastModified).catch(() => null);
    if (cached !== null) {
      text = cached;
    } else {
      text = await parseDocxToText(file);
      await putCachedPdfText(path, file.lastModified, text).catch(() => {});
    }
  } else if (kind === "pptx") {
    const cached = await getCachedPdfText(path, file.lastModified).catch(() => null);
    if (cached !== null) {
      text = cached;
    } else {
      text = await parsePptxToText(file);
      await putCachedPdfText(path, file.lastModified, text).catch(() => {});
    }
  } else if (kind === "xlsx") {
    const cached = await getCachedPdfText(path, file.lastModified).catch(() => null);
    if (cached !== null) {
      text = cached;
    } else {
      text = await parseXlsxToText(file);
      await putCachedPdfText(path, file.lastModified, text).catch(() => {});
    }
  } else {
    text = "";
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

export async function parsePdfToText(file: File): Promise<string> {
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

// ─────────────────────────────────────────
// Office documents — all lazy-loaded for bundle size.
// ─────────────────────────────────────────

export async function parseDocxToText(file: File): Promise<string> {
  const mammoth = await import("mammoth");
  const buf = await file.arrayBuffer();
  // extractRawText is faster than convertToHtml and good enough for LLM consumption.
  const r = await (mammoth as any).extractRawText({ arrayBuffer: buf });
  const messages = (r.messages ?? []).filter((m: any) => m.type !== "info");
  const warningTail = messages.length > 0
    ? `\n\n[parser notes: ${messages.slice(0, 3).map((m: any) => m.message).join("; ")}]`
    : "";
  return (r.value ?? "").trim() + warningTail;
}

export async function parseXlsxToText(file: File): Promise<string> {
  const XLSX = await import("xlsx");
  const buf = await file.arrayBuffer();
  const wb = (XLSX as any).read(buf, { type: "array" });
  const out: string[] = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const csv = (XLSX as any).utils.sheet_to_csv(sheet, { blankrows: false });
    out.push(`--- Sheet: ${sheetName} ---\n${csv}`);
  }
  return out.join("\n\n");
}

export async function parsePptxToText(file: File): Promise<string> {
  // .pptx is a zip; each slide is ppt/slides/slideN.xml. We extract <a:t> text.
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)/)?.[1] ?? "0", 10);
      const nb = parseInt(b.match(/slide(\d+)/)?.[1] ?? "0", 10);
      return na - nb;
    });
  const out: string[] = [];
  for (const name of slideFiles) {
    const xml = await zip.files[name].async("string");
    // Pull every <a:t>…</a:t> run.
    const matches = xml.match(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g) ?? [];
    const text = matches
      .map((m) => m.replace(/<a:t[^>]*>|<\/a:t>/g, ""))
      .map(decodeXmlEntities)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const slideNum = name.match(/slide(\d+)/)?.[1] ?? "?";
    out.push(`--- Slide ${slideNum} ---\n${text}`);
  }
  // Speaker notes (optional, ppt/notesSlides/notesSlideN.xml).
  const noteFiles = Object.keys(zip.files)
    .filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(n))
    .sort();
  if (noteFiles.length > 0) {
    out.push("\n=== Speaker Notes ===");
    for (const name of noteFiles) {
      const xml = await zip.files[name].async("string");
      const matches = xml.match(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g) ?? [];
      const text = matches
        .map((m) => m.replace(/<a:t[^>]*>|<\/a:t>/g, ""))
        .map(decodeXmlEntities)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      const num = name.match(/notesSlide(\d+)/)?.[1] ?? "?";
      if (text) out.push(`[Notes ${num}] ${text}`);
    }
  }
  return out.join("\n\n");
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
}
