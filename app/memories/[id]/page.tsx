/**
 * /memories/[id] — L1 detail page: one memory record + its L0 source messages.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

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

const TYPE_LABEL: Record<string, string> = {
  claim: "观点", method: "方法", observation: "观察",
  dataset: "数据集", experiment: "实验", finding: "发现",
  question: "问题", goal: "目标",
};

export default function MemoryDetailPage() {
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
      <Link href="/" style={backLink}>← 返回对话</Link>

      <header style={{ marginBottom: 18 }}>
        <div style={eyebrow}>L1 · 单条记忆</div>
        <h1 style={h1}>
          {data ? (TYPE_LABEL[data.memory.type] ?? data.memory.type) : "记忆"}
          <span style={{ fontSize: 14, color: "var(--text-muted)", fontWeight: 400, marginLeft: 10 }}>
            {data && `P${data.memory.priority}`}
          </span>
        </h1>
        {data?.memory.scene_name && (
          <p style={subtitle}>{data.memory.scene_name}</p>
        )}
        {data && (
          <div style={metaRow}>
            <span style={pill}>创建 {new Date(data.memory.createdAt).toLocaleString("zh-CN")}</span>
            <span style={pill}>更新 {new Date(data.memory.updatedAt).toLocaleString("zh-CN")}</span>
            <span style={{ ...pill, opacity: 0.7 }}>{data.memory.id}</span>
          </div>
        )}
      </header>

      <section style={card}>
        <div style={sectionLabel}>L1 内容</div>
        {loading && <p style={{ color: "var(--text-muted)" }}>加载中…</p>}
        {error && <p style={{ color: "#a01010" }}>加载失败：{error}</p>}
        {data && (
          <div style={{ whiteSpace: "pre-wrap", fontSize: 14.5, lineHeight: 1.75 }}>
            {data.memory.content}
          </div>
        )}
      </section>

      {data && (
        <section style={{ ...card, marginTop: 18 }}>
          <div style={sectionLabel}>原始对话 (L0 · {data.conversations.length} 条)</div>
          {data.conversations.length === 0 ? (
            <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
              （这条记忆没有可关联的 L0 原始消息）
            </p>
          ) : (
            data.conversations.map((c) => (
              <div key={c.record_id} style={l0Bubble(c.role === "user")}>
                <div style={l0Header}>
                  <span style={{ fontWeight: 700, color: c.role === "user" ? "#3a6ea5" : "var(--accent)" }}>
                    {c.role === "user" ? "User" : "Synapse"}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    {new Date(c.recorded_at).toLocaleString("zh-CN")}
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
