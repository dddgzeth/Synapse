"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { FileUIPart, UIMessage } from "ai";
import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { MessageBubble } from "./message-bubble";
import { getSyncedFilesIndex, getSyncedFolderTrees } from "@/lib/synced-files-bus";
import { readSyncedFileContent } from "@/lib/synced-files";

interface Props {
  sessionKey: string;
  onMemoryUpdate: () => void;
}

interface AttachedFile {
  id: string;
  name: string;
  mediaType: string;
  url: string;
  isImage: boolean;
  textContent?: string;  // for text files — inlined into prompt on send
}

export function ChatPanel({ sessionKey, onMemoryUpdate }: Props) {
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const [showDeepResearch, setShowDeepResearch] = useState(false);
  const [deepLoading, setDeepLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const transport = useMemo(
    () => new DefaultChatTransport({
      api: "/api/chat",
      // Injected per-call so syncedFilesIndex is fresh at each send.
      // syncedFilesIndex is metadata only (no file content).
      prepareSendMessagesRequest: ({ messages, id, body }) => ({
        body: {
          ...body,
          sessionKey,
          syncedFilesIndex: getSyncedFilesIndex(),
          messages,
          id,
        },
      }),
    }),
    [sessionKey],
  );

  const { messages, sendMessage, stop, status, setMessages, addToolResult } = useChat({
    transport,
    onFinish: () => { setTimeout(onMemoryUpdate, 1500); },
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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
        .map((a) => `<<<文件: ${a.name}>>>\n${a.textContent}\n<<<结束: ${a.name}>>>`)
        .join("\n\n");
      finalText = blocks + (text ? `\n\n${text}` : "\n\n请基于以上文件回答。");
    }

    sendMessage({ text: finalText || " ", ...(files.length > 0 ? { files } : {}) });
  }

  const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageItems = Array.from(e.clipboardData.items).filter((i) => i.type.startsWith("image/"));
    if (imageItems.length === 0) return;
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;
      const url = await readAsDataUrl(file);
      setAttachments((prev) => [
        ...prev,
        { id: crypto.randomUUID(), name: "image.png", mediaType: item.type, url, isImage: true },
      ]);
    }
  }, []);

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    for (const file of Array.from(e.target.files ?? [])) {
      const url = await readAsDataUrl(file);
      setAttachments((prev) => [
        ...prev,
        { id: crypto.randomUUID(), name: file.name, mediaType: file.type || "application/octet-stream", url, isImage: file.type.startsWith("image/") },
      ]);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const canSend = (input.trim().length > 0 || attachments.length > 0) && !isLoading;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)" }}>
      {/* Messages */}
      <div className="scrollbar-thin" style={{ flex: 1, overflowY: "auto", padding: "24px 0" }}>
        {messages.length === 0 && <EmptyState />}
        {messages.map((m) => <MessageBubble key={m.id} message={m} />)}
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
              {deepLoading ? "正在联网搜索分析…" : "Synapse 正在思考…"}
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
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
            }}
            placeholder="输入任何问题，或粘贴图片…"
            rows={1}
            style={{
              display: "block", width: "100%",
              padding: "14px 16px 4px",
              background: "none", border: "none", outline: "none",
              color: "var(--text)", fontSize: 14, lineHeight: 1.65,
              fontFamily: "inherit",
              resize: "none", overflow: "hidden",
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
              <IconBtn title="附加文件或图片" onClick={() => fileInputRef.current?.click()}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
                </svg>
              </IconBtn>
              <input ref={fileInputRef} type="file" accept="image/*,.txt,.md,.pdf,.tex,.csv" multiple style={{ display: "none" }} onChange={handleFileSelect} />
            </div>

            {/* Right: Deep Research + stop/send */}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                onClick={() => setShowDeepResearch(true)}
                disabled={isLoading}
                title="用深度研究模型搜索 Semantic Scholar + arXiv 学术数据库"
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "5px 12px", borderRadius: 8, cursor: isLoading ? "not-allowed" : "pointer",
                  fontSize: 12, fontWeight: 600,
                  border: "1px solid var(--border)",
                  background: "var(--surface-2)",
                  color: isLoading ? "var(--text-muted)" : "var(--accent)",
                  opacity: isLoading ? 0.5 : 1,
                  transition: "background 0.15s",
                }}
                onMouseEnter={(e) => { if (!isLoading) e.currentTarget.style.background = "var(--insight)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "var(--surface-2)"; }}
              >
                ⚡ Deep Research
              </button>

              {isStreaming ? (
                <button
                  onClick={() => stop()}
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
                  停止
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
                  发送
                </button>
              )}
            </div>
          </div>
        </div>

        <div style={{ textAlign: "center", marginTop: 6, fontSize: 11, color: "var(--text-muted)", opacity: 0.7 }}>
          Enter 发送 · Shift+Enter 换行 · 可直接粘贴图片
        </div>
      </div>

      {/* Deep Research Panel */}
      {showDeepResearch && (
        <DeepResearchPanel
          sessionKey={sessionKey}
          onClose={() => setShowDeepResearch(false)}
          onResult={(result) => {
            setMessages((prev) => [
              ...prev,
              { id: `dr_${Date.now()}`, role: "assistant" as const, parts: [{ type: "text" as const, text: result }] },
            ]);
            setTimeout(onMemoryUpdate, 2000);
          }}
        />
      )}
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
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      height: "100%", minHeight: 400, padding: 48,
    }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo-vertical.png" alt="Synapse" style={{ height: 160, width: "auto", mixBlendMode: "multiply", marginBottom: 24 }} />
      <div style={{ fontSize: 14, color: "var(--text-muted)", lineHeight: 1.9, textAlign: "center", maxWidth: 460, marginBottom: 32 }}>
        Synapse 记住你所有的对话，随时间积累工作上下文，
        <br />在你没注意到的地方，悄悄发现规律与联系。
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}>
        {[
          { icon: "💬", label: "直接对话", desc: "提问、讨论、整理想法" },
          { icon: "📁", label: "上传文件", desc: "同步本地文档或笔记" },
          { icon: "🌐", label: "联网分析", desc: "搜索外部文献，深度研读" },
        ].map(({ icon, label, desc }) => (
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
// Deep Research Panel
// ────────────────────────────────────────────

function DeepResearchPanel({
  sessionKey,
  onClose,
  onResult,
}: {
  sessionKey: string;
  onClose: () => void;
  onResult: (text: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  async function run() {
    if (!query.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch("/api/insight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query.trim(), sessionKey }),
      });
      const data = await resp.json();
      if (!resp.ok || data.error) { setError(data.error ?? "搜索失败"); return; }
      const sources = data.sources as Array<{ title: string; source: string; year?: number }> | undefined;
      let text = data.result as string;
      if (sources && sources.length > 0) {
        const list = sources.slice(0, 6)
          .map((s, i) => `${i + 1}. **${s.title}** (${s.source}${s.year ? `, ${s.year}` : ""})`)
          .join("\n");
        text += `\n\n---\n\n**参考来源**\n${list}`;
      }
      onResult(text);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "网络错误");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)",
      display: "flex", alignItems: "flex-end", justifyContent: "center",
      zIndex: 100, padding: "0 0 80px",
    }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div style={{
        width: 600, maxWidth: "92vw",
        background: "var(--surface)", borderRadius: 18,
        border: "1px solid var(--border)",
        boxShadow: "0 8px 40px rgba(0,0,0,0.14)",
        overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{
          padding: "16px 20px 12px",
          borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "flex-start", justifyContent: "space-between",
        }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
              <span style={{ fontSize: 16 }}>⚡</span>
              <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>Deep Research</span>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              使用专属深度研究模型，自动检索 <strong>Semantic Scholar</strong> + <strong>arXiv</strong> 学术数据库，
              结合你的记忆上下文综合分析。
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 20, lineHeight: 1, padding: 0, marginLeft: 12 }}>×</button>
        </div>

        {/* Input */}
        <div style={{ padding: "14px 20px" }}>
          <textarea
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run(); }}
            placeholder="输入你想深度分析的问题…"
            rows={3}
            style={{
              width: "100%", padding: "10px 12px",
              background: "var(--surface-2)", border: "1px solid var(--border)",
              borderRadius: 10, color: "var(--text)", fontSize: 14,
              resize: "none", outline: "none", fontFamily: "inherit", lineHeight: 1.6,
              boxSizing: "border-box",
            }}
          />
          {error && <div style={{ color: "#EF4444", fontSize: 12, marginTop: 6 }}>{error}</div>}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>⌘↵ 搜索</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={onClose} style={{ padding: "7px 16px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface-2)", color: "var(--text-muted)", fontSize: 13, cursor: "pointer" }}>取消</button>
              <button
                onClick={run}
                disabled={loading || !query.trim()}
                style={{
                  padding: "7px 20px", borderRadius: 8, border: "none",
                  background: loading || !query.trim() ? "var(--surface-2)" : "var(--accent)",
                  color: loading || !query.trim() ? "var(--text-muted)" : "#fff",
                  fontSize: 13, fontWeight: 600,
                  cursor: loading || !query.trim() ? "not-allowed" : "pointer",
                }}
              >
                {loading ? "搜索分析中…" : "开始搜索"}
              </button>
            </div>
          </div>
        </div>
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
