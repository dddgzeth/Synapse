/**
 * DetailModal — centered floating modal for scene / memory detail.
 *
 * Opens via window event "synapse:open-detail" dispatched by sidebar rows.
 * Coexists with the chat view; backdrop dims the page behind it.
 *
 * Falls back to /scenes/[filename] and /memories/[id] routes for direct URL
 * access (right-click → open in new tab, deep linking, etc.).
 */
"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useI18n } from "./i18n";

type DetailRequest =
  | { kind: "scene"; filename: string }
  | { kind: "memory"; id: string };

interface ScenePayload {
  filename: string;
  title: string;
  summary: string;
  heat: number;
  created: string;
  updated: string;
  content: string;
}

interface MemoryRecord {
  id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  source_message_ids: string[];
  createdAt: string;
  updatedAt: string;
  sessionKey: string;
}

interface ConversationItem {
  record_id: string;
  role: string;
  content: string;
  sessionKey: string;
  recorded_at: string;
}

export function DetailModal() {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState<DetailRequest | null>(null);
  const [scene, setScene] = useState<ScenePayload | null>(null);
  const [memory, setMemory] = useState<{ memory: MemoryRecord; conversations: ConversationItem[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Listen for open requests
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<DetailRequest>).detail;
      if (!detail) return;
      setOpen(detail);
    };
    window.addEventListener("synapse:open-detail", handler);
    return () => window.removeEventListener("synapse:open-detail", handler);
  }, []);

  // Fetch when target changes
  useEffect(() => {
    if (!open) {
      setScene(null);
      setMemory(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    const url = open.kind === "scene"
      ? `/api/scene/${encodeURIComponent(open.filename)}`
      : `/api/memory/${encodeURIComponent(open.id)}`;
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (open.kind === "scene") {
          setScene(data);
          setMemory(null);
        } else {
          setMemory(data);
          setScene(null);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [open]);

  // ESC to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div
      onClick={() => setOpen(null)}
      style={{
        position: "fixed", inset: 0, zIndex: 100,
        background: "rgba(20, 20, 18, 0.45)",
        backdropFilter: "blur(2px)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: "40px 24px",
        animation: "synapse-fade-in 120ms ease-out",
      }}
    >
      <article
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(820px, 100%)",
          maxHeight: "85vh",
          overflowY: "auto",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          boxShadow: "0 24px 60px rgba(0,0,0,0.25)",
          fontFamily: "system-ui, sans-serif",
          color: "var(--text)",
        }}
      >
        <header style={{
          position: "sticky", top: 0,
          padding: "14px 22px",
          background: "var(--surface)",
          borderBottom: "1px solid var(--border)",
          display: "flex", justifyContent: "space-between", alignItems: "center",
          zIndex: 1,
        }}>
          <span style={{
            fontSize: 11, fontWeight: 700,
            color: "var(--accent)",
            textTransform: "uppercase", letterSpacing: 1.2,
          }}>
            {open.kind === "scene" ? t.details.sceneEyebrow : t.details.memoryEyebrow}
          </span>
          <button
            onClick={() => setOpen(null)}
            aria-label={t.common.close}
            style={{
              background: "transparent", border: "none",
              fontSize: 18, color: "var(--text-muted)",
              cursor: "pointer", padding: 4, lineHeight: 1,
            }}
          >✕</button>
        </header>

        <div style={{ padding: "20px 28px 28px" }}>
          {loading && <p style={mutedP}>{t.common.loading}</p>}
          {error && <p style={{ color: "#a01010", fontSize: 13 }}>{t.common.loadFailed}: {error}</p>}
          {scene && <SceneView scene={scene} locale={locale} />}
          {memory && <MemoryView memory={memory.memory} conversations={memory.conversations} locale={locale} />}
        </div>
      </article>

      <style jsx global>{`
        @keyframes synapse-fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>
    </div>
  );
}

function SceneView({ scene, locale }: { scene: ScenePayload; locale: string }) {
  const { t } = useI18n();
  return (
    <>
      <h2 style={h2}>{scene.title}</h2>
      {scene.summary && <p style={subtitle}>{scene.summary}</p>}
      <div style={metaRow}>
        <span style={pill}>🔥 {t.common.heat} {scene.heat}</span>
        {scene.updated && (
          <span style={pill}>{t.common.updatedAt} {new Date(scene.updated).toLocaleString(locale)}</span>
        )}
        <span style={{ ...pill, opacity: 0.7 }}>{scene.filename}</span>
      </div>
      <div className="prose" style={proseBox}>
        <ReactMarkdown>{scene.content}</ReactMarkdown>
      </div>
    </>
  );
}

function MemoryView({ memory, conversations, locale }: { memory: MemoryRecord; conversations: ConversationItem[]; locale: string }) {
  const { t } = useI18n();
  const typeLabel = (t.typeLabels as Record<string, string>)[memory.type] ?? memory.type;
  return (
    <>
      <h2 style={h2}>
        {typeLabel}
        <span style={{ fontSize: 14, color: "var(--text-muted)", fontWeight: 400, marginLeft: 10 }}>
          P{memory.priority}
        </span>
      </h2>
      {memory.scene_name && <p style={subtitle}>{memory.scene_name}</p>}
      <div style={metaRow}>
        <span style={pill}>{t.common.created} {new Date(memory.createdAt).toLocaleString(locale)}</span>
        <span style={pill}>{t.common.updated} {new Date(memory.updatedAt).toLocaleString(locale)}</span>
        <span style={{ ...pill, opacity: 0.7 }}>{memory.id}</span>
      </div>

      <div style={sectionLabel}>{t.details.l1Content}</div>
      <div style={{ whiteSpace: "pre-wrap", fontSize: 14.5, lineHeight: 1.75, marginBottom: 18 }}>
        {memory.content}
      </div>

      <div style={sectionLabel}>{t.details.l0Conversation(conversations.length)}</div>
      {conversations.length === 0 ? (
        <p style={mutedP}>{t.details.noL0}</p>
      ) : (
        conversations.map((c) => (
          <div key={c.record_id} style={l0Bubble(c.role === "user")}>
            <div style={l0Header}>
              <span style={{ fontWeight: 700, color: c.role === "user" ? "#3a6ea5" : "var(--accent)" }}>
                {c.role === "user" ? "User" : "Synapse"}
              </span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {new Date(c.recorded_at).toLocaleString(locale)}
              </span>
            </div>
            <div style={{ whiteSpace: "pre-wrap", fontSize: 13.5, lineHeight: 1.7 }}>
              {c.content}
            </div>
          </div>
        ))
      )}
    </>
  );
}

const h2: React.CSSProperties = { fontSize: 22, fontWeight: 700, margin: 0, color: "var(--text)" };
const subtitle: React.CSSProperties = { fontSize: 14, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.6 };
const metaRow: React.CSSProperties = { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14, marginBottom: 18 };
const pill: React.CSSProperties = {
  fontSize: 11, color: "var(--text-muted)",
  padding: "3px 8px", background: "var(--surface-2)",
  border: "1px solid var(--border)", borderRadius: 12,
};
const proseBox: React.CSSProperties = {
  background: "var(--surface-2)", border: "1px solid var(--border)",
  borderRadius: 10, padding: "16px 20px",
  fontSize: 14, lineHeight: 1.75,
};
const sectionLabel: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 700, color: "var(--text-muted)",
  textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8, marginTop: 12,
};
const mutedP: React.CSSProperties = { color: "var(--text-muted)", fontSize: 13 };
function l0Bubble(isUser: boolean): React.CSSProperties {
  return {
    marginBottom: 12, padding: "12px 14px",
    background: isUser ? "#eff4fb" : "var(--insight)",
    border: `1px solid ${isUser ? "#cdd9eb" : "var(--insight-border)"}`,
    borderRadius: 8,
  };
}
const l0Header: React.CSSProperties = {
  display: "flex", justifyContent: "space-between", alignItems: "center",
  marginBottom: 8, fontSize: 11,
};
