/**
 * /memories/[id] — L1 detail page: one memory record + its L0 source messages.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useI18n } from "@/components/i18n";

interface MemoryRecord {
  id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  source_message_ids: string[];
  metadata: Record<string, unknown>;
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

interface Payload {
  memory: MemoryRecord;
  conversations: ConversationItem[];
}

export default function MemoryDetailPage() {
  const { t, locale } = useI18n();
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params.id);
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/memory/${encodeURIComponent(id)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [id]);

  return (
    <main style={pageWrap}>
      <Link href="/app" style={backLink}>{t.common.backToChat}</Link>

      <header style={{ marginBottom: 18 }}>
        <div style={eyebrow}>{t.details.memoryEyebrow}</div>
        <h1 style={h1}>
          {data ? ((t.typeLabels as Record<string, string>)[data.memory.type] ?? data.memory.type) : t.details.memoryFallback}
          <span style={{ fontSize: 14, color: "var(--text-muted)", fontWeight: 400, marginLeft: 10 }}>
            {data && `P${data.memory.priority}`}
          </span>
        </h1>
        {data?.memory.scene_name && (
          <p style={subtitle}>{data.memory.scene_name}</p>
        )}
        {data && (
          <div style={metaRow}>
            <span style={pill}>{t.common.created} {new Date(data.memory.createdAt).toLocaleString(locale)}</span>
            <span style={pill}>{t.common.updated} {new Date(data.memory.updatedAt).toLocaleString(locale)}</span>
            <span style={{ ...pill, opacity: 0.7 }}>{data.memory.id}</span>
          </div>
        )}
      </header>

      <section style={card}>
        <div style={sectionLabel}>{t.details.l1Content}</div>
        {loading && <p style={{ color: "var(--text-muted)" }}>{t.common.loading}</p>}
        {error && <p style={{ color: "#a01010" }}>{t.common.loadFailed}: {error}</p>}
        {data && (
          <div style={{ whiteSpace: "pre-wrap", fontSize: 14.5, lineHeight: 1.75 }}>
            {data.memory.content}
          </div>
        )}
      </section>

      {data && (
        <section style={{ ...card, marginTop: 18 }}>
          <div style={sectionLabel}>{t.details.l0Conversation(data.conversations.length)}</div>
          {data.conversations.length === 0 ? (
            <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
              {t.details.noL0}
            </p>
          ) : (
            data.conversations.map((c) => (
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
        </section>
      )}
    </main>
  );
}

const pageWrap: React.CSSProperties = {
  maxWidth: 820, margin: "0 auto", padding: "32px 28px 60px",
  fontFamily: "system-ui, sans-serif",
  color: "var(--text)",
};
const backLink: React.CSSProperties = {
  display: "inline-block", marginBottom: 18, fontSize: 13,
  color: "var(--accent)", textDecoration: "none", fontWeight: 600,
};
const eyebrow: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "var(--accent)",
  textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 4,
};
const h1: React.CSSProperties = {
  fontSize: 26, fontWeight: 700, margin: 0, color: "var(--text)",
};
const subtitle: React.CSSProperties = {
  fontSize: 14, color: "var(--text-muted)", marginTop: 6,
  lineHeight: 1.6, maxWidth: 720,
};
const metaRow: React.CSSProperties = {
  display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14,
};
const pill: React.CSSProperties = {
  fontSize: 11, color: "var(--text-muted)",
  padding: "3px 8px", background: "var(--surface-2)",
  border: "1px solid var(--border)", borderRadius: 12,
};
const card: React.CSSProperties = {
  background: "var(--surface)", border: "1px solid var(--border)",
  borderRadius: 12, padding: "20px 26px",
};
const sectionLabel: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 700, color: "var(--text-muted)",
  textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 12,
};
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
