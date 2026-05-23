/**
 * Host-neutral LLM runner interface.
 *
 * Ported from TencentDB Memory Agent's `core/types.ts` — kept identical so
 * SceneExtractor / PersonaGenerator / PersonaTrigger can import `LLMRunner`
 * without modification.
 */

export interface LLMRunParams {
  /** User-facing prompt (or combined prompt if no systemPrompt). */
  prompt: string;
  /** Optional system prompt. When provided, `prompt` is used as the user message. */
  systemPrompt?: string;
  /** Unique task identifier for logging and metrics. */
  taskId: string;
  /** Execution timeout in milliseconds (default: 120_000). */
  timeoutMs?: number;
  /** Max output tokens (optional). */
  maxTokens?: number;
  /**
   * Working directory for tool-enabled runs.
   * When enableTools=true, the LLM's file tools resolve paths relative to this dir.
   */
  workspaceDir?: string;
  /** Plugin instance ID for metric reporting (optional). */
  instanceId?: string;
}

export interface LLMRunner {
  run(params: LLMRunParams): Promise<string>;
}
