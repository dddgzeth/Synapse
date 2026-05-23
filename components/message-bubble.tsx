"use client";

import ReactMarkdown from "react-markdown";
import { useState } from "react";
import type { UIMessage } from "ai";
import { EvidenceGraph, type AhaPayload, type EvidenceData, type SelectedDetail } from "./evidence-graph";
import { EvidenceDrawer } from "./evidence-drawer";

interface Props {
  message: UIMessage;
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

export function MessageBubble({ message }: Props) {
  const isUser = message.role === "user";
  const fullText = extractText(message);
  const images = isUser ? extractImages(message) : [];
  const { mainContent, ahaInsight } = parseAha(fullText);
  const hasText = mainContent.replace(/\s/g, "").length > 0;

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

      <div style={{ maxWidth: "80%", display: "flex", flexDirection: "column", gap: 6, alignItems: isUser ? "flex-end" : "flex-start" }}>
        {/* Image attachments */}
        {images.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {images.map((img, i) => (
              <img
                key={i}
                src={img.url}
                alt={img.filename ?? "image"}
                style={{
                  maxWidth: 240, maxHeight: 240, borderRadius: 10,
                  border: "1px solid var(--border)", objectFit: "contain",
                  background: "var(--surface-2)",
                }}
              />
            ))}
          </div>
        )}

        {/* Message text */}
        {hasText && (
          <div style={{
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
              <span style={{ whiteSpace: "pre-wrap" }}>{mainContent}</span>
            ) : (
              <div className="prose">
                <ReactMarkdown>{mainContent}</ReactMarkdown>
              </div>
            )}
          </div>
        )}

        {ahaInsight && <AhaCard content={ahaInsight} />}
      </div>
    </div>
  );
}

function AhaCard({ content }: { content: string }) {
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
        setEvidenceState({ kind: "error", msg: "暂无缓存的 Aha 数据" });
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
        <span style={{ color: "var(--accent)", fontWeight: 700, fontSize: 13 }}>Synapse 注意到</span>
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
            {expanded ? "收起 ↑" : "查看完整洞察 ↓"}
          </button>
        )}
        <button
          onClick={() => (evidenceOpen ? setEvidenceOpen(false) : openEvidence())}
          style={linkBtnStyle}
        >
          {evidenceOpen ? "收起证据链 ▲" : "查看证据链 ▼"}
        </button>
      </div>

      {evidenceOpen && (
        <div style={{
          marginTop: 12, borderTop: "1px solid var(--insight-border)",
          paddingTop: 12,
        }}>
          {evidenceState.kind === "loading" && (
            <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "12px 4px" }}>
              加载证据图…
            </div>
          )}
          {evidenceState.kind === "error" && (
            <div style={{ fontSize: 12, color: "#a01010", padding: "8px 4px" }}>
              加载失败：{evidenceState.msg}
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
