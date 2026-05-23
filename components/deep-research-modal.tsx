"use client";

import { useState } from "react";

interface Props {
  sessionKey: string;
  onClose: () => void;
  onResult: (result: string) => void;
}

export function DeepResearchModal({ sessionKey, onClose, onResult }: Props) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSearch() {
    if (!query.trim() || loading) return;
    setLoading(true);
    setError(null);

    try {
      const resp = await fetch("/api/insight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, sessionKey }),
      });

      const data = await resp.json();
      if (!resp.ok || data.error) {
        setError(data.error ?? "搜索失败");
        return;
      }

      const resultText = formatResearchResult(data);
      onResult(resultText);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "网络错误");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 100,
    }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div style={{
        background: "var(--surface)", border: "1px solid var(--border)",
        borderRadius: 16, padding: 28, width: 520, maxWidth: "90vw",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text)" }}>⚡ Deep Research</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
              搜索 Semantic Scholar + arXiv
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 20 }}
          >
            ×
          </button>
        </div>

        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSearch();
          }}
          placeholder="输入研究问题，Synapse 将结合你的研究背景搜索外部文献..."
          rows={4}
          style={{
            width: "100%", padding: "12px 14px",
            background: "var(--surface-2)", border: "1px solid var(--border)",
            borderRadius: 8, color: "var(--text)", fontSize: 14,
            resize: "none", outline: "none", fontFamily: "inherit", lineHeight: 1.6,
          }}
        />

        {error && (
          <div style={{ color: "#f55b5b", fontSize: 12, marginTop: 8 }}>{error}</div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            style={{
              padding: "9px 18px", background: "var(--surface-2)",
              border: "1px solid var(--border)", borderRadius: 8,
              color: "var(--text-muted)", cursor: "pointer", fontSize: 14,
            }}
          >
            取消
          </button>
          <button
            onClick={handleSearch}
            disabled={loading || !query.trim()}
            style={{
              padding: "9px 24px",
              background: loading || !query.trim() ? "var(--surface-2)" : "var(--accent)",
              border: "none", borderRadius: 8,
              color: loading || !query.trim() ? "var(--text-muted)" : "#fff",
              cursor: loading || !query.trim() ? "not-allowed" : "pointer",
              fontSize: 14, fontWeight: 600,
            }}
          >
            {loading ? "搜索中..." : "搜索 (⌘↵)"}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatResearchResult(data: { result: string; sources?: Array<{ title: string; source: string; year?: number }> }): string {
  let text = data.result;

  if (data.sources && data.sources.length > 0) {
    const sourceList = data.sources
      .slice(0, 6)
      .map((s, i) => `${i + 1}. **${s.title}** (${s.source}${s.year ? `, ${s.year}` : ""})`)
      .join("\n");
    text += `\n\n---\n\n**参考文献**\n${sourceList}`;
  }

  return text;
}
