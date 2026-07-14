"use client";

/**
 * /tools/[source]/[project] — read-only browser for one external tool's
 * conversations (Claude Code / Codex / …), archived via MCP. No input box.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useI18n } from "@/components/i18n";

interface Msg {
  id: string;
  role: string;
  content: string;
  sessionId: string;
  recordedAt: string;
}

export default function ToolConversationPage() {
  const { t } = useI18n();
  const params = useParams<{ source: string; project: string }>();
  const search = useSearchParams();
  const source = decodeURIComponent(params.source);
  const project = decodeURIComponent(params.project);
  const session = search.get("session") ?? undefined;
  const record = search.get("record") ?? undefined;

  const [messages, setMessages] = useState<Msg[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const qs = new URLSearchParams({ source, project });
    if (session) qs.set("session", session);
    fetch(`/api/tools/messages?${qs.toString()}`)
      .then((r) => r.json())
      .then((j) => setMessages(j.messages ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [source, project, session]);

  // After the archive renders, scroll to + briefly flash the message a search
  // hit pointed at (via ?record=<id>).
  useEffect(() => {
    if (!record || loading || messages.length === 0) return;
    const el = document.getElementById(`msg-${record}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.style.transition = "background 0.4s";
    const prev = el.style.background;
    el.style.background = "rgba(245,197,126,0.28)";
    const timer = setTimeout(() => { el.style.background = prev; }, 1800);
    return () => clearTimeout(timer);
  }, [record, loading, messages]);

  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: "28px 24px 80px" }}>
      <Link href="/app" style={{ fontSize: 13, color: "var(--text-muted)", textDecoration: "none" }}>
        ← {t.common.backToChat}
      </Link>

      <header style={{ margin: "18px 0 22px", display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>
          {sourceLabel(source)}{project ? ` / ${project}` : ""}
        </h1>
        <span style={{
          fontSize: 11, fontWeight: 700, color: "var(--text-muted)",
          border: "1px solid var(--border)", borderRadius: 6, padding: "2px 8px",
        }}>
          {t.tools.readOnlyArchive} · {messages.length}
        </span>
      </header>

      {loading ? (
        <div style={{ color: "var(--text-muted)", fontSize: 14 }}>{t.common.loading}</div>
      ) : messages.length === 0 ? (
        <div style={{ color: "var(--text-muted)", fontSize: 14 }}>{t.tools.empty}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {messages.map((m) => (
            <div key={m.id} id={`msg-${m.id}`} style={{ display: "flex", flexDirection: "column", alignItems: m.role === "user" ? "flex-end" : "flex-start", borderRadius: 14 }}>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
                {m.role === "user" ? t.tools.you : "AI"} · {new Date(m.recordedAt).toLocaleString()}
              </div>
              <div style={{
                maxWidth: "88%",
                minWidth: 0,
                background: m.role === "user" ? "var(--user-bubble)" : "var(--surface)",
                color: m.role === "user" ? "var(--user-bubble-text)" : "var(--text)",
                border: m.role === "user" ? "none" : "1px solid var(--border)",
                borderRadius: 14, padding: "10px 14px", fontSize: 14, lineHeight: 1.6,
                overflowWrap: "anywhere", wordBreak: "break-word",
                // pre-wrap is for the raw-text user branch below (preserves the
                // literal line breaks the user typed). The AI branch renders
                // actual Markdown, which already gets its own line breaks from
                // <p>/<li> — forcing pre-wrap on top of that fights with how
                // long inline code/paths wrap and was pushing them past the
                // bubble edge instead of breaking.
                whiteSpace: m.role === "user" ? "pre-wrap" : "normal",
              }}>
                {m.role === "user"
                  ? m.content
                  : <div className="md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown></div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

function sourceLabel(source: string): string {
  const map: Record<string, string> = {
    "claude-code": "Claude Code",
    codex: "Codex",
    cursor: "Cursor",
    mcp: "MCP",
  };
  return map[source] ?? source;
}
