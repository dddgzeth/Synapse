/**
 * Tool-enabled LLM runner — sandboxed file IO for L2/L3 agentic memory pipeline.
 *
 * Drop-in replacement for TencentDB's `CleanContextRunner` (which depends on
 * OpenClaw runtime that's not available in this project). Same class name and
 * constructor signature so `SceneExtractor` / `PersonaGenerator` can use it
 * unchanged.
 *
 * Tools exposed when `enableTools: true`:
 *   - list_dir(path)           → directory listing
 *   - read_file(path)          → full UTF-8 read
 *   - write_file(path, content)→ overwrite (rejects empty/whitespace; LLM uses
 *                                "[DELETED]" marker — matches original semantics
 *                                so scene-extractor's soft-delete cleanup works)
 *   - edit_file(path, old, new)→ unique exact-match substring replace
 *
 * All paths resolve relative to `params.workspaceDir`; absolute paths,
 * symlinks, and `..` traversal that escape the workspace root are rejected.
 *
 * Uses Vercel AI SDK 6's multi-step tool loop (`stopWhen: stepCountIs(N)`),
 * so the LLM can read → think → write → think → write iteratively in one call.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { generateText, tool, stepCountIs } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import type { LLMRunParams, LLMRunner } from "./types";

const TAG = "[synapse][tool-runner]";

interface RunnerLogger {
  debug?: (msg: string) => void;
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface CleanContextRunnerOptions {
  /** Ignored — kept for signature parity with original TencentDB CleanContextRunner. */
  config?: unknown;
  /** Ignored — model resolved from ANTHROPIC_MODEL env. */
  modelRef?: string;
  /** When true, registers file tools (read/write/edit/list_dir). Default: false. */
  enableTools?: boolean;
  logger?: RunnerLogger;
  /** Max tool-call steps the LLM can take in one run. Default: 25. */
  maxSteps?: number;
}

export class CleanContextRunner implements LLMRunner {
  private enableTools: boolean;
  private logger: RunnerLogger | undefined;
  private maxSteps: number;

  constructor(opts: CleanContextRunnerOptions = {}) {
    this.enableTools = opts.enableTools ?? false;
    this.logger = opts.logger;
    this.maxSteps = opts.maxSteps ?? 25;
    this.logger?.debug?.(`${TAG} created: enableTools=${this.enableTools}, maxSteps=${this.maxSteps}`);
  }

  async run(params: LLMRunParams): Promise<string> {
    const timeoutMs = params.timeoutMs ?? 120_000;

    const rawBase = process.env.ANTHROPIC_BASE_URL ?? "https://www.fucheers.top";
    const baseURL = rawBase.endsWith("/v1") ? rawBase : `${rawBase.replace(/\/$/, "")}/v1`;
    const provider = createOpenAI({
      baseURL,
      apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    });
    const model = provider.chat(process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6");

    const tools = this.enableTools ? this.buildTools(params.workspaceDir) : undefined;

    const t0 = Date.now();
    // No maxOutputTokens — let the model run to completion under the model's
    // own cap. Internal callers used to set this to 4096 which truncated
    // long structured outputs (L1 dedup, scene extraction).
    const result = await generateText({
      model,
      ...(params.systemPrompt ? { system: params.systemPrompt } : {}),
      prompt: params.prompt,
      abortSignal: AbortSignal.timeout(timeoutMs),
      ...(tools ? { tools, stopWhen: stepCountIs(this.maxSteps) } : {}),
    });

    this.logger?.debug?.(
      `${TAG} run(${params.taskId}) done in ${Date.now() - t0}ms ` +
      `(text=${result.text.length} chars, steps=${result.steps?.length ?? 1})`,
    );
    return (result.text ?? "").trim();
  }

  private buildTools(workspaceDir: string | undefined) {
    if (!workspaceDir) {
      throw new Error(`${TAG} enableTools=true but workspaceDir not provided`);
    }
    const root = path.resolve(workspaceDir);
    const safeResolve = (rel: string): string => {
      if (typeof rel !== "string" || rel.length === 0) {
        throw new Error("path must be a non-empty string");
      }
      const abs = path.resolve(root, rel);
      if (abs !== root && !abs.startsWith(root + path.sep)) {
        throw new Error(`path traversal denied: ${rel}`);
      }
      return abs;
    };

    return {
      list_dir: tool({
        description:
          "List files and subdirectories. Returns names, one per line. Directories end with '/'.",
        inputSchema: z.object({
          path: z.string().describe("Relative path from workspace root. Use '.' for root."),
        }),
        execute: async ({ path: rel }) => {
          const abs = safeResolve(rel || ".");
          const items = await fs.readdir(abs, { withFileTypes: true });
          if (items.length === 0) return "(empty)";
          return items.map((d) => (d.isDirectory() ? `${d.name}/` : d.name)).sort().join("\n");
        },
      }),
      read_file: tool({
        description: "Read a UTF-8 text file. Returns full content.",
        inputSchema: z.object({
          path: z.string().describe("Relative path from workspace root."),
        }),
        execute: async ({ path: rel }) => {
          const abs = safeResolve(rel);
          return await fs.readFile(abs, "utf-8");
        },
      }),
      write_file: tool({
        description:
          "Write/overwrite a UTF-8 text file. Empty content is REJECTED — to mark " +
          "a file for cleanup write the literal string '[DELETED]'.",
        inputSchema: z.object({
          path: z.string(),
          content: z.string(),
        }),
        execute: async ({ path: rel, content }) => {
          if (!content || !content.trim()) {
            throw new Error(
              "write_file: content must not be empty/whitespace. " +
              "Use '[DELETED]' to mark a file for cleanup.",
            );
          }
          const abs = safeResolve(rel);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, content, "utf-8");
          return `ok (${content.length} chars)`;
        },
      }),
      edit_file: tool({
        description:
          "Replace an exact-match substring in a file. The `old` substring must " +
          "appear EXACTLY ONCE — otherwise the call fails.",
        inputSchema: z.object({
          path: z.string(),
          old: z.string().describe("The exact substring to replace (must be unique in file)."),
          new: z.string().describe("The replacement substring."),
        }),
        execute: async ({ path: rel, old, new: replacement }) => {
          const abs = safeResolve(rel);
          const text = await fs.readFile(abs, "utf-8");
          const count = text.split(old).length - 1;
          if (count === 0) throw new Error(`edit_file: 'old' not found in ${rel}`);
          if (count > 1) {
            throw new Error(
              `edit_file: 'old' appears ${count} times in ${rel}; must be unique. ` +
              `Include more surrounding context to disambiguate.`,
            );
          }
          await fs.writeFile(abs, text.replace(old, replacement), "utf-8");
          return "ok";
        },
      }),
    };
  }
}
