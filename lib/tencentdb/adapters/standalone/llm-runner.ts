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
    timeoutMs?: number;
  }): Promise<string> {
    const timeoutMs = params.timeoutMs ?? this.config.timeoutMs ?? 120_000;

    const baseURL = this.config.baseUrl.endsWith("/v1")
      ? this.config.baseUrl
      : `${this.config.baseUrl.replace(/\/$/, "")}/v1`;
    const provider = createOpenAI({
      baseURL,
      apiKey: this.config.apiKey,
    });

    // No maxOutputTokens — let the model finish. Capping here used to chop
    // long L1/L2/L3 outputs mid-JSON, breaking the downstream parser.
    const result = await generateText({
      model: provider.chat(this.config.model),
      system: params.systemPrompt,
      prompt: params.prompt,
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
      timeoutMs: 120_000,
    });
  }
  return _runner;
}
