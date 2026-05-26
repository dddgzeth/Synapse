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
            <>
              <EvidenceGraph
                aha={aha}
                evidence={evidence}
                onSelect={setSelected}
              />
              <EvidenceDrawer detail={selected} onClose={() => setSelected(null)} />
            </>
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
