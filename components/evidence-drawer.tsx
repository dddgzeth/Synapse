/**
 * EvidenceDrawer — slide-in right panel showing the selected node's details.
 *
 * 3 states based on selection.kind:
 *   - "top"    → observation + hypothesis + reframe (full)
 *   - "scene"  → title + summary + memory count / max priority
 *   - "memory" → type + priority + full content + L0 source messages
 *                (user shown fully, assistant default-collapsed to 300 chars)
 */
"use client";

import { useState } from "react";
import type { SelectedDetail, ConversationPayload } from "./evidence-graph";
import { useI18n } from "./i18n";

interface Props {
  detail: SelectedDetail | null;
  onClose: () => void;
}

export function EvidenceDrawer({ detail, onClose }: Props) {
  const { t } = useI18n();
  if (!detail) return null;

  return (
    <aside
      style={{
        position: "absolute",
        top: 0, right: 0, bottom: 0,
        width: 420,
        background: "#fff",
        borderLeft: "1px solid #e3e8ef",
        boxShadow: "-4px 0 16px rgba(0,0,0,0.08)",
        zIndex: 20,
        display: "flex",
        flexDirection: "column",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <header style={{
        padding: "12px 16px",
        borderBottom: "1px solid #eef1f5",
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <span style={{
          fontSize: 11, fontWeight: 700, color: "#666",
          textTransform: "uppercase", letterSpacing: 0.7,
        }}>
          {detail.kind === "top" && `✨ ${t.aha.noticed}`}
          {detail.kind === "scene" && `📂 ${t.aha.scene}`}
          {detail.kind === "memory" && `📝 ${detail.memory.type}`}
        </span>
        <button onClick={onClose} style={closeBtnStyle}>✕</button>
      </header>

      <div style={{
        flex: 1, overflowY: "auto", padding: "14px 18px",
        fontSize: 13, lineHeight: 1.65, color: "#222",
      }}>
        {detail.kind === "top" && <TopDetail detail={detail} />}
        {detail.kind === "scene" && <SceneDetail detail={detail} />}
        {detail.kind === "memory" && <MemoryDetail detail={detail} />}
      </div>
    </aside>
  );
}

function TopDetail({ detail }: { detail: Extract<SelectedDetail, { kind: "top" }> }) {
  const { t, locale } = useI18n();
  const { aha } = detail;
  return (
    <>
      <Section label={t.aha.narrative}>{aha.observation}</Section>
      <Section label={t.aha.hypothesis}>{aha.hypothesis}</Section>
      <Section label={t.aha.reframe}>{aha.reframe}</Section>
      <Section label={t.aha.detectedAt}>
        <span style={{ color: "#888", fontSize: 12 }}>
          {new Date(aha.detectedAt).toLocaleString(locale)}
        </span>
      </Section>
    </>
  );
}

function SceneDetail({ detail }: { detail: Extract<SelectedDetail, { kind: "scene" }> }) {
  const { t } = useI18n();
  const { scene } = detail;
  return (
    <>
      <h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 10px", color: "#1f3c66" }}>
        {scene.title}
      </h3>
      <Section label={t.aha.summary}>{scene.summary}</Section>
      <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
        <Stat label={t.aha.supportingMemories} value={`${scene.memoryCount} ${t.common.memories}`} />
        <Stat label={t.aha.maxPriority} value={`P${scene.maxPriority}`} />
      </div>
    </>
  );
}

function MemoryDetail({ detail }: { detail: Extract<SelectedDetail, { kind: "memory" }> }) {
  const { t, locale } = useI18n();
  const { memory, conversations } = detail;
  return (
    <>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <Stat label={t.aha.type} value={memory.type} />
        <Stat label={t.aha.priority} value={`P${memory.priority}`} />
        <Stat label={t.aha.created} value={new Date(memory.createdAt).toLocaleDateString(locale)} />
      </div>

      <Section label={t.details.l1Content}>
        <div style={{ whiteSpace: "pre-wrap", color: "#222" }}>{memory.content}</div>
      </Section>

      <Section label={t.details.l0Conversation(conversations.length)}>
        {conversations.length === 0 ? (
          <em style={{ color: "#999" }}>{t.details.noL0}</em>
        ) : (
          conversations.map((c, i) => <L0Bubble key={i} conv={c} />)
        )}
      </Section>
    </>
  );
}

const COLLAPSED_LEN = 300;

function L0Bubble({ conv }: { conv: ConversationPayload }) {
  const { t, locale } = useI18n();
  const isUser = conv.role === "user";
  const long = conv.content.length > COLLAPSED_LEN;
  const [expanded, setExpanded] = useState(!long || isUser); // user 默认全显示
  const displayed = expanded ? conv.content : conv.content.slice(0, COLLAPSED_LEN) + "…";

  return (
    <div style={{
      marginBottom: 12,
      padding: "10px 12px",
      background: isUser ? "#eff4fb" : "#fbfaf6",
      border: `1px solid ${isUser ? "#cdd9eb" : "#ebe2cb"}`,
      borderRadius: 8,
    }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginBottom: 6, fontSize: 11, color: "#666",
      }}>
        <span style={{ fontWeight: 700, color: isUser ? "#3a6ea5" : "#a06a10" }}>
          {isUser ? "User" : "Synapse"}
        </span>
        <span style={{ fontSize: 10 }}>
          {new Date(conv.recorded_at).toLocaleString(locale, {
            month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
          })}
        </span>
      </div>
      <div style={{ whiteSpace: "pre-wrap", fontSize: 12.5, lineHeight: 1.6, color: "#222" }}>
        {displayed}
      </div>
      {long && !isUser && (
        <button
          onClick={() => setExpanded(!expanded)}
          style={{
            marginTop: 6, background: "none", border: "none",
            color: "#3a6ea5", cursor: "pointer", fontSize: 11, padding: 0, fontWeight: 600,
          }}
        >
          {expanded ? t.aha.collapse : t.aha.expandRemaining(conv.content.length - COLLAPSED_LEN)}
        </button>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        fontSize: 10, fontWeight: 700, color: "#999",
        textTransform: "uppercase", letterSpacing: 0.7, marginBottom: 5,
      }}>{label}</div>
      <div>{children}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      padding: "5px 9px",
      background: "#f4f6fa",
      border: "1px solid #e3e8ef",
      borderRadius: 5,
      fontSize: 11,
    }}>
      <div style={{ color: "#888", fontSize: 9.5, marginBottom: 1 }}>{label}</div>
      <div style={{ color: "#222", fontWeight: 600 }}>{value}</div>
    </div>
  );
}

const closeBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  fontSize: 16,
  color: "#888",
  cursor: "pointer",
  padding: "2px 6px",
  lineHeight: 1,
};
