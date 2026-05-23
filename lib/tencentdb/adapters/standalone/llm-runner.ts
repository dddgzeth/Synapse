/**
 * StandaloneLLMRunner — copied from TencentDB Agent Memory.
 *
 * Powered by Vercel AI SDK (ai + @ai-sdk/openai).
 * Used for L1 extraction and L2/L3 pipeline calls.
 */

import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

export interface StandaloneLLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  timeoutMs?: number;
}

const TAG = "[synapse][llm-runner]";

export class StandaloneLLMRunner {
  private config: StandaloneLLMConfig;

  constructor(config: StandaloneLLMConfig) {
    this.config = config;
  }

  async run(params: {
    systemPrompt: string;
    prompt: string;
    maxTokens?: number;
    timeoutMs?: number;
  }): Promise<string> {
    const timeoutMs = params.timeoutMs ?? this.config.timeoutMs ?? 120_000;
    const maxTokens = params.maxTokens ?? this.config.maxTokens ?? 4096;

    const baseURL = this.config.baseUrl.endsWith("/v1")
      ? this.config.baseUrl
      : `${this.config.baseUrl.replace(/\/$/, "")}/v1`;
    const provider = createOpenAI({
      baseURL,
      apiKey: this.config.apiKey,
    });

    const result = await generateText({
      model: provider.chat(this.config.model),
      system: params.systemPrompt,
      prompt: params.prompt,
      maxOutputTokens: maxTokens,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });

    return result.text.trim();
  }
}

let _runner: StandaloneLLMRunner | null = null;

export function getLLMRunner(): StandaloneLLMRunner {
  if (!_runner) {
    _runner = new StandaloneLLMRunner({
      baseUrl: process.env.ANTHROPIC_BASE_URL ?? "https://www.fucheers.top",
      apiKey: process.env.ANTHROPIC_API_KEY ?? "",
      model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
      maxTokens: 4096,
      timeoutMs: 120_000,
    });
  }
  return _runner;
}
