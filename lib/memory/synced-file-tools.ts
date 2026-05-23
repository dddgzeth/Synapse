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
  kind: "text" | "pdf" | "unsupported";
  size: number;
  mtime: number;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function formatIndex(index: SyncedFileEntry[]): string {
  if (index.length === 0) {
    return "No synced files. Tell the user they need to click '+ 连接文件夹' in the left sidebar first.";
  }
  const lines: string[] = [
    `${index.length} synced file(s) available:`,
    "",
  ];
  for (const f of index) {
    lines.push(`- ${f.path}  [${f.kind}, ${formatBytes(f.size)}]`);
  }
  lines.push("");
  lines.push("Call read_synced_file(path) to read any of these. 'unsupported' kinds can't be read.");
  return lines.join("\n");
}

export function buildSyncedFileTools(index: SyncedFileEntry[]) {
  return {
    list_synced_files: tool({
      description:
        "List all files in the user's connected local folders (only metadata: " +
        "path, kind, size, modified time). NO file content is returned. Call " +
        "this FIRST when the user asks anything about their files (e.g. " +
        "'summarize the Murray-Rust paper', 'what's in my notes', 'list my PDFs'). " +
        "Then call read_synced_file(path) on the specific file(s) you need.",
      inputSchema: z.object({}),
      execute: async () => formatIndex(index),
    }),

    read_synced_file: tool({
      description:
        "Read and return the textual content of ONE synced file by its path " +
        "(as returned by list_synced_files). For PDFs the client parses them " +
        "on the fly via pdfjs-dist. Content is truncated at ~80k chars; if " +
        "truncated, you can ask the user to narrow which section they need. " +
        "ALWAYS call list_synced_files first to know what's available — never " +
        "guess paths.",
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
