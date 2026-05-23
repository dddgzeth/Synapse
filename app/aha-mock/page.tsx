/**
 * /aha-mock — preview page for the Aha evidence-chain.
 *
 * Top:    xyflow EvidenceGraph (interactive — click any node opens drawer)
 * Bottom: raw JSON of /api/aha/last and /api/aha/evidence (for field debugging)
 */
"use client";

import { useEffect, useState } from "react";
import { EvidenceGraph, type AhaPayload, type EvidenceData, type SelectedDetail } from "@/components/evidence-graph";
import { EvidenceDrawer } from "@/components/evidence-drawer";

export default function AhaMockPage() {
  const [aha, setAha] = useState<AhaPayload | null>(null);
  const [evidence, setEvidence] = useState<EvidenceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [forceLoading, setForceLoading] = useState(false);
  const [selected, setSelected] = useState<SelectedDetail | null>(null);

  const load = async (force: boolean) => {
    setError(null);
    if (force) setForceLoading(true);
    else setLoading(true);
    try {
      const r1 = await fetch(`/api/aha/last${force ? "?force=1" : ""}`, { cache: "no-store" });
      if (!r1.ok) throw new Error(`/api/aha/last → ${r1.status}`);
      const j1 = await r1.json();
      const ahaObj: AhaPayload | null = j1.aha ?? null;
      setAha(ahaObj);

      if (ahaObj && ahaObj.supportingMemoryIds?.length) {
        const r2 = await fetch("/api/aha/evidence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ memoryIds: ahaObj.supportingMemoryIds }),
          cache: "no-store",
        });
        if (!r2.ok) throw new Error(`/api/aha/evidence → ${r2.status}`);
        const j2 = await r2.json();
        setEvidence(j2);
      } else {
        setEvidence(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setForceLoading(false);
    }
  };

  useEffect(() => {
    void load(false);
  }, []);

  return (
    <main style={{
      maxWidth: 1280,
      margin: "0 auto",
      padding: "20px 24px",
      fontFamily: "system-ui, sans-serif",
      color: "#1a1a1a",
    }}>
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>Synapse 证据链 — 预览</h1>
        <p style={{ color: "#666", fontSize: 12.5, margin: 0 }}>
          顶部交互式证据图（点节点弹右侧抽屉）；下方是两段原始 JSON 供字段对照。
        </p>
      </header>

      <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
        <button onClick={() => load(false)} disabled={loading || forceLoading} style={btnStyle(false)}>
          {loading ? "Loading…" : "Reload (cached)"}
        </button>
        <button onClick={() => load(true)} disabled={loading || forceLoading} style={btnStyle(true)}>
          {forceLoading ? "Regenerating…" : "Force regenerate (calls LLM)"}
        </button>
      </div>

      {error && <pre style={errorStyle}>Error: {error}</pre>}

      {/* Graph */}
      <section style={{ marginBottom: 22 }}>
        <h2 style={h2Style}>① 证据图</h2>
        <div style={{
          position: "relative",
          width: "100%",
          height: 600,
          border: "1px solid #e3e8ef",
          borderRadius: 10,
          overflow: "hidden",
          background: "#fafbfd",
        }}>
          {aha && evidence ? (
            <>
              <EvidenceGraph aha={aha} evidence={evidence} onSelect={setSelected} />
              <EvidenceDrawer detail={selected} onClose={() => setSelected(null)} />
            </>
          ) : (
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              height: "100%", color: "#999", fontSize: 13,
            }}>
              {loading || forceLoading ? "Loading…" : "(尚未生成 Aha，请点 Force regenerate)"}
            </div>
          )}
        </div>
      </section>

      {/* Raw JSON */}
      <section style={{ marginBottom: 20 }}>
        <h2 style={h2Style}>② GET /api/aha/last（原始 JSON）</h2>
        <pre style={preStyle}>{aha ? JSON.stringify({ aha }, null, 2) : "(no aha yet)"}</pre>
      </section>
      <section>
        <h2 style={h2Style}>③ POST /api/aha/evidence（原始 JSON）</h2>
        <pre style={preStyle}>{evidence ? JSON.stringify(evidence, null, 2) : "(no evidence)"}</pre>
      </section>
    </main>
  );
}

const preStyle: React.CSSProperties = {
  background: "#0f1419",
  color: "#dce5ee",
  padding: "12px 14px",
  borderRadius: 8,
  fontSize: 11.5,
  lineHeight: 1.55,
  overflowX: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  border: "1px solid #1f2933",
  maxHeight: 400,
  overflowY: "auto",
};

const errorStyle: React.CSSProperties = {
  background: "#fff0f0",
  color: "#a01010",
  padding: "10px 14px",
  borderRadius: 6,
  fontSize: 13,
  border: "1px solid #f0c0c0",
  marginBottom: 14,
};

const h2Style: React.CSSProperties = {
  fontSize: 13.5,
  fontWeight: 600,
  margin: "0 0 8px",
  color: "#333",
};

function btnStyle(primary: boolean): React.CSSProperties {
  return {
    padding: "7px 13px",
    background: primary ? "#3a6ea5" : "#fff",
    color: primary ? "#fff" : "#333",
    border: `1px solid ${primary ? "#3a6ea5" : "#ccc"}`,
    borderRadius: 6,
    fontSize: 12.5,
    cursor: "pointer",
    fontWeight: 500,
  };
}
