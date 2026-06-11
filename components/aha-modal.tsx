/**
 * AhaModal — floating modal that surfaces the most recently detected Aha
 * Insight, with the same evidence-chain experience used in /aha-mock.
 *
 * Triggered by the sidebar badge dispatching "synapse:open-aha".
 * On open, marks the Aha as "seen" so the badge clears.
 *
 * Coexists with chat (backdrop dims the page behind it).
 */
"use client";

import { useEffect, useState } from "react";
import { EvidenceGraph, type AhaPayload, type EvidenceData, type SelectedDetail } from "./evidence-graph";
import { EvidenceDrawer } from "./evidence-drawer";
import { useI18n } from "./i18n";

/**
 * Trajectory mode — time-ordered timeline with vertical chevrons.
 * Reflects: "X → Y → Z, evolution over time within one topic."
 */
function TrajectoryStrip({ aha }: { aha: AhaPayload }) {
  if (!aha.trajectory || aha.trajectory.length === 0) return null;
  return (
    <div style={stripStyle}>
      <div style={stripLabelStyle}>📈 Trajectory {aha.topic ? `· ${aha.topic}` : ""}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {aha.trajectory.map((node, idx) => (
          <div key={node.memoryId} style={{
            display: "flex", alignItems: "flex-start", gap: 10,
            fontSize: 12, lineHeight: 1.5,
          }}>
            <span style={{
              flexShrink: 0, fontSize: 10, color: "var(--text-muted)",
              minWidth: 78, paddingTop: 1,
            }}>{node.recordedAt.slice(0, 10)}</span>
            <span style={typeChipStyle}>{node.type}</span>
            <span style={{ flex: 1, color: "var(--text)" }}>{node.snippet}</span>
            {idx < (aha.trajectory!.length - 1) && (
              <span style={{ color: "var(--text-muted)", fontSize: 10 }}>↓</span>
            )}
          </div>
        ))}
      </div>
      <PatternBadge text={aha.pattern} />
    </div>
  );
}

/**
 * Theme mode — same evidence list but grouped by contributing scene,
 * NO chronological arrows (theme isn't an evolution, it's a cross-cut).
 * The header surfaces the scene chips so the user sees the cross-cut at a glance.
 */
function ThemeStrip({ aha }: { aha: AhaPayload }) {
  if (!aha.trajectory || aha.trajectory.length === 0) return null;
  // Group nodes by scene_name (which we derive from where the memory belongs).
  // The backend already pulled memories from each contributing scene, but the
  // trajectory node itself doesn't carry scene_name. Fall back to a flat list
  // grouped visually by recordedAt date headers.
  const sceneChips = aha.themeScenes ?? [];
  return (
    <div style={stripStyle}>
      <div style={stripLabelStyle}>
        🪡 Theme {aha.topic ? `· ${aha.topic}` : ""}
      </div>
      {sceneChips.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {sceneChips.map((s) => (
            <span key={s} style={{
              fontSize: 11, padding: "2px 8px", borderRadius: 10,
              background: "var(--insight)", color: "var(--text)",
              border: "1px solid var(--border)",
            }}>{s}</span>
          ))}
        </div>
      )}
      {aha.themeReasoning && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.55, marginBottom: 8 }}>
          {aha.themeReasoning}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {aha.trajectory.map((node) => (
          <div key={node.memoryId} style={{
            display: "flex", alignItems: "flex-start", gap: 10,
            fontSize: 12, lineHeight: 1.5,
          }}>
            <span style={{
              flexShrink: 0, fontSize: 10, color: "var(--text-muted)",
              minWidth: 78, paddingTop: 1,
            }}>{node.recordedAt.slice(0, 10)}</span>
            <span style={typeChipStyle}>{node.type}</span>
            <span style={{ flex: 1, color: "var(--text)" }}>{node.snippet}</span>
          </div>
        ))}
      </div>
      <PatternBadge text={aha.pattern} />
    </div>
  );
}

function PatternBadge({ text }: { text: string }) {
  return (
    <div style={{
      marginTop: 10, padding: "8px 12px",
      background: "var(--insight)", borderRadius: 6,
      fontSize: 13, fontWeight: 600, color: "var(--text)",
    }}>{text}</div>
  );
}

/** Dispatch by `kind` — defaults to trajectory for back-compat with old cards. */
function EvidenceStrip({ aha }: { aha: AhaPayload }) {
  return aha.kind === "theme" ? <ThemeStrip aha={aha} /> : <TrajectoryStrip aha={aha} />;
}

const stripStyle: React.CSSProperties = {
  padding: "12px 22px 8px",
  borderBottom: "1px solid var(--border)",
  background: "var(--bg)",
};
const stripLabelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "var(--text-muted)",
  textTransform: "uppercase", letterSpacing: 1.1, marginBottom: 8,
};
const typeChipStyle: React.CSSProperties = {
  flexShrink: 0, fontSize: 10, padding: "1px 5px", borderRadius: 4,
  background: "var(--surface-2)", color: "var(--text-muted)",
  fontWeight: 600, marginTop: 1,
};

function DeepCutsBlock({ aha }: { aha: AhaPayload }) {
  const [expanded, setExpanded] = useState(false);
  if (!aha.hypothesis && !aha.reframe) return null;
  return (
    <div style={{
      padding: "8px 22px 12px",
      borderBottom: "1px solid var(--border)",
      background: "var(--bg)",
    }}>
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          background: "none", border: "none", cursor: "pointer", padding: 0,
          fontSize: 11, fontWeight: 700, color: "var(--accent)",
          textTransform: "uppercase", letterSpacing: 1.1,
        }}
      >
        {expanded ? "▼ Hide interpretation" : "▶ Show interpretation (hypothesis / reframe)"}
      </button>
      {expanded && (
        <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
          {aha.hypothesis && (
            <div style={{ fontSize: 12, lineHeight: 1.6, color: "var(--text)" }}>
              <span style={{ fontWeight: 600, color: "var(--text-muted)" }}>Hypothesis · </span>
              {aha.hypothesis}
            </div>
          )}
          {aha.reframe && (
            <div style={{ fontSize: 12, lineHeight: 1.6, color: "var(--text)" }}>
              <span style={{ fontWeight: 600, color: "var(--text-muted)" }}>Reframe · </span>
              {aha.reframe}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function AhaModal() {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [aha, setAha] = useState<AhaPayload | null>(null);
  const [evidence, setEvidence] = useState<EvidenceData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedDetail | null>(null);

  // Listen for open requests from the sidebar badge or history list.
  // event.detail.id (optional) → load that specific Aha; otherwise load the latest.
  useEffect(() => {
    const handler = async (e: Event) => {
      const customEvt = e as CustomEvent<{ id?: string } | undefined>;
      const id = customEvt.detail?.id;
      setOpen(true);
      setLoading(true);
      setError(null);
      setSelected(null);
      try {
        const url = id ? `/api/aha/${encodeURIComponent(id)}` : "/api/aha/last";
        const r1 = await fetch(url, { cache: "no-store" });
        const j1 = await r1.json();
        const ahaObj: AhaPayload | null = j1.aha ?? null;
        setAha(ahaObj);
        if (ahaObj?.supportingMemoryIds?.length) {
          const r2 = await fetch("/api/aha/evidence", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ memoryIds: ahaObj.supportingMemoryIds }),
            cache: "no-store",
          });
          setEvidence(await r2.json());
        } else {
          setEvidence(null);
        }
        // Mark the latest Aha as seen only when opening *that* one (no id given).
        // Opening a historic Aha shouldn't clear the unseen badge of a newer one.
        if (!id) {
          fetch("/api/aha/seen", { method: "POST" }).catch(() => {});
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };
    window.addEventListener("synapse:open-aha", handler);
    return () => window.removeEventListener("synapse:open-aha", handler);
  }, []);

  // ESC to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div
      onClick={() => setOpen(false)}
      style={{
        position: "fixed", inset: 0, zIndex: 200,
        background: "rgba(20, 20, 18, 0.55)",
        backdropFilter: "blur(3px)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: "32px 24px",
        animation: "synapse-fade-in 120ms ease-out",
      }}
    >
      <article
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(1100px, 100%)",
          height: "min(720px, 100%)",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          boxShadow: "0 24px 60px rgba(0,0,0,0.3)",
          fontFamily: "system-ui, sans-serif",
          color: "var(--text)",
          display: "flex", flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <header style={{
          padding: "12px 22px",
          background: "linear-gradient(135deg, #FFF7DF 0%, #FFE5B0 100%)",
          borderBottom: "1px solid #F0D4C4",
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>✨</span>
            <span style={{
              fontSize: 12, fontWeight: 700, color: "#7A5A10",
              textTransform: "uppercase", letterSpacing: 1.2,
            }}>{t.aha.noticed}</span>
            {aha?.detectedAt && (
              <span style={{ fontSize: 11, color: "#9a7a30" }}>
                · {new Date(aha.detectedAt).toLocaleString(locale)}
              </span>
            )}
          </div>
          <button
            onClick={() => setOpen(false)}
            aria-label={t.common.close}
            style={{
              background: "transparent", border: "none",
              fontSize: 18, color: "#7A5A10", cursor: "pointer",
              padding: 4, lineHeight: 1,
            }}
          >✕</button>
        </header>

        <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
          {loading && (
            <div style={loadingStyle}>{t.common.loading}</div>
          )}
          {error && (
            <div style={errorStyle}>{t.common.loadFailed}: {error}</div>
          )}
          {!loading && !error && !aha && (
            <div style={loadingStyle}>{t.aha.noData}</div>
          )}
          {aha && evidence && (
            <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
              <EvidenceStrip aha={aha} />
              <DeepCutsBlock aha={aha} />
              <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
                <EvidenceGraph
                  aha={aha}
                  evidence={evidence}
                  onSelect={setSelected}
                />
                <EvidenceDrawer detail={selected} onClose={() => setSelected(null)} />
              </div>
            </div>
          )}
        </div>
      </article>
    </div>
  );
}

const loadingStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  height: "100%", color: "var(--text-muted)", fontSize: 13,
};

const errorStyle: React.CSSProperties = {
  ...loadingStyle,
  color: "#a01010",
};
