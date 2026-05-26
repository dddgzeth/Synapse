/**
 * Synced-file tools for the chat — let the LLM see and read user's local files
 * without us ingesting them into L0.
 *
 * Architecture:
 *   - `list_synced_files`: SERVER execute. Reads the metadata index that the
 *     browser ships with each chat request. No file content ever in body.
 *   - `read_synced_file`: NO execute. AI SDK 6 streams the tool call to the
 *     client, which uses its FileSystemHandle to parse the file (text or PDF
 *     via pdfjs-dist), then `addToolResult` returns the content. The content
 *     transits our server only as the tool_result message on its way back to
 *     the LLM — never stored, never logged.
 */
import { tool } from "ai";
import { z } from "zod";

export interface SyncedFileEntry {
  path: string;
  kind: "text" | "pdf" | "docx" | "pptx" | "xlsx" | "unsupported";
  size: number;
  mtime: number;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function formatIndex(index: SyncedFileEntry[], pathPrefix?: string, totalBeforeFilter?: number): string {
  const total = totalBeforeFilter ?? index.length;
  if (index.length === 0) {
    if (pathPrefix) {
      return `No synced files matched prefix "${pathPrefix}" (${total} total files across all synced folders). Try a different prefix, or omit path_prefix to see everything.`;
    }
    return "No synced files. Tell the user they need to click '+ 连接文件夹' in the left sidebar first.";
  }
  const lines: string[] = [
    pathPrefix
      ? `${index.length} file(s) under "${pathPrefix}" (${total} total in all synced folders):`
      : `${index.length} synced file(s) available:`,
    "",
  ];
  for (const f of index) {
    lines.push(`- ${f.path}  [${f.kind}, ${formatBytes(f.size)}]`);
  }
  lines.push("");
  lines.push("Call read_synced_file(path) to read any. 'unsupported' kinds can't be read.");
  return lines.join("\n");
}

export function buildSyncedFileTools(
  index: SyncedFileEntry[],
  /** Prior list_synced_files calls in the message history — each entry is the
   *  path_prefix used (empty string "" means "no prefix / full listing"). Pre-
   *  populating the dedup set prevents the LLM from re-flooding context with
   *  the same metadata on follow-up turns (e.g. after a client-side tool roundtrip). */
  priorListPrefixes: string[] = [],
) {
  // De-dup state — list_synced_files only emits a given scope once across
  // both intra-request loops AND cross-request resumes. The all-files scope
  // is keyed by empty string "".
  const emittedScopes = new Set<string>(priorListPrefixes);

  return {
    list_synced_files: tool({
      description:
        "List files in the user's connected local folders (metadata only: " +
        "path, kind, size, modified time). \n\n" +
        "**IMPORTANT — pass `path_prefix` whenever the user mentions a sub-path** " +
        "(e.g. user says 'analyze Zotero/NTU/SDL', pass `path_prefix='Zotero/NTU/SDL'`). " +
        "Without a prefix this can return hundreds of files and burn tokens.\n\n" +
        "Call this ONCE per scope at the start of a conversation; the result is " +
        "stable for the rest of this conversation. DO NOT re-call before each " +
        "read_synced_file — re-use the paths from the first call.",
      inputSchema: z.object({
        path_prefix: z
          .string()
          .optional()
          .describe(
            "Optional case-sensitive path prefix filter, e.g. " +
            "'NTU_Research_FAIR/Zotero/NTU/SDL'. Matches files whose path " +
            "starts with this string. Omit to get all synced files.",
          ),
      }),
      execute: async ({ path_prefix }) => {
        const scope = path_prefix ?? "";
        if (emittedScopes.has(scope)) {
          const ident = path_prefix ? `path_prefix='${path_prefix}'` : "no prefix";
          return `[list_synced_files(${ident}) was already returned earlier in this conversation. Re-use the paths from that result; do NOT call again with the same scope. Pass a DIFFERENT path_prefix only if you need a new scope.]`;
        }
        // If the full listing was already emitted, any sub-prefix is redundant —
        // the LLM already saw all paths and can filter mentally.
        if (emittedScopes.has("") && path_prefix) {
          emittedScopes.add(scope);
          return `[full listing was already returned earlier in this conversation — filter paths starting with '${path_prefix}' yourself from that earlier output. Do NOT request the same data again.]`;
        }
        const total = index.length;
        const filtered = path_prefix
          ? index.filter((f) => f.path.startsWith(path_prefix))
          : index;
        emittedScopes.add(scope);
        return formatIndex(filtered, path_prefix, total);
      },
    }),

    read_synced_file: tool({
      description:
        "Read and return the textual content of ONE synced file by its path. " +
        "Supported kinds: text, pdf, docx, pptx, xlsx. Parsed in the browser " +
        "(pdfjs / mammoth / xlsx / jszip). Content truncated at ~80k chars; if " +
        "truncated, ask the user to narrow which section they need. Use paths " +
        "from a previous list_synced_files call — do NOT call list_synced_files " +
        "again before each read.",
      inputSchema: z.object({
        path: z.string().describe(
          "Exact path from list_synced_files output, e.g. 'ELN/Murray-Rust 1999.pdf'",
        ),
      }),
      // ⚠️ NO execute — AI SDK 6 will stream the tool call to the client.
      // The browser's onToolCall handler reads the file via FileSystemFileHandle
      // and returns the content via addToolResult.
    }),
  };
}
