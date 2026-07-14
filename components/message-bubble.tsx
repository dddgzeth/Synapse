"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { EvidenceGraph, type AhaPayload, type EvidenceData, type SelectedDetail } from "./evidence-graph";
import { EvidenceDrawer } from "./evidence-drawer";
import { useI18n, type TranslationSet, getApiSettingsForRequest } from "./i18n";
import { MessagePageView } from "./message-page-view";
import { parsePageArtifact } from "@/lib/page-artifact";

interface Props {
  message: UIMessage;
  /** Whether the chat is currently streaming this message in. */
  streaming?: boolean;
}

/**
 * LLM output often jams an ATX heading onto the line right after a list item or
 * paragraph with no blank line — CommonMark then treats the `##` line as a
 * continuation of the previous block, so the user sees literal `##`. Same for
 * fenced code blocks and tables that come right after a heading. Insert the
 * missing blank lines so react-markdown can do its job.
 */
function normalizeMarkdown(raw: string): string {
  return raw
    // blank line BEFORE any ATX heading that's not already at the start
    .replace(/([^\n])\n(#{1,6} )/g, "$1\n\n$2")
    // blank line AFTER an ATX heading line
    .replace(/(\n#{1,6} [^\n]*)\n(?!\n|#{1,6} )/g, "$1\n\n")
    // blank line before fenced code that follows immediately after text
    .replace(/([^\n])\n(```)/g, "$1\n\n$2");
}

function extractText(message: UIMessage): string {
  const raw = !message.parts || message.parts.length === 0
    ? ((message as any).content ?? "")
    : message.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("");
  if (message.role !== "assistant") return raw;
  // Defensive: some proxied models hallucinate fake tool-call XML even though
  // Synapse registers no tools. Strip both well-formed blocks and dangling
  // opening tags so partial streams don't flash garbage at the user.
  return raw
    .replace(/<(tool_call|tool_response|function_call|function_response|invoke)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?(tool_call|tool_response|function_call|function_response|invoke)\b[^>]*>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractImages(message: UIMessage): Array<{ url: string; filename?: string }> {
  if (!message.parts) return [];
  return message.parts
    .filter((p): p is { type: "file"; url: string; mediaType: string; filename?: string } =>
      p.type === "file" && (p as any).mediaType?.startsWith("image/"))
    .map((p) => ({ url: (p as any).url, filename: (p as any).filename }));
}

// ── Tool-call progress (server pushes via data-progress parts) ────────────
type ProgressItem =
  | { kind: "step-start"; step: number; promptChars: number; budgetMs: number }
  | { kind: "tool-call"; toolCallId: string; name: string; input: unknown }
  | { kind: "tool-result"; toolCallId: string; name: string; tookMs: number; outputPreview: string; outputLen: number }
  | { kind: "tool-error"; toolCallId: string; name: string; error: string }
  | { kind: "compaction"; reason: "context-budget" | "context-error" | "timeout-retry"; beforeChars: number; afterChars: number; targetToolCallId?: string }
  | { kind: "notice"; code: "context_too_long_retry"; detail?: string }
  | { kind: "error"; code: "request_timed_out" | "context_still_too_long" | "context_too_long_no_compactable" | "provider_error" | "internal_error"; detail?: string };

function extractProgress(message: UIMessage): ProgressItem[] {
  if (!message.parts) return [];
  return message.parts
    .filter((p) => (p as any).type === "data-progress")
    .map((p) => (p as any).data as ProgressItem)
    .filter((d) => d && typeof d === "object" && "kind" in d);
}

// Also include AI SDK 6's native tool-* parts (client-side tools whose result
// the browser supplied via addToolResult).
type ClientToolPart = {
  type: string;          // "tool-read_synced_file" etc.
  toolCallId: string;
  state: "input-streaming" | "input-available" | "output-available" | "output-error";
  input?: unknown;
  output?: unknown;
};

function extractClientToolParts(message: UIMessage): ClientToolPart[] {
  if (!message.parts) return [];
  return message.parts
    .filter((p): p is any =>
      typeof (p as any).type === "string" && (p as any).type.startsWith("tool-") && (p as any).toolCallId,
    ) as ClientToolPart[];
}

function toolLabel(t: TranslationSet, name: string, input: any): { icon: string; title: string; detail?: string } {
  if (name === "list_synced_files") return { icon: "📂", title: t.chat.progress.tools.list_synced_files };
  if (name === "read_synced_file") return { icon: "📖", title: t.chat.progress.tools.read_synced_file, detail: input?.path ?? "" };
  if (name === "tdai_memory_search") return { icon: "🔍", title: t.chat.progress.tools.tdai_memory_search, detail: input?.query ?? "" };
  if (name === "tdai_conversation_search") return { icon: "🔍", title: t.chat.progress.tools.tdai_conversation_search, detail: input?.query ?? "" };
  return { icon: "🔧", title: t.chat.progress.tools.fallback(name) };
}

function ProgressChips({ items, clientTools, streaming }: {
  items: ProgressItem[];
  clientTools: ClientToolPart[];
  streaming: boolean;
}) {
  const { t } = useI18n();
  // Build a map: toolCallId → { call, result/error }
  type Entry = {
    toolCallId: string;
    name: string;
    input?: any;
    tookMs?: number;
    outputPreview?: string;
    outputLen?: number;
    error?: string;
    state: "running" | "ok" | "error";
    fromClient: boolean;
  };
  const map = new Map<string, Entry>();
  let latestStep: { promptChars: number; budgetMs: number; step: number } | undefined;

  for (const it of items) {
    if (it.kind === "step-start") {
      latestStep = { step: it.step, promptChars: it.promptChars, budgetMs: it.budgetMs };
    } else if (it.kind === "tool-call") {
      map.set(it.toolCallId, {
        toolCallId: it.toolCallId, name: it.name, input: it.input,
        state: "running", fromClient: false,
      });
    } else if (it.kind === "tool-result") {
      const prev = map.get(it.toolCallId);
      map.set(it.toolCallId, {
        ...(prev ?? { toolCallId: it.toolCallId, name: it.name, fromClient: false }),
        tookMs: it.tookMs, outputPreview: it.outputPreview, outputLen: it.outputLen,
        state: "ok",
      } as Entry);
    } else if (it.kind === "tool-error") {
      const prev = map.get(it.toolCallId);
      map.set(it.toolCallId, {
        ...(prev ?? { toolCallId: it.toolCallId, name: it.name, fromClient: false }),
        error: it.error, state: "error",
      } as Entry);
    }
  }

  // Merge in client-tool parts (read_synced_file done by browser)
  for (const ct of clientTools) {
    const name = ct.type.replace(/^tool-/, "");
    const prev = map.get(ct.toolCallId);
    const state: Entry["state"] =
      ct.state === "output-available" ? "ok"
      : ct.state === "output-error" ? "error"
      : "running";
    const outputStr = typeof ct.output === "string" ? ct.output : JSON.stringify(ct.output ?? "");
    map.set(ct.toolCallId, {
      toolCallId: ct.toolCallId,
      name,
      input: ct.input,
      state,
      fromClient: true,
      outputPreview: outputStr.slice(0, 280),
      outputLen: outputStr.length,
      ...(prev?.tookMs ? { tookMs: prev.tookMs } : {}),
    });
  }

  const entries = Array.from(map.values());

  // Compaction + notice events get rendered inline (chronological-ish via
  // index in the items list)
  const compactions = items.filter((it) => it.kind === "compaction") as Extract<ProgressItem, { kind: "compaction" }>[];
  const notices = items.filter((it) => it.kind === "notice") as Extract<ProgressItem, { kind: "notice" }>[];
  const errors = items.filter((it) => it.kind === "error") as Extract<ProgressItem, { kind: "error" }>[];

  if (entries.length === 0 && compactions.length === 0 && notices.length === 0 && errors.length === 0 && !streaming) return null;

  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 4,
      marginBottom: 8, maxWidth: "100%",
    }}>
      {entries.map((e) => <ChipRow key={e.toolCallId} entry={e} t={t} />)}
      {compactions.map((c, i) => <CompactionRow key={`cmp-${i}`} c={c} t={t} />)}
      {notices.map((n, i) => <NoticeRow key={`ntc-${i}`} notice={n} t={t} />)}
      {errors.map((e, i) => <ErrorRow key={`err-${i}`} error={e} t={t} />)}
      {streaming && entries.every((e) => e.state !== "running") && (
        <ThinkingRow label={latestStep ? t.chat.progress.thinkingWithContext(formatChars(latestStep.promptChars, t)) : t.chat.thinking} />
      )}
    </div>
  );
}

function CompactionRow({ c, t }: { c: { reason: "context-budget" | "context-error" | "timeout-retry"; beforeChars: number; afterChars: number; targetToolCallId?: string }; t: TranslationSet }) {
  const ratio = c.beforeChars > 0 ? Math.round((1 - c.afterChars / c.beforeChars) * 100) : 0;
  const reasonText = c.reason === "timeout-retry"
    ? t.chat.progress.compactedAfterTimeout
    : c.reason === "context-error"
      ? t.chat.progress.compactedAfterContextError
    : t.chat.progress.compactedAfterBudget;
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "6px 12px",
      background: "#FFF5E5", border: "1px solid #F0D0A0", borderRadius: 8,
      fontSize: 12, color: "#7A5A10",
    }}>
      <span>🗜️</span>
      <span style={{ fontWeight: 600 }}>{reasonText}</span>
      <span style={{ color: "#9a7a30" }}>
        · {formatChars(c.beforeChars, t)} → {formatChars(c.afterChars, t)} (-{ratio}%)
      </span>
    </div>
  );
}

function NoticeRow({ notice, t }: { notice: Extract<ProgressItem, { kind: "notice" }>; t: TranslationSet }) {
  const msg = notice.code === "context_too_long_retry"
    ? t.chat.progress.contextTooLongRetry
    : t.chat.progress.providerError;
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "6px 12px",
      background: "#FFF5E5", border: "1px dashed #F0D0A0", borderRadius: 8,
      fontSize: 12, color: "#7A5A10",
    }}>
      <span>ℹ️</span>
      <span>{msg}</span>
    </div>
  );
}

function ErrorRow({ error, t }: { error: Extract<ProgressItem, { kind: "error" }>; t: TranslationSet }) {
  const msg =
    error.code === "request_timed_out" ? t.chat.progress.requestTimedOut
    : error.code === "context_still_too_long" ? t.chat.progress.contextStillTooLong
    : error.code === "context_too_long_no_compactable" ? t.chat.progress.contextTooLongNoCompactable
    : error.code === "internal_error" ? t.chat.progress.internalError
    : t.chat.progress.providerError;
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 4,
      padding: "8px 12px",
      background: "#FFF1F1", border: "1px solid #F0B8B8", borderRadius: 8,
      fontSize: 12, color: "#8A1010",
    }}>
      <span style={{ fontWeight: 600 }}>{msg}</span>
    </div>
  );
}

function ChipRow({ entry, t }: { entry: any; t: TranslationSet }) {
  const [open, setOpen] = useState(false);
  const lbl = toolLabel(t, entry.name, entry.input);
  const stateColor =
    entry.state === "running" ? "var(--text-muted)"
    : entry.state === "error" ? "#a01010"
    : "var(--accent)";
  const stateIcon =
    entry.state === "running" ? <RunningDot />
    : entry.state === "error" ? "✗"
    : "✓";
  const tookStr = entry.tookMs ? ` · ${(entry.tookMs / 1000).toFixed(1)}s` : "";
  const sizeStr = entry.outputLen != null ? ` · ${formatChars(entry.outputLen, t)}` : "";

  return (
    <div style={{
      border: "1px solid var(--border)",
      background: "var(--surface)",
      borderRadius: 10,
      padding: "8px 12px",
      fontSize: 12.5,
      maxWidth: 560,
    }}>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={entry.state === "running"}
        style={{
          all: "unset", cursor: entry.state === "running" ? "default" : "pointer",
          display: "flex", alignItems: "center", gap: 8, width: "100%",
          fontFamily: "inherit", color: "var(--text)",
        }}
      >
        <span style={{ flexShrink: 0, color: stateColor, width: 14, display: "inline-flex", justifyContent: "center" }}>
          {stateIcon}
        </span>
        <span style={{ flexShrink: 0 }}>{lbl.icon}</span>
        <span style={{ fontWeight: 600 }}>{lbl.title}</span>
        {lbl.detail && (
          <span style={{
            color: "var(--text-muted)", overflow: "hidden",
            textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0,
          }}>
            {lbl.detail}
          </span>
        )}
        <span style={{ color: "var(--text-muted)", fontSize: 11, flexShrink: 0, marginLeft: "auto" }}>
          {tookStr}{sizeStr}
        </span>
        {entry.state !== "running" && (
          <span style={{ color: "var(--text-muted)", fontSize: 10, flexShrink: 0 }}>
            {open ? "▾" : "▸"}
          </span>
        )}
      </button>
      {open && entry.state !== "running" && (
        <div style={{
          marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border)",
          fontSize: 11.5, color: "var(--text-muted)",
          maxHeight: 200, overflowY: "auto",
          whiteSpace: "pre-wrap", wordBreak: "break-word",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        }}>
          {entry.error
            ? <span style={{ color: "#a01010" }}>{entry.error}</span>
            : entry.outputPreview
              ? (entry.outputPreview + (entry.outputLen > entry.outputPreview.length ? `\n${t.chat.progress.truncated}` : ""))
              : <i>{t.chat.progress.noOutput}</i>}
        </div>
      )}
    </div>
  );
}

function RunningDot() {
  return (
    <span style={{
      display: "inline-block", width: 8, height: 8, borderRadius: "50%",
      background: "var(--accent)",
      animation: "pulse 1.2s ease-in-out infinite",
    }} />
  );
}

function ThinkingRow({ label }: { label: string }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      fontSize: 12, color: "var(--text-muted)",
      padding: "4px 12px",
    }}>
      <RunningDot />
      <span>{label}</span>
    </div>
  );
}

function formatChars(n: number, t: TranslationSet): string {
  if (n < 1000) return `${n} ${t.chat.progress.chars}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k ${t.chat.progress.chars}`;
  return `${(n / 1_000_000).toFixed(2)}M ${t.chat.progress.chars}`;
}

export function MessageBubble({ message, streaming = false }: Props) {
  const { t, apiSettings } = useI18n();
  const isUser = message.role === "user";
  const [viewMode, setViewMode] = useState<"chat" | "page">("chat");
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const fullText = extractText(message);
  // Artifact protocol is assistant-only output. Skipping it for user messages
  // means we can never accidentally strip part of a user's question because it
  // contained one of the marker substrings.
  const { visibleText, html: pageHtml } = isUser
    ? { visibleText: fullText, html: null as string | null }
    : parsePageArtifact(fullText);
  const images = isUser ? extractImages(message) : [];
  const { mainContent, ahaInsight } = parseAha(visibleText);
  const hasText = mainContent.replace(/\s/g, "").length > 0;
  const hasInlineArtifact = !!pageHtml?.trim();  // legacy: pre-lazy reply with embedded artifact
  const progress = isUser ? [] : extractProgress(message);
  const clientTools = isUser ? [] : extractClientToolParts(message);

  // Lazy-loaded page artifact. Pages used to be eagerly generated alongside
  // every reply, doubling token cost even when the user never opened Page
  // view. Now it's opt-in: only fetched when the user clicks the Page toggle,
  // and cached in localStorage so a refresh doesn't re-generate.
  const cacheKey = `synapse:page:${message.id}`;
  const [lazyHtml, setLazyHtml] = useState<string | null>(() => {
    if (typeof window === "undefined" || isUser) return null;
    try { return window.localStorage.getItem(cacheKey); } catch { return null; }
  });
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  // The HTML we actually feed to the iframe: inline artifact wins (legacy
  // messages), otherwise lazy-fetched HTML.
  const activePageHtml = hasInlineArtifact ? pageHtml : lazyHtml;

  async function fetchPageRender() {
    if (inFlightRef.current || isUser) return;
    const baseText = mainContent.trim();
    if (!baseText) {
      setPageError(t.chat.viewPageEmpty);
      return;
    }
    inFlightRef.current = true;
    setPageLoading(true);
    setPageError(null);
    try {
      const resp = await fetch("/api/page-render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assistantText: baseText,
          apiSettings: getApiSettingsForRequest(apiSettings),
        }),
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => `HTTP ${resp.status}`);
        setPageError(txt.slice(0, 200));
        return;
      }
      const data = await resp.json() as { html?: string; error?: string };
      if (data.error) {
        setPageError(data.error);
        return;
      }
      const html = (data.html ?? "").trim();
      if (!html) {
        setPageError(t.chat.viewPageEmpty);
        return;
      }
      setLazyHtml(html);
      try { window.localStorage.setItem(cacheKey, html); } catch { /* quota / disabled */ }
    } catch (e) {
      setPageError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlightRef.current = false;
      setPageLoading(false);
    }
  }

  function handleToggle(mode: "chat" | "page") {
    setViewMode(mode);
    if (mode === "page" && !activePageHtml && !pageLoading && !isUser) {
      fetchPageRender();
    }
  }

  return (
    <div style={{
      padding: "6px 24px",
      display: "flex",
      flexDirection: "column",
      alignItems: isUser ? "flex-end" : "flex-start",
    }}>
      {!isUser && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
          <div style={{
            width: 26, height: 26, borderRadius: "50%",
            background: "var(--accent)", color: "#fff",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 13, fontWeight: 700, flexShrink: 0,
          }}>S</div>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>Synapse</span>
        </div>
      )}

      <div style={{
        maxWidth: !isUser && viewMode === "page" ? "min(92vw, 960px)" : "80%",
        width: !isUser && viewMode === "page" ? "min(92vw, 960px)" : undefined,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        alignItems: isUser ? "flex-end" : "flex-start",
      }}>
        {/* Tool-call progress (Synapse only) */}
        {!isUser && (progress.length > 0 || clientTools.length > 0 || streaming) && (
          <ProgressChips items={progress} clientTools={clientTools} streaming={streaming && !hasText} />
        )}

        {/* Image attachments — click to zoom */}
        {images.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {images.map((img, i) => (
              <img
                key={i}
                src={img.url}
                alt={img.filename ?? "image"}
                onClick={() => setLightboxUrl(img.url)}
                style={{
                  maxWidth: 240, maxHeight: 240, borderRadius: 10,
                  border: "1px solid var(--border)", objectFit: "contain",
                  background: "var(--surface-2)", cursor: "zoom-in",
                }}
              />
            ))}
          </div>
        )}
        {lightboxUrl && (
          <div
            onClick={() => setLightboxUrl(null)}
            style={{
              position: "fixed", inset: 0, zIndex: 1000,
              background: "rgba(14,13,18,0.82)",
              display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "zoom-out", padding: 32,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={lightboxUrl}
              alt="attachment"
              style={{
                maxWidth: "92vw", maxHeight: "92vh", objectFit: "contain",
                borderRadius: 12, boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
              }}
            />
          </div>
        )}

        {/* Message text */}
        {(hasText || (!isUser && hasInlineArtifact)) && (
          <>
            {!isUser && (
              <div style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 2,
                padding: 3,
                border: "1px solid var(--border)",
                borderRadius: 8,
                background: "var(--surface)",
                boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
              }}>
                {(["chat", "page"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => handleToggle(mode)}
                    aria-pressed={viewMode === mode}
                    title={mode === "chat" ? t.chat.viewChatTitle : t.chat.viewPageTitle}
                    style={{
                      border: "none",
                      borderRadius: 6,
                      padding: "4px 9px",
                      background: viewMode === mode ? "var(--accent)" : "transparent",
                      color: viewMode === mode ? "#fff" : "var(--text-muted)",
                      cursor: "pointer",
                      fontSize: 12,
                      fontWeight: 700,
                      lineHeight: 1.2,
                      fontFamily: "inherit",
                    }}
                  >
                    {mode === "chat" ? t.chat.viewChat : t.chat.viewPage}
                  </button>
                ))}
              </div>
            )}
            {viewMode === "page" && !isUser ? (
              pageLoading
                ? <PagePlaceholder kind="loading" label={t.chat.viewPageLoading} onRetry={null} />
                : pageError
                  ? <PagePlaceholder kind="error" label={pageError} onRetry={fetchPageRender} />
                  : activePageHtml
                    ? <MessagePageView text={mainContent} htmlArtifact={activePageHtml} />
                    : <PagePlaceholder kind="loading" label={t.chat.viewPageLoading} onRetry={null} />
            ) : (
              hasText ? <div style={{
                padding: "10px 14px",
                background: isUser ? "var(--accent)" : "var(--surface)",
                border: isUser ? "none" : "1px solid var(--border)",
                borderRadius: isUser ? "14px 14px 4px 14px" : "4px 14px 14px 14px",
                color: isUser ? "#fff" : "var(--text)",
                fontSize: 14,
                lineHeight: 1.65,
                boxShadow: isUser ? "none" : "0 1px 3px rgba(0,0,0,0.06)",
              }}>
                {isUser ? (
                  <UserMessageContent text={mainContent} />
                ) : (
                  <div className="prose">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{normalizeMarkdown(mainContent)}</ReactMarkdown>
                  </div>
                )}
              </div> : null
            )}
          </>
        )}

        {ahaInsight && <AhaCard content={ahaInsight} />}
      </div>
    </div>
  );
}

function AhaCard({ content }: { content: string }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidenceState, setEvidenceState] =
    useState<{ kind: "idle" | "loading" | "error"; msg?: string }
      | { kind: "ready"; aha: AhaPayload; evidence: EvidenceData }
    >({ kind: "idle" });
  const [selected, setSelected] = useState<SelectedDetail | null>(null);
  const lines = content.split("\n").filter((l) => l.trim());

  const openEvidence = async () => {
    setEvidenceOpen(true);
    if (evidenceState.kind === "ready") return;
    setEvidenceState({ kind: "loading" });
    try {
      const r1 = await fetch("/api/aha/last", { cache: "no-store" });
      const j1 = await r1.json();
      const aha: AhaPayload | null = j1.aha;
      if (!aha) {
        setEvidenceState({ kind: "error", msg: t.aha.noCache });
        return;
      }
      const r2 = await fetch("/api/aha/evidence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memoryIds: aha.supportingMemoryIds }),
        cache: "no-store",
      });
      const evidence: EvidenceData = await r2.json();
      setEvidenceState({ kind: "ready", aha, evidence });
    } catch (e) {
      setEvidenceState({ kind: "error", msg: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div style={{
      background: "var(--insight)",
      border: "1px solid var(--insight-border)",
      borderRadius: 12,
      padding: "14px 16px",
      fontSize: 13,
      lineHeight: 1.7,
      maxWidth: "100%",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
        <span style={{ fontSize: 16 }}>✨</span>
        <span style={{ color: "var(--accent)", fontWeight: 700, fontSize: 13 }}>{t.aha.noticed}</span>
      </div>
      <div style={{ color: "var(--text)", whiteSpace: "pre-wrap" }}>
        {expanded ? content : lines.slice(0, 3).join("\n")}
      </div>
      <div style={{ display: "flex", gap: 14, marginTop: 8, alignItems: "center" }}>
        {lines.length > 3 && (
          <button
            onClick={() => setExpanded(!expanded)}
            style={linkBtnStyle}
          >
            {expanded ? t.aha.collapse : t.aha.fullInsight}
          </button>
        )}
        <button
          onClick={() => (evidenceOpen ? setEvidenceOpen(false) : openEvidence())}
          style={linkBtnStyle}
        >
          {evidenceOpen ? t.aha.hideEvidence : t.aha.showEvidence}
        </button>
      </div>

      {evidenceOpen && (
        <div style={{
          marginTop: 12, borderTop: "1px solid var(--insight-border)",
          paddingTop: 12,
        }}>
          {evidenceState.kind === "loading" && (
            <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "12px 4px" }}>
              {t.aha.loadingGraph}
            </div>
          )}
          {evidenceState.kind === "error" && (
            <div style={{ fontSize: 12, color: "#a01010", padding: "8px 4px" }}>
              {t.common.loadFailed}: {evidenceState.msg}
            </div>
          )}
          {evidenceState.kind === "ready" && (
            <div style={{
              position: "relative",
              width: "100%",
              height: 520,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              overflow: "hidden",
            }}>
              <EvidenceGraph
                aha={evidenceState.aha}
                evidence={evidenceState.evidence}
                onSelect={setSelected}
              />
              <EvidenceDrawer detail={selected} onClose={() => setSelected(null)} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const linkBtnStyle: React.CSSProperties = {
  background: "none", border: "none",
  color: "var(--accent)", cursor: "pointer", fontSize: 12,
  padding: 0, fontWeight: 600,
};

function parseAha(content: string): { mainContent: string; ahaInsight: string | null } {
  const markerIdx = content.indexOf("\n---\n");
  if (markerIdx === -1) return { mainContent: content, ahaInsight: null };
  const afterMarker = content.slice(markerIdx + 5).trim();
  if (!afterMarker.includes("Synapse 注意到")) return { mainContent: content, ahaInsight: null };
  return { mainContent: content.slice(0, markerIdx).trim(), ahaInsight: afterMarker };
}

// ─────────────────────────────────────────────────────────────────────────
// User-message attachment rendering
//
// chat-panel.tsx wraps attached files into the user's text as:
//   <<<file: NAME>>>\nCONTENT\n<<<end: NAME>>>
// The LLM sees the inlined content, but the human user shouldn't have a wall
// of extracted text in their own bubble. Detect those blocks at render time
// and replace them with collapsible 📎 chips.
//
// Works for every format chat-panel client-parses (txt, md, pdf, docx, pptx,
// xlsx, etc.) since the wrapping format is uniform — no per-format logic
// needed here.
// ─────────────────────────────────────────────────────────────────────────

interface InlinedAttachment {
  name: string;
  content: string;
}

function parseUserMessageAttachments(text: string): {
  textWithoutFiles: string;
  attachments: InlinedAttachment[];
} {
  // Match `<<<file: NAME>>>\nCONTENT\n<<<end: ...>>>`. Use a non-greedy body
  // and accept any closing name (chat-panel always echoes the same name back,
  // but accepting any is more robust to whitespace drift).
  const re = /<<<file:\s*([^\n>]+?)>>>\r?\n([\s\S]*?)\r?\n<<<end:\s*[^\n>]+?>>>/g;
  const attachments: InlinedAttachment[] = [];
  const cleaned = text.replace(re, (_, name, content) => {
    attachments.push({
      name: String(name).trim(),
      content: String(content).trim(),
    });
    return "";  // strip the block from the displayed text
  });
  return {
    textWithoutFiles: cleaned.replace(/\n{3,}/g, "\n\n").trim(),
    attachments,
  };
}

function UserMessageContent({ text }: { text: string }) {
  const { textWithoutFiles, attachments } = parseUserMessageAttachments(text);
  return (
    <>
      {attachments.length > 0 && (
        <div style={{
          display: "flex", flexDirection: "column", gap: 6,
          marginBottom: textWithoutFiles ? 10 : 0,
        }}>
          {attachments.map((a, i) => (
            <AttachmentChip key={`${a.name}_${i}`} name={a.name} content={a.content} />
          ))}
        </div>
      )}
      {textWithoutFiles && (
        <span style={{ whiteSpace: "pre-wrap" }}>{textWithoutFiles}</span>
      )}
    </>
  );
}

function fileIcon(name: string): string {
  const lower = name.toLowerCase();
  if (/\.(pdf)$/.test(lower))                return "📄";
  if (/\.(pptx?|key)$/.test(lower))          return "📊";
  if (/\.(docx?|rtf|odt)$/.test(lower))      return "📝";
  if (/\.(xlsx?|csv|ods|tsv)$/.test(lower))  return "📈";
  if (/\.(json|yaml|yml|toml|xml)$/.test(lower)) return "🗂️";
  if (/\.(md|tex|rst|txt)$/.test(lower))     return "📃";
  return "📎";
}

function formatCharCount(n: number): string {
  if (n < 1000) return `${n} chars`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k chars`;
  return `${(n / 1_000_000).toFixed(2)}M chars`;
}

function AttachmentChip({ name, content }: InlinedAttachment) {
  const [expanded, setExpanded] = useState(false);
  // Bubble background is var(--accent) — make the chip a translucent overlay
  // so it reads cleanly on top while staying clearly "inside" the user message.
  return (
    <div
      style={{
        background: "rgba(255,255,255,0.16)",
        border: "1px solid rgba(255,255,255,0.25)",
        borderRadius: 10,
        overflow: "hidden",
        fontSize: 12,
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          width: "100%", padding: "6px 10px",
          background: "none", border: "none", cursor: "pointer",
          color: "inherit", fontFamily: "inherit", fontSize: 12,
          textAlign: "left",
        }}
      >
        <span style={{ fontSize: 14, flexShrink: 0 }}>{fileIcon(name)}</span>
        <span style={{
          flex: 1, fontWeight: 600,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{name}</span>
        <span style={{ opacity: 0.75, fontSize: 11, flexShrink: 0 }}>
          {formatCharCount(content.length)}
        </span>
        <span style={{ opacity: 0.6, fontSize: 10, flexShrink: 0 }}>
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded && (
        <pre style={{
          margin: 0,
          padding: "8px 10px",
          background: "rgba(0,0,0,0.18)",
          maxHeight: 280, overflow: "auto",
          fontSize: 11, lineHeight: 1.5,
          whiteSpace: "pre-wrap", wordBreak: "break-word",
          fontFamily: "ui-monospace, SFMono-Regular, monospace",
        }}>{content}</pre>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Lazy Page render placeholders — shown while /api/page-render is in flight
// or after it errored. Width matches the inline iframe so the layout doesn't
// shift when the real page arrives.
// ─────────────────────────────────────────────────────────────────────────

function PagePlaceholder({
  kind, label, onRetry,
}: { kind: "loading" | "error"; label: string; onRetry: (() => void) | null }) {
  const { t } = useI18n();
  const isErr = kind === "error";
  return (
    <div style={{
      width: "100%",
      alignSelf: "stretch",
      padding: "32px 24px",
      border: isErr ? "1px solid #F0B8B8" : "1px solid var(--border)",
      borderRadius: 12,
      background: isErr ? "#FFF7F7" : "var(--surface)",
      fontSize: 13,
      color: isErr ? "#7A1010" : "var(--text-muted)",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
      minHeight: 120,
    }}>
      <span>{isErr ? "⚠️" : "🛠️"} {label}</span>
      {onRetry && (
        <button
          onClick={onRetry}
          style={{
            padding: "4px 12px", borderRadius: 8,
            border: "1px solid var(--border)", background: "var(--surface-2)",
            cursor: "pointer", fontSize: 12, color: "var(--text)",
          }}
        >
          {t.chat.viewPageRetry}
        </button>
      )}
    </div>
  );
}
