"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import type { FileUIPart, UIMessage } from "ai";
import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { MessageBubble } from "./message-bubble";
import { getSyncedFilesIndex, getSyncedFolderTrees } from "@/lib/synced-files-bus";
import { readSyncedFileContent } from "@/lib/synced-files";
import { getApiSettingsForRequest, useI18n } from "./i18n";

interface Props {
  sessionKey: string;
  onMemoryUpdate: () => void;
  /** Optional record_id (L0 message id) to scroll to after history loads. */
  scrollToRecordId?: string | null;
  /** Callback after a scroll-to-record has been honored. */
  onScrollHandled?: () => void;
}

interface AttachedFile {
  id: string;
  name: string;
  mediaType: string;
  url: string;
  isImage: boolean;
  textContent?: string;  // for text files — inlined into prompt on send
}

interface DeepResearchSource {
  title: string;
  url?: string;
  snippet?: string;
}

interface DeepResearchProgress {
  steps: string[];          // ⏳ / 🔍 / 📄 / ❌ — appended chronologically
  thinking: string;         // full thinking transcript, accumulated
  content: string;          // streamed final answer (echoed into message bubble)
  sources: DeepResearchSource[];
  loading: boolean;         // false once the stream ends (any reason)
  status: "running" | "done" | "aborted" | "error";
}

export function ChatPanel({ sessionKey, onMemoryUpdate, scrollToRecordId, onScrollHandled }: Props) {
  const { t, apiSettings, language } = useI18n();
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const [deepLoading, setDeepLoading] = useState(false);
  // DR progress (steps + thinking + sources) tracked OUTSIDE the message text so
  // it can be rendered as its own scrollable card. The map is keyed by the
  // assistant message id. Entry persists after `loading: false` so the user can
  // still scroll through the reasoning trace.
  const [drProgress, setDrProgress] = useState<Record<string, DeepResearchProgress>>({});
  // AbortController for the in-flight DR fetch — wired to the Stop button so
  // Deep Research can be cancelled the same way regular streaming can.
  const drAbortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);

  const transport = useMemo(
    () => new DefaultChatTransport({
      api: "/api/chat",
      // Injected per-call so syncedFilesIndex is fresh at each send.
      // syncedFilesIndex is metadata only (no file content).
      prepareSendMessagesRequest: ({ messages, id, body }) => ({
        body: {
          ...body,
          sessionKey,
          language,
          syncedFilesIndex: getSyncedFilesIndex(),
          apiSettings: getApiSettingsForRequest(apiSettings),
          messages,
          id,
        },
      }),
    }),
    [apiSettings, sessionKey],
  );

  const { messages, sendMessage, stop, status, setMessages, addToolResult } = useChat({
    transport,
    onFinish: () => { setTimeout(onMemoryUpdate, 1500); },
    // After a client-side tool result is appended, automatically POST a follow-up
    // turn so the server resumes the loop with the tool output. Without this the
    // assistant message stays empty after the first tool call.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    // Client-side tool execute. Server defines `read_synced_file` without an
    // `execute`, so AI SDK forwards the tool call here. We read the file from
    // the browser handle (text directly, PDF via pdfjs-dist), return text via
    // addToolResult. Content goes back to /api/chat in the tool_result message.
    onToolCall: async ({ toolCall }) => {
      if (toolCall.toolName !== "read_synced_file") return;
      try {
        const { path } = toolCall.input as { path: string };
        const trees = getSyncedFolderTrees();
        const r = await readSyncedFileContent(trees, path);
        const output = r.ok
          ? r.text + (r.truncated ? "" : `\n\n[file ${r.kind}, ${r.size}B, full content above]`)
          : `Error reading file: ${r.error}`;
        addToolResult({
          tool: "read_synced_file",
          toolCallId: toolCall.toolCallId,
          output,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        addToolResult({
          tool: "read_synced_file",
          toolCallId: toolCall.toolCallId,
          output: `Error: ${msg}`,
        });
      }
    },
  });

  const isStreaming = status === "streaming" || status === "submitted";
  const isLoading = isStreaming || deepLoading;

  // Scroll state: track whether user is near the bottom of the message list.
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const justSentRef = useRef(false);
  const isInitialLoadRef = useRef(true);

  const handleScrollContainer = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadHistory() {
      try {
        const resp = await fetch(`/api/chat/history?sessionKey=${encodeURIComponent(sessionKey)}&limit=1000`);
        if (!resp.ok) return;
        const data = await resp.json();
        if (cancelled || !Array.isArray(data.messages) || data.messages.length === 0) return;
        setMessages((current) => current.length === 0 ? data.messages as UIMessage[] : current);
      } catch (err) {
        console.error("[chat-panel] failed to load chat history:", err);
      }
    }
    loadHistory();
    return () => { cancelled = true; };
  }, [sessionKey, setMessages]);

  // Smart auto-scroll: only pull to bottom if the user is already near the bottom
  // or they just sent a message. Never interrupts manual upward scrolling.
  useEffect(() => {
    if (messages.length === 0) return;
    if (isInitialLoadRef.current) {
      // First batch of messages (history load or first reply) — snap instantly,
      // unless a specific record was requested (search jump handles its own scroll).
      if (!scrollToRecordId) {
        bottomRef.current?.scrollIntoView({ behavior: "instant" });
      }
      isInitialLoadRef.current = false;
      return;
    }
    if (justSentRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "instant" });
      justSentRef.current = false;
      return;
    }
    if (isAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, scrollToRecordId]);

  // Scroll to a specific message after history loads (search jump). Also flashes
  // the target so users see where they landed.
  useEffect(() => {
    if (!scrollToRecordId || messages.length === 0) return;
    const el = document.getElementById(`msg-${scrollToRecordId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.animate(
      [
        { background: "rgba(124, 110, 247, 0.18)" },
        { background: "rgba(124, 110, 247, 0)" },
      ],
      { duration: 1600, easing: "ease-out" },
    );
    onScrollHandled?.();
  }, [scrollToRecordId, messages, onScrollHandled]);

  // Auto-resize textarea — height only, never scrollbar
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }, [input]);

  // Sidebar dispatches `synapse:attach-file` when a file is clicked in the tree.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        name: string; shortName: string; mediaType: string;
        content: string; url: string; isImage: boolean;
      };
      setAttachments((prev) => {
        if (prev.some((a) => a.name === detail.name)) return prev;
        return [
          ...prev,
          {
            id: crypto.randomUUID(),
            name: detail.shortName,
            mediaType: detail.mediaType,
            url: detail.isImage ? detail.url : "",
            isImage: detail.isImage,
            textContent: detail.isImage ? undefined : detail.content,
          },
        ];
      });
      textareaRef.current?.focus();
    };
    window.addEventListener("synapse:attach-file", handler);
    return () => window.removeEventListener("synapse:attach-file", handler);
  }, []);

  async function handleSubmit() {
    const text = input.trim();
    if ((!text && attachments.length === 0) || isLoading) return;
    setInput("");
    const currentAttachments = attachments;
    setAttachments([]);

    // Images go as file parts (vision path). Text files get inlined into the prompt
    // so the model has the actual content instead of inventing tool calls.
    const imageAttachments = currentAttachments.filter((a) => a.isImage);
    const textAttachments = currentAttachments.filter((a) => !a.isImage && a.textContent);
    const files: FileUIPart[] = imageAttachments.map((a) => ({
      type: "file" as const,
      mediaType: a.mediaType,
      filename: a.name,
      url: a.url,
    }));

    let finalText = text;
    if (textAttachments.length > 0) {
      const blocks = textAttachments
        .map((a) => `<<<file: ${a.name}>>>\n${a.textContent}\n<<<end: ${a.name}>>>`)
        .join("\n\n");
      finalText = blocks + (text ? `\n\n${text}` : `\n\n${t.chat.filePrompt}`);
    }

    justSentRef.current = true;
    sendMessage({ text: finalText || " ", ...(files.length > 0 ? { files } : {}) });
  }

  /**
   * Deep Research path — same input box, same chat thread, but routes to
   * /api/insight (miromind native deep-research model) instead of /api/chat.
   *
   * Why this is separate from `handleSubmit`:
   *   1. Different upstream API + different streaming protocol (NDJSON, not SSE).
   *   2. We build chat history client-side so miromind sees the current thread.
   *   3. The progress UI lives in `drProgress` (its own scrollable card),
   *      not in the message text — so thinking can be a large scrollable area
   *      without bloating the bubble, and survives after `final`.
   */
  async function runDeepResearch() {
    const text = input.trim();
    if (!text || isLoading) return;
    setInput("");
    setAttachments([]);

    const userMsgId = `dr_u_${Date.now()}`;
    const asstMsgId = `dr_a_${Date.now() + 1}`;

    // Snapshot prior chat history BEFORE we push the new user msg.
    const history: Array<{ role: "user" | "assistant"; text: string }> = messages
      .filter((m): m is UIMessage & { role: "user" | "assistant" } => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, text: extractTextFromMessage(m) }))
      .filter((m) => m.text.trim().length > 0);

    justSentRef.current = true;
    setMessages((prev) => [
      ...prev,
      { id: userMsgId, role: "user", parts: [{ type: "text", text }] } as UIMessage,
      // Asst message body stays empty during DR — the scrollable progress card
      // (rendered above this message) carries the live state. When `final`
      // arrives we drop the final answer + references in here.
      { id: asstMsgId, role: "assistant", parts: [{ type: "text", text: "" }] } as UIMessage,
    ]);

    // Local mirrors of progress state — every event handler mutates these and
    // then commits to drProgress via the throttled `commit()`. This avoids
    // React batching surprises during rapid token bursts.
    const local: DeepResearchProgress = {
      steps: [],
      thinking: "",
      content: "",
      sources: [],
      loading: true,
      status: "running",
    };
    let lastCommit = 0;
    const commit = (force = false) => {
      const now = Date.now();
      if (!force && now - lastCommit < 33) return;
      lastCommit = now;
      setDrProgress((prev) => ({ ...prev, [asstMsgId]: { ...local } }));
    };

    // Seed the card immediately so the user sees activity before the first
    // upstream event arrives.
    commit(true);
    setDeepLoading(true);

    const ac = new AbortController();
    drAbortRef.current = ac;

    try {
      const resp = await fetch("/api/insight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: text,
          sessionKey,
          chatHistory: history,
          apiSettings: getApiSettingsForRequest(apiSettings),
        }),
        signal: ac.signal,
      });
      if (!resp.ok || !resp.body) {
        const errTxt = await resp.text().catch(() => `HTTP ${resp.status}`);
        local.steps.push(`❌ ${errTxt.slice(0, 200)}`);
        local.status = "error";
        commit(true);
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;
      while (!done) {
        const chunk = await reader.read();
        done = chunk.done;
        if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let evt: any;
          try { evt = JSON.parse(line); } catch { continue; }

          if (evt.type === "status") {
            local.steps.push(`⏳ ${evt.message}`);
            commit(true);
          } else if (evt.type === "thinking") {
            local.thinking += String(evt.delta ?? "");
            commit();
          } else if (evt.type === "content") {
            // Final answer streams here token-by-token — accumulate so the
            // user can watch the answer grow inside the message bubble.
            local.content += String(evt.delta ?? "");
            setMessages((prev) => prev.map((m) => m.id === asstMsgId
              ? { ...m, parts: [{ type: "text", text: local.content }] } as UIMessage
              : m,
            ));
          } else if (evt.type === "search") {
            const kws = Array.isArray(evt.keywords) ? evt.keywords.join(", ") : "";
            local.steps.push(`🔍 ${kws}${typeof evt.resultCount === "number" ? ` → ${evt.resultCount} ${t.chat.deepResults}` : ""}`);
            commit(true);
          } else if (evt.type === "fetch") {
            const url = String(evt.url ?? "");
            const short = url.length > 80 ? url.slice(0, 80) + "…" : url;
            local.steps.push(`📄 ${short}`);
            commit(true);
          } else if (evt.type === "final") {
            const sources = (evt.sources as Array<{ title: string; url?: string; snippet?: string }> | undefined) ?? [];
            local.sources = sources;
            local.status = "done";
            // Prefer the streamed content; fall back to the final-event text
            // (which carries `agent_summary` when no content tokens were sent).
            const finalAnswer = local.content || evt.text || "";
            const refList = sources.length > 0
              ? `\n\n---\n\n**${t.chat.references}**\n${sources.slice(0, 10).map((s, i) =>
                  `${i + 1}. [${s.title || s.url || "(untitled)"}](${s.url ?? "#"})`).join("\n")}`
              : "";
            const bubble = finalAnswer
              ? `${finalAnswer}${refList}`
              : `_${t.chat.deepNoFinal}_`;
            setMessages((prev) => prev.map((m) => m.id === asstMsgId
              ? { ...m, parts: [{ type: "text", text: bubble }] } as UIMessage
              : m,
            ));
            commit(true);
          } else if (evt.type === "error") {
            local.steps.push(`❌ ${evt.message}`);
            local.status = "error";
            commit(true);
          }
        }
      }
    } catch (e: any) {
      if (e?.name === "AbortError" || ac.signal.aborted) {
        local.steps.push(`✋ ${t.chat.deepAborted}`);
        local.status = "aborted";
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        local.steps.push(`❌ ${msg}`);
        local.status = "error";
      }
      commit(true);
    } finally {
      local.loading = false;
      commit(true);
      drAbortRef.current = null;
      setDeepLoading(false);
      setTimeout(onMemoryUpdate, 2000);
    }
  }

  /** Stop the in-flight stream — covers both regular chat and Deep Research. */
  function handleStop() {
    if (drAbortRef.current) drAbortRef.current.abort();
    stop();
  }

  const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // Collect candidate image files from BOTH `files` (the modern path used by
    // screenshot tools like Snipaste — files DataTransfer entries) AND `items`
    // (legacy path that some browsers populate for clipboard image blobs).
    // Filtering by only one of them silently drops valid pastes.
    const fromFiles = Array.from(e.clipboardData.files ?? []).filter((f) => f.type.startsWith("image/"));
    const fromItems = Array.from(e.clipboardData.items ?? [])
      .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
      .map((i) => i.getAsFile())
      .filter((f): f is File => !!f);
    // Dedup by (name|size|type) so we don't double-attach the same paste.
    const seen = new Set<string>();
    const candidates: File[] = [];
    for (const f of [...fromFiles, ...fromItems]) {
      const key = `${f.name}|${f.size}|${f.type}`;
      if (!seen.has(key)) { seen.add(key); candidates.push(f); }
    }
    if (candidates.length === 0) return;
    e.preventDefault();  // suppress default "paste binary garbage as text"
    for (const file of candidates) {
      const url = await readAsDataUrl(file);
      const ext = file.type.replace(/^image\//, "") || "png";
      setAttachments((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          name: file.name && file.name !== "image.png" ? file.name : `pasted-${Date.now()}.${ext}`,
          mediaType: file.type || "image/png",
          url,
          isImage: true,
        },
      ]);
    }
  }, []);

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    for (const file of Array.from(e.target.files ?? [])) {
      const isImage = file.type.startsWith("image/");
      if (isImage) {
        const url = await readAsDataUrl(file);
        setAttachments((prev) => [
          ...prev,
          { id: crypto.randomUUID(), name: file.name, mediaType: file.type, url, isImage: true },
        ]);
        continue;
      }
      // Try text-like first, then office-doc parsers.
      let textContent = "";
      const lower = file.name.toLowerCase();
      try {
        if (/\.(txt|md|tex|rst|csv|json|ya?ml)$/i.test(lower)) {
          textContent = await file.text();
        } else {
          const { classifyKind, parsePdfToText, parseDocxToText, parsePptxToText, parseXlsxToText } =
            await import("@/lib/synced-files");
          const kind = classifyKind(file.name);
          if (kind === "pdf") textContent = await parsePdfToText(file);
          else if (kind === "docx") textContent = await parseDocxToText(file);
          else if (kind === "pptx") textContent = await parsePptxToText(file);
          else if (kind === "xlsx") textContent = await parseXlsxToText(file);
        }
      } catch (err) {
        console.error("[chat-panel] parse failed:", err);
        textContent = `[failed to parse ${file.name}: ${err instanceof Error ? err.message : String(err)}]`;
      }
      setAttachments((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          name: file.name,
          mediaType: file.type || "application/octet-stream",
          url: "",
          isImage: false,
          textContent,
        },
      ]);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const canSend = (input.trim().length > 0 || attachments.length > 0) && !isLoading;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)" }}>
      {/* Messages */}
      <div ref={scrollContainerRef} onScroll={handleScrollContainer} className="scrollbar-thin" style={{ flex: 1, overflowY: "auto", padding: "24px 0" }}>
        {messages.length === 0 && <EmptyState />}
        {messages.map((m, idx) => {
          const dr = drProgress[m.id];
          return (
            <div key={m.id} id={`msg-${m.id}`}>
              {dr && <DeepResearchCard progress={dr} />}
              <MessageBubble
                message={m}
                streaming={isStreaming && idx === messages.length - 1 && m.role === "assistant"}
              />
            </div>
          );
        })}
        {isLoading && (
          <div style={{ padding: "8px 24px", display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ display: "flex", gap: 4 }}>
              {[0, 1, 2].map((i) => (
                <span key={i} style={{
                  display: "inline-block", width: 6, height: 6, borderRadius: "50%",
                  background: "var(--accent)",
                  animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
                }} />
              ))}
            </div>
            <span style={{ color: "var(--text-muted)", fontSize: 13 }}>
              {deepLoading ? t.chat.deepThinking : t.chat.thinking}
            </span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div style={{ borderTop: "1px solid var(--border)", background: "var(--bg)", padding: "12px 20px 16px" }}>
        {/* Attachment previews */}
        {attachments.length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            {attachments.map((a) => (
              <div key={a.id} style={{
                position: "relative",
                background: "var(--surface-2)", border: "1px solid var(--border)",
                borderRadius: 8, overflow: "hidden",
                display: "inline-flex", alignItems: "center",
                padding: a.isImage ? 0 : "4px 8px",
              }}>
                {a.isImage
                  ? <img src={a.url} alt={a.name} style={{ height: 60, maxWidth: 100, objectFit: "cover", display: "block" }} />
                  : <span style={{ fontSize: 12, color: "var(--text)", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>📄 {a.name}</span>
                }
                <button onClick={() => setAttachments((p) => p.filter((x) => x.id !== a.id))} style={{
                  position: "absolute", top: 2, right: 2,
                  width: 16, height: 16, borderRadius: "50%",
                  background: "rgba(0,0,0,0.45)", border: "none", color: "#fff",
                  cursor: "pointer", fontSize: 10, lineHeight: 1,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>×</button>
              </div>
            ))}
          </div>
        )}

        {/* Input box — Claude.ai style: textarea grows up, toolbar fixed at bottom */}
        <div style={{
          background: "var(--surface)",
          border: "1.5px solid var(--border)",
          borderRadius: 16,
          boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
          overflow: "hidden",
        }}>
          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={handlePaste}
            onCompositionStart={() => { isComposingRef.current = true; }}
            onCompositionEnd={() => { isComposingRef.current = false; }}
            onKeyDown={(e) => {
              const isComposing =
                isComposingRef.current ||
                e.nativeEvent.isComposing ||
                e.nativeEvent.keyCode === 229;
              if (e.key === "Enter" && !e.shiftKey && !isComposing) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder={t.chat.placeholder}
            rows={1}
            style={{
              display: "block", width: "100%",
              padding: "14px 16px 4px",
              background: "none", border: "none", outline: "none",
              color: "var(--text)", fontSize: 14, lineHeight: 1.65,
              fontFamily: "inherit",
              resize: "none", overflow: "auto",
              minHeight: 46, maxHeight: 200,
            }}
          />

          {/* Bottom toolbar */}
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "6px 10px 10px",
          }}>
            {/* Left: attach */}
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <IconBtn title={t.chat.attachTitle} onClick={() => fileInputRef.current?.click()}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
                </svg>
              </IconBtn>
              <input ref={fileInputRef} type="file" accept="image/*,.txt,.md,.pdf,.tex,.csv,.docx,.pptx,.xlsx,.xls,.json,.yaml,.yml,.rst" multiple style={{ display: "none" }} onChange={handleFileSelect} />
            </div>

            {/* Right: Deep Research + stop/send */}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <DeepResearchButton
                disabled={isLoading || input.trim().length === 0}
                onClick={runDeepResearch}
              />

              {isLoading ? (
                <button
                  onClick={handleStop}
                  style={{
                    padding: "5px 16px", borderRadius: 10,
                    border: "1.5px solid var(--border)",
                    background: "var(--surface)", color: "var(--text)",
                    fontSize: 13, fontWeight: 600, cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 6,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "var(--surface)")}
                >
                  <span style={{ width: 9, height: 9, background: "var(--text)", borderRadius: 2, flexShrink: 0 }} />
                  {t.chat.stop}
                </button>
              ) : (
                <button
                  onClick={handleSubmit}
                  disabled={!canSend}
                  style={{
                    padding: "5px 18px", borderRadius: 10, border: "none",
                    background: canSend ? "var(--accent)" : "var(--surface-2)",
                    color: canSend ? "#fff" : "var(--text-muted)",
                    fontSize: 13, fontWeight: 600,
                    cursor: canSend ? "pointer" : "not-allowed",
                    transition: "background 0.2s",
                  }}
                >
                  {t.chat.send}
                </button>
              )}
            </div>
          </div>
        </div>

        <div style={{ textAlign: "center", marginTop: 6, fontSize: 11, color: "var(--text-muted)", opacity: 0.7 }}>
          {t.chat.hint}
        </div>
      </div>

    </div>
  );
}

function IconBtn({ children, title, onClick }: { children: React.ReactNode; title: string; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: 6, background: "none", border: "none", borderRadius: 6, cursor: "pointer",
        color: hover ? "var(--accent)" : "var(--text-muted)",
        display: "flex", alignItems: "center", transition: "color 0.15s",
      }}
    >
      {children}
    </button>
  );
}

function EmptyState() {
  const { t } = useI18n();
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      height: "100%", minHeight: 400, padding: 48,
    }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo-vertical.png" alt="Synapse" style={{ height: 160, width: "auto", mixBlendMode: "multiply", marginBottom: 24 }} />
      <div style={{ fontSize: 14, color: "var(--text-muted)", lineHeight: 1.9, textAlign: "center", maxWidth: 720, marginBottom: 32 }}>
        {t.chat.emptyCopy.split("\n").map((line, idx) => (
          <span key={line}>
            {idx > 0 && <br />}
            {line}
          </span>
        ))}
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}>
        {t.chat.cards.map(({ icon, label, desc }) => (
          <div key={label} style={{
            padding: "14px 18px", background: "var(--surface)", border: "1px solid var(--border)",
            borderRadius: 12, width: 148, textAlign: "center",
          }}>
            <div style={{ fontSize: 24, marginBottom: 6 }}>{icon}</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>{label}</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>{desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────
// Deep Research button — sends the current input as a research query, with
// chat history attached. Rich hover tooltip explains what it does.
// ────────────────────────────────────────────

function DeepResearchButton({
  disabled, onClick,
}: { disabled: boolean; onClick: () => void }) {
  const { t } = useI18n();
  const btnRef = useRef<HTMLButtonElement>(null);
  // Tooltip uses position:fixed (rendered at the viewport level) so it escapes
  // the input container's overflow:hidden, which was clipping the absolute-
  // positioned variant. Coords are recomputed every time the button is hovered.
  const [tipPos, setTipPos] = useState<{ top: number; right: number } | null>(null);

  function show() {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTipPos({
      top: Math.max(8, rect.top - 8),                  // 8px above the button, never above viewport
      right: Math.max(8, window.innerWidth - rect.right), // align right edge to button
    });
  }
  function hide() { setTipPos(null); }

  return (
    <>
      <button
        ref={btnRef}
        onClick={onClick}
        disabled={disabled}
        onMouseEnter={(e) => {
          if (!disabled) e.currentTarget.style.background = "var(--insight)";
          show();
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "var(--surface-2)";
          hide();
        }}
        onFocus={show}
        onBlur={hide}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "5px 12px", borderRadius: 8,
          cursor: disabled ? "not-allowed" : "pointer",
          fontSize: 12, fontWeight: 600,
          border: "1px solid var(--border)",
          background: "var(--surface-2)",
          color: disabled ? "var(--text-muted)" : "var(--accent)",
          opacity: disabled ? 0.5 : 1,
          transition: "background 0.15s",
        }}
      >
        ⚡ Deep Research
      </button>
      {tipPos && (
        <div style={{
          position: "fixed",
          top: tipPos.top,
          right: tipPos.right,
          transform: "translateY(-100%)",
          width: 320, padding: "10px 12px",
          background: "var(--text)", color: "#fff",
          borderRadius: 10, fontSize: 12, lineHeight: 1.55,
          boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
          zIndex: 1000, pointerEvents: "none",
        }}>
          <div style={{ fontWeight: 700, marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
            <span>⚡</span><span>Deep Research</span>
          </div>
          <div style={{ opacity: 0.92 }}>{t.chat.deepDescription}</div>
          {disabled && (
            <div style={{ marginTop: 6, opacity: 0.65 }}>{t.chat.deepEmptyHint}</div>
          )}
        </div>
      )}
    </>
  );
}

/** Best-effort text extraction from a UIMessage for chat-history injection. */
function extractTextFromMessage(m: UIMessage): string {
  const anyMsg = m as any;
  if (Array.isArray(anyMsg.parts)) {
    return anyMsg.parts
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("\n");
  }
  if (typeof anyMsg.content === "string") return anyMsg.content;
  return "";
}

// ────────────────────────────────────────────
// Deep Research progress card — scrollable thinking + step chips.
//
// Rendered ABOVE the assistant message bubble. Stays visible after the run
// finishes so the user can scroll back through the reasoning trace.
//
// Thinking box auto-scrolls to bottom WHILE the user is at the bottom (so
// live tokens stay visible), but stops auto-scrolling if the user manually
// scrolls up — standard "tail -f" behavior.
// ────────────────────────────────────────────

function DeepResearchCard({ progress }: { progress: DeepResearchProgress }) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const thinkRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // Track whether user is near the bottom of the thinking pane.
  function handleScroll() {
    const el = thinkRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }

  // Auto-stick to bottom while thinking grows and user hasn't scrolled away.
  useEffect(() => {
    if (!stickRef.current) return;
    const el = thinkRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [progress.thinking]);

  const statusBadge = (() => {
    switch (progress.status) {
      case "running": return { dot: "●", color: "var(--accent)", pulse: true };
      case "done":    return { dot: "✓", color: "var(--accent)", pulse: false };
      case "aborted": return { dot: "✋", color: "var(--text-muted)", pulse: false };
      case "error":   return { dot: "✗", color: "#a01010", pulse: false };
    }
  })();

  return (
    <div style={{ padding: "0 24px", marginBottom: 8 }}>
      <div style={{
        maxWidth: "80%",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        overflow: "hidden",
        fontSize: 13,
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
      }}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "8px 12px",
          background: "var(--surface-2)",
          borderBottom: collapsed ? "none" : "1px solid var(--border)",
        }}>
          <span style={{
            color: statusBadge.color, fontSize: 12, width: 14,
            display: "inline-flex", justifyContent: "center",
            animation: statusBadge.pulse ? "pulse 1.4s ease-in-out infinite" : "none",
          }}>{statusBadge.dot}</span>
          <span style={{ fontWeight: 700, color: "var(--text)" }}>⚡ Deep Research</span>
          <span style={{ color: "var(--text-muted)", fontSize: 12, marginLeft: 4 }}>
            · {progress.steps.length} {t.chat.deepSteps}
          </span>
          <button
            onClick={() => setCollapsed((v) => !v)}
            style={{
              marginLeft: "auto",
              background: "none", border: "none", cursor: "pointer",
              color: "var(--text-muted)", fontSize: 12,
              padding: "2px 6px",
            }}
          >
            {collapsed ? t.chat.deepExpand : t.chat.deepCollapse} {collapsed ? "▸" : "▾"}
          </button>
        </div>

        {!collapsed && (
          <>
            {/* Steps */}
            {progress.steps.length > 0 && (
              <div style={{
                padding: "8px 12px",
                borderBottom: progress.thinking ? "1px solid var(--border)" : "none",
                display: "flex", flexDirection: "column", gap: 4,
                fontSize: 12.5, color: "var(--text)",
              }}>
                {progress.steps.map((s, i) => (
                  <div key={i} style={{
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>{s}</div>
                ))}
              </div>
            )}

            {/* Thinking — fixed height, scrollable, full content preserved */}
            {progress.thinking && (
              <div style={{ padding: "8px 12px" }}>
                <div style={{
                  fontSize: 11, fontWeight: 600,
                  color: "var(--text-muted)",
                  marginBottom: 6,
                }}>
                  {t.chat.deepThinkingLabel}
                </div>
                <div
                  ref={thinkRef}
                  onScroll={handleScroll}
                  className="scrollbar-thin"
                  style={{
                    maxHeight: 260,
                    overflowY: "auto",
                    padding: "8px 10px",
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    fontSize: 12,
                    lineHeight: 1.55,
                    color: "var(--text)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  }}
                >
                  {progress.thinking}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
