/**
 * /scenes/[filename] — L2 detail page: full scene markdown rendered.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import ReactMarkdown from "react-markdown";

interface ScenePayload {
  filename: string;
  title: string;
  summary: string;
  heat: number;
  created: string;
  updated: string;
  content: string;
}

export default function SceneDetailPage() {
  const params = useParams<{ filename: string }>();
  const filename = decodeURIComponent(params.filename);
  const [scene, setScene] = useState<ScenePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/scene/${encodeURIComponent(filename)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setScene)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [filename]);

  return (
    <main style={pageWrap}>
      <Link href="/" style={backLink}>← 返回对话</Link>

      <header style={{ marginBottom: 18 }}>
        <div style={eyebrow}>L2 · 主题场景</div>
        <h1 style={h1}>{scene?.title ?? filename.replace(/\.md$/, "")}</h1>
        {scene?.summary && (
          <p style={subtitle}>{scene.summary}</p>
        )}
        {scene && (
          <div style={metaRow}>
            <span style={pill}>🔥 热度 {scene.heat}</span>
            {scene.updated && (
              <span style={pill}>更新于 {new Date(scene.updated).toLocaleString("zh-CN")}</span>
            )}
            <span style={{ ...pill, opacity: 0.7 }}>{scene.filename}</span>
          </div>
        )}
      </header>

      <article style={card} className="prose">
        {loading && <p style={{ color: "var(--text-muted)" }}>加载中…</p>}
        {error && <p style={{ color: "#a01010" }}>加载失败：{error}</p>}
        {scene && <ReactMarkdown>{scene.content}</ReactMarkdown>}
      </article>
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
  borderRadius: 12, padding: "26px 32px", fontSize: 15,
  lineHeight: 1.75, color: "var(--text)",
};
