/**
 * AhaFullView — full-page Aha Insight UI.
 *
 * Architecture (top to bottom, takes the entire viewport):
 *   1. Header bar     ←Back to chat · 「Synapse noticed」· detection timestamp
 *   2. Hero section   observation (no truncation) + scope summary chips
 *   3. Side-by-side   Hypothesis | Reframe  (always visible — no collapse)
 *   4. Trajectory     Horizontal pill row of memory snippets (kind=trajectory)
 *                     or scene chips + reasoning paragraph (kind=theme)
 *   5. Evidence graph Full remaining viewport height — bulk of the page real estate
 *
 * Why a route instead of a modal: the 720×1100 modal collapsed the graph to
 * ~200px tall by the time the trajectory list and interpretation cards were
 * stacked above. With a route, the graph gets the rest of the viewport and the
 * user can actually read it.
 *
 * The evidence graph itself now adds explicit memory→memory edges in
 * trajectory order, so the "spanning multiple scenes" pattern reads visually
 * instead of looking like three disconnected scene trees.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  EvidenceGraph,
  type AhaPayload,
  type EvidenceData,
  type SelectedDetail,
} from "./evidence-graph";
import { EvidenceDrawer } from "./evidence-drawer";
import { useI18n } from "./i18n";

interface Props {
  /** Aha id, or the literal "latest" to fetch the most recent. */
  id: string;
}

export function AhaFullView({ id }: Props) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [aha, setAha] = useState<AhaPayload | null>(null);
  const [evidence, setEvidence] = useState<EvidenceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedDetail | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const url = id === "latest"
          ? "/api/aha/last"
          : `/api/aha/${encodeURIComponent(id)}`;
        const r1 = await fetch(url, { cache: "no-store" });
        const j1 = await r1.json();
        if (cancelled) return;
        const ahaObj: AhaPayload | null = j1.aha ?? null;
        setAha(ahaObj);
        if (ahaObj?.supportingMemoryIds?.length) {
          const r2 = await fetch("/api/aha/evidence", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ memoryIds: ahaObj.supportingMemoryIds }),
            cache: "no-store",
          });
          if (cancelled) return;
          setEvidence(await r2.json());
        } else {
          setEvidence(null);
        }
        // Mark seen when opening the latest insight (same behavior as the old
        // modal). Opening a specific historic id doesn't clear the badge.
        if (id === "latest") {
          fetch("/api/aha/seen", { method: "POST" }).catch(() => {});
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [id]);

  // ESC navigates back to the chat — mirrors the modal close behavior.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") router.back(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  return (
    <div style={{
      // Natural flow: the AppShell content area is `overflow: auto`, so this
      // page scrolls vertically if hero + interpretation + trajectory + graph
      // collectively exceed the viewport. The previous `maxHeight: 100vh`
      // squeezed the graph to 0px on long insights and made it look missing.
      minHeight: "100vh",
      background: "var(--bg)",
      display: "flex", flexDirection: "column",
      fontFamily: "system-ui, -apple-system, sans-serif",
      color: "var(--text)",
    }}>
      {/* Header */}
      <header style={{
        padding: "10px 22px",
        background: "linear-gradient(135deg, #FFF7DF 0%, #FFE5B0 100%)",
        borderBottom: "1px solid #F0D4C4",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 16,
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Link href="/app" style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            padding: "4px 9px", borderRadius: 6,
            border: "1px solid #D6A84F", background: "rgba(255,255,255,0.5)",
            color: "#7A5A10", fontSize: 12, fontWeight: 600,
            textDecoration: "none",
          }}>
            {t.common.backToChat}
          </Link>
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
      </header>

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
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
          <AhaContent
            aha={aha}
            evidence={evidence}
            selected={selected}
            onSelect={setSelected}
            t={t}
          />
        )}
      </div>
    </div>
  );
}

function AhaContent({
  aha, evidence, selected, onSelect, t,
}: {
  aha: AhaPayload;
  evidence: EvidenceData;
  selected: SelectedDetail | null;
  onSelect: (d: SelectedDetail | null) => void;
  t: ReturnType<typeof useI18n>["t"];
}) {
  const sceneCount = countContributingScenes(evidence);
  const memoryCount = aha.supportingMemoryIds?.length ?? evidence.memories.length;
  const spanDays = computeSpanDays(aha);

  return (
    <>
      {/* Hero — observation + scope summary */}
      <section style={{
        padding: "18px 28px 14px",
        borderBottom: "1px solid var(--border)",
        background: "var(--surface)",
        flexShrink: 0,
      }}>
        <div style={{
          display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10,
          fontSize: 11, color: "var(--text-muted)",
        }}>
          {aha.topic && (
            <span style={topicChipStyle}>📌 {aha.topic}</span>
          )}
          <span style={summaryChipStyle}>
            🪡 {t.aha.scopeScenes(sceneCount)}
          </span>
          <span style={summaryChipStyle}>
            🧠 {t.aha.scopeMemories(memoryCount)}
          </span>
          {spanDays != null && (
            <span style={summaryChipStyle}>
              📅 {t.aha.scopeDays(spanDays)}
            </span>
          )}
          <span style={{
            ...summaryChipStyle,
            background: aha.kind === "theme" ? "#FFEBC2" : "#E8F0FF",
            color: aha.kind === "theme" ? "#7A5A10" : "#1F3C66",
            borderColor: aha.kind === "theme" ? "#F0D4A0" : "#CFDDED",
          }}>
            {aha.kind === "theme" ? "🪡 Theme" : "📈 Trajectory"}
          </span>
        </div>

        <p style={{
          margin: 0,
          fontSize: 15, lineHeight: 1.7, color: "var(--text)",
          fontWeight: 500,
        }}>
          {aha.observation}
        </p>

        {aha.pattern && (
          <div style={{
            marginTop: 10, padding: "8px 12px",
            background: "var(--insight)", borderRadius: 6,
            fontSize: 13, fontWeight: 600, color: "var(--text)",
            display: "inline-block",
          }}>
            {aha.pattern}
          </div>
        )}
      </section>

      {/* Hypothesis | Reframe — always visible, side by side */}
      {(aha.hypothesis || aha.reframe) && (
        <section style={{
          padding: "12px 28px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg)",
          display: "grid",
          gridTemplateColumns: aha.hypothesis && aha.reframe ? "1fr 1fr" : "1fr",
          gap: 14,
          flexShrink: 0,
        }}>
          {aha.hypothesis && (
            <InterpretationCard
              label={t.aha.hypothesis}
              text={aha.hypothesis}
              tone="hypothesis"
            />
          )}
          {aha.reframe && (
            <InterpretationCard
              label={t.aha.reframe}
              text={aha.reframe}
              tone="reframe"
            />
          )}
        </section>
      )}

      {/* Evidence graph FIRST — the visual is the primary artifact.
          Fixed generous height so it always renders fully and auto-fits
          (no manual pan/zoom). */}
      <div style={{
        height: "min(75vh, 720px)",
        minHeight: 520,
        position: "relative",
        overflow: "hidden",
        borderTop: "1px solid var(--border)",
      }}>
        <EvidenceGraph
          aha={aha}
          evidence={evidence}
          onSelect={onSelect}
        />
        <EvidenceDrawer detail={selected} onClose={() => onSelect(null)} />
      </div>

      {/* Trajectory list BELOW the graph — readable transcript of the
          same evidence in chronological order. */}
      {aha.trajectory && aha.trajectory.length > 0 && (
        <TrajectoryRail aha={aha} t={t} />
      )}
    </>
  );
}

function InterpretationCard({
  label, text, tone,
}: { label: string; text: string; tone: "hypothesis" | "reframe" }) {
  const accent = tone === "hypothesis"
    ? { border: "#CFDDED", bg: "#F4F8FD", label: "#1F3C66" }
    : { border: "#E0D0BC", bg: "#FBF6EF", label: "#7A5A10" };
  return (
    <div style={{
      padding: "11px 14px",
      borderRadius: 10,
      border: `1px solid ${accent.border}`,
      background: accent.bg,
    }}>
      <div style={{
        fontSize: 10.5, fontWeight: 700, color: accent.label,
        textTransform: "uppercase", letterSpacing: 1.2,
        marginBottom: 6,
      }}>{label}</div>
      <div style={{ fontSize: 13, lineHeight: 1.65, color: "var(--text)" }}>
        {text}
      </div>
    </div>
  );
}

/**
 * Trajectory rail — vertical-stacked rows: date | type chip | full snippet.
 * Snippets render in full (no truncation, no horizontal scroll); long ones
 * just wrap. This matches the original modal layout but on a full page.
 */
function TrajectoryRail({
  aha, t,
}: { aha: AhaPayload; t: ReturnType<typeof useI18n>["t"] }) {
  const nodes = aha.trajectory ?? [];
  const isTheme = aha.kind === "theme";
  return (
    <section style={{
      padding: "12px 28px 14px",
      borderBottom: "1px solid var(--border)",
      background: "var(--surface)",
      flexShrink: 0,
    }}>
      <div style={{
        fontSize: 10.5, fontWeight: 700, color: "var(--text-muted)",
        textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 10,
      }}>
        {isTheme ? `🪡 ${t.aha.themeRail}` : `📈 ${t.aha.trajectoryRail}`}
        {aha.topic ? ` · ${aha.topic}` : ""}
      </div>

      {isTheme && aha.themeReasoning && (
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55, marginBottom: 8 }}>
          {aha.themeReasoning}
        </div>
      )}
      {isTheme && aha.themeScenes && aha.themeScenes.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
          {aha.themeScenes.map((s) => (
            <span key={s} style={{
              fontSize: 11, padding: "2px 9px", borderRadius: 10,
              background: "var(--insight)", color: "var(--text)",
              border: "1px solid var(--border)",
              fontWeight: 600,
            }}>{s}</span>
          ))}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {nodes.map((node, idx) => (
          <div key={node.memoryId} style={{
            display: "flex", alignItems: "flex-start", gap: 12,
            fontSize: 13, lineHeight: 1.6,
          }}>
            <span style={{
              flexShrink: 0, fontSize: 11, color: "var(--text-muted)",
              minWidth: 86, paddingTop: 2,
            }}>{node.recordedAt.slice(0, 10)}</span>
            <span style={trajTypeChipStyle}>{node.type}</span>
            <span style={{ flex: 1, minWidth: 0, color: "var(--text)" }}>
              {node.snippet}
              {!isTheme && idx < nodes.length - 1 && (
                <span style={{
                  marginLeft: 6, color: "var(--text-muted)", fontSize: 11,
                }}>↓</span>
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

const trajTypeChipStyle: React.CSSProperties = {
  flexShrink: 0, fontSize: 10, padding: "2px 7px", borderRadius: 4,
  background: "var(--surface-2)", color: "var(--text-muted)",
  fontWeight: 700, marginTop: 2, textTransform: "uppercase", letterSpacing: 0.6,
};

function countContributingScenes(evidence: EvidenceData): number {
  const scenes = new Set<string>();
  for (const m of evidence.memories) {
    scenes.add(m.sceneFilename ?? "__misc__");
  }
  return scenes.size;
}

function computeSpanDays(aha: AhaPayload): number | null {
  const nodes = aha.trajectory ?? [];
  if (nodes.length < 2) return null;
  const ts = nodes
    .map((n) => Date.parse(n.recordedAt))
    .filter((n) => Number.isFinite(n)) as number[];
  if (ts.length < 2) return null;
  const span = Math.max(...ts) - Math.min(...ts);
  return Math.max(1, Math.round(span / (24 * 60 * 60 * 1000)));
}

const loadingStyle: React.CSSProperties = {
  flex: 1,
  display: "flex", alignItems: "center", justifyContent: "center",
  color: "var(--text-muted)", fontSize: 13,
};
const errorStyle: React.CSSProperties = { ...loadingStyle, color: "#a01010" };

const summaryChipStyle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5,
  padding: "3px 9px", borderRadius: 12,
  background: "var(--surface)", border: "1px solid var(--border)",
  fontSize: 11, fontWeight: 600,
};
const topicChipStyle: React.CSSProperties = {
  ...summaryChipStyle,
  background: "var(--insight)", color: "var(--text)",
};
