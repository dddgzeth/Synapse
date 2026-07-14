/**
 * EvidenceGraph — investigation-board canvas. Memory nodes float free (no
 * container boxes); scene membership is encoded only by the colour of each
 * node's left edge and a small scene label on its anchor card. Edges are
 * curved bezier lines and converge upward to the single "Synapse 注意到"
 * node at the top.
 *
 *                            ✨ Synapse 注意到
 *                          ╱       ╲     ╲
 *                         ╱         ╲     ╲╲
 *                  [anchor:A]   [anchor:B]   [anchor:C]
 *                   ╱      ╲      ╲    ╲       ╲
 *                [b:A]   [b:A]   [b:B]  [b:B]   [b:C]
 *
 *   solid coloured edge  = anchor memory → top  (carries the scene colour)
 *   dashed coloured edge = supporting memory → anchor (same scene)
 *
 * Layout is a polar scatter: anchors are placed on a wide arc with hash
 * jitter, then an iterative pairwise repulsion pass guarantees no node
 * overlaps. Branch memories fan out below their anchor at varied angles.
 * Result: positions feel organic, lines fan up and naturally cross, but
 * nothing visually overlaps and every path terminates at the top node.
 *
 * Memories without a scene_name are dropped — we render only evidence that
 * has a place in the chain.
 */
"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  MarkerType,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useI18n, type TranslationSet } from "./i18n";

// ──────────────────────────────────────
// Types
// ──────────────────────────────────────

export interface ExternalSource {
  title: string;
  abstract: string;
  source: "semantic_scholar" | "arxiv";
  url?: string;
  year?: number;
}

export interface TrajectoryNode {
  memoryId: string;
  recordedAt: string;
  type: string;
  snippet: string;
  /** One-line LLM reasoning: why this memory supports the insight. */
  why?: string;
}

export type AhaKind = "trajectory" | "theme";

export interface AhaPayload {
  kind?: AhaKind;
  topic?: string;
  pattern: string;
  observation: string;
  hypothesis: string;
  reframe: string;
  trajectory?: TrajectoryNode[];
  themeScenes?: string[];
  themeReasoning?: string;
  supportingMemoryIds: string[];
  externalSources?: ExternalSource[];
  detectedAt: string;
}

export interface ScenePayload {
  filename: string;
  title: string;
  summary: string;
  heat: number;
  memoryCount: number;
  maxPriority: number;
}

export interface MemoryPayload {
  id: string;
  type: string;
  priority: number;
  scene_name: string;
  sceneFilename: string | null;
  content: string;
  createdAt: string;
  sourceMessageIds: string[];
}

export interface ConversationPayload {
  role: string;
  content: string;
  sessionKey: string;
  recorded_at: string;
}

export interface EvidenceData {
  scenes: ScenePayload[];
  memories: MemoryPayload[];
  conversations: Record<string, ConversationPayload>;
}

export type SelectedDetail =
  | { kind: "top"; aha: AhaPayload }
  | { kind: "scene"; scene: ScenePayload | { filename: null; title: string; summary: string; memoryCount: number; maxPriority: number; heat: number } }
  | { kind: "memory"; memory: MemoryPayload; conversations: ConversationPayload[]; sceneAccent: string; why?: string };

interface Props {
  aha: AhaPayload;
  evidence: EvidenceData;
  onSelect: (detail: SelectedDetail | null) => void;
}

// ──────────────────────────────────────
// Palette
// ──────────────────────────────────────

const COLORS = {
  bg: "#FAFAF8",
  surface: "#FFFFFF",
  border: "#E8E8E0",
  text: "#1A1A1A",
  textMuted: "#6B7280",
  accent: "#D97757",
  accentSoft: "#FFF0E8",
};

const SCENE_ACCENTS = [
  { stripe: "#D97757", soft: "#FFF7F1", border: "#F0D4C4", text: "#7A2E10" },
  { stripe: "#5B7DB1", soft: "#F2F6FB", border: "#CFDDED", text: "#1F3C66" },
  { stripe: "#7AA66D", soft: "#F4F8F0", border: "#D4E5CD", text: "#2E4A24" },
  { stripe: "#A583E0", soft: "#F7F1FC", border: "#DECFEE", text: "#4D2A8A" },
  { stripe: "#C39A3B", soft: "#FBF6E9", border: "#E5D6A5", text: "#6E5012" },
  { stripe: "#3D9A9A", soft: "#EEF8F8", border: "#BFE0E0", text: "#0F4A4A" },
  { stripe: "#B85A82", soft: "#FBF1F5", border: "#E5C8D4", text: "#6A1F40" },
  { stripe: "#6C7DD9", soft: "#F1F3FC", border: "#CBD2EF", text: "#1F2B7A" },
  { stripe: "#8C9A2E", soft: "#F7F8E8", border: "#DCE2B0", text: "#3D4810" },
  { stripe: "#C56F33", soft: "#FBF1E8", border: "#EBC9A8", text: "#6D2E08" },
];

const TYPE_CHIP: Record<string, string> = {
  goal: "#B8842D",
  finding: "#B8842D",
  claim: "#C46B3A",
  observation: "#C46B3A",
  method: "#7A8497",
  dataset: "#7A8497",
  question: "#8C6CB6",
  experiment: "#5C8C72",
};
const TYPE_FALLBACK_CHIP = "#888";

function chipForType(type: string) {
  return TYPE_CHIP[type] ?? TYPE_FALLBACK_CHIP;
}

function shortText(s: string, limit: number) {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length <= limit ? t : `${t.slice(0, limit - 1)}…`;
}

// ──────────────────────────────────────
// Hash + jitter helpers
// ──────────────────────────────────────

function hashStr(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Deterministic jitter in [-amplitude, +amplitude]. */
function jitter(seed: string, amplitude: number): number {
  const v = (hashStr(seed) % 10000) / 10000; // [0, 1)
  return (v - 0.5) * 2 * amplitude;
}

// ──────────────────────────────────────
// Node components
// ──────────────────────────────────────

interface TopNodeData {
  observationSnippet: string;
  count: number;
  noticedLabel: string;
  evidenceLabel: string;
  clickLabel: string;
  onClick: () => void;
}

function TopNode({ data }: NodeProps) {
  const d = data as unknown as TopNodeData;
  return (
    <div
      onClick={d.onClick}
      style={{
        width: 360,
        padding: "16px 18px",
        background: `linear-gradient(140deg, ${COLORS.surface} 0%, ${COLORS.accentSoft} 100%)`,
        border: `1px solid ${COLORS.border}`,
        borderLeft: `4px solid ${COLORS.accent}`,
        borderRadius: 12,
        boxShadow: "0 6px 20px rgba(217, 119, 87, 0.15), 0 1px 3px rgba(0,0,0,0.04)",
        cursor: "pointer",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <Handle type="target" position={Position.Bottom} style={{ opacity: 0, left: "50%" }} />
      <div style={{
        display: "flex", alignItems: "center", gap: 7,
        fontSize: 10.5, fontWeight: 700, color: COLORS.accent,
        textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 10,
      }}>
        <span style={{ fontSize: 13 }}>✨</span>
        <span>{d.noticedLabel}</span>
      </div>
      <div style={{ fontSize: 13.5, lineHeight: 1.65, color: COLORS.text, fontWeight: 450 }}>
        {d.observationSnippet}
      </div>
      <div style={{
        marginTop: 12, paddingTop: 10, borderTop: `1px solid ${COLORS.border}`,
        fontSize: 11, color: COLORS.textMuted, display: "flex", justifyContent: "space-between",
      }}>
        <span>{d.evidenceLabel}</span>
        <span style={{ color: COLORS.accent, fontWeight: 600 }}>{d.clickLabel}</span>
      </div>
    </div>
  );
}

interface MemoryNodeData {
  type: string;
  priority: number;
  contentSnippet: string;
  sceneAccent: string;
  sceneTitle?: string;
  onClick: () => void;
}

function MemoryNode({ data }: NodeProps) {
  const d = data as unknown as MemoryNodeData;
  const chipColor = chipForType(d.type);
  const isAnchor = !!d.sceneTitle;
  return (
    <div
      onClick={d.onClick}
      style={{
        width: 220,
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderLeft: `5px solid ${d.sceneAccent}`,
        borderRadius: 9,
        boxShadow: isAnchor
          ? "0 3px 10px rgba(0,0,0,0.10)"
          : "0 1px 4px rgba(0,0,0,0.06)",
        cursor: "pointer",
        fontFamily: "system-ui, sans-serif",
        overflow: "hidden",
      }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Top} id="up" style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Bottom} id="down-in" style={{ opacity: 0 }} />
      {isAnchor ? (
        <div style={{
          padding: "5px 10px 4px",
          fontSize: 10.5,
          fontWeight: 700,
          color: d.sceneAccent,
          letterSpacing: 0.2,
          background: `${d.sceneAccent}12`,
          borderBottom: `1px solid ${d.sceneAccent}33`,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{d.sceneTitle}</div>
      ) : null}
      <div style={{ padding: "8px 11px 10px" }}>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          marginBottom: 5,
        }}>
          <span style={{
            fontSize: 9, fontWeight: 700, color: "#fff",
            background: chipColor, padding: "2px 7px", borderRadius: 3,
            textTransform: "uppercase", letterSpacing: 0.7,
          }}>
            {d.type}
          </span>
          <span style={{ fontSize: 10, color: COLORS.textMuted, fontWeight: 600 }}>
            P{d.priority}
          </span>
        </div>
        <div style={{ fontSize: 11.2, color: COLORS.text, lineHeight: 1.5 }}>
          {d.contentSnippet}
        </div>
      </div>
    </div>
  );
}

const nodeTypes = {
  topNode: TopNode,
  memoryNode: MemoryNode,
};

// ──────────────────────────────────────
// Layout — polar scatter with overlap resolution
// ──────────────────────────────────────

const MEMORY_W = 220;
const MEMORY_H = 96;
const TOP_NODE_W = 360;
const TOP_NODE_H = 170;
const TOP_TO_FIRST_RING = 230;

// Pairwise minimum centre distance — guarantees node bodies don't touch.
const MIN_NODE_DIST = 248;
const MIN_ANCHOR_DIST = 280;

interface SceneBundle {
  scene: ScenePayload;
  mems: MemoryPayload[];
  accent: typeof SCENE_ACCENTS[number];
}

interface LayoutResult {
  positions: Map<string, { x: number; y: number }>;
  anchorOf: Map<string, string>; // sceneFilename → anchor memoryId
  withinEdges: Array<{ from: string; to: string; sceneColor: string; isSpine: boolean }>;
  anchorEdges: Array<{ memId: string; sceneColor: string }>;
}

function pickAnchor(mems: MemoryPayload[], trajIds: Set<string>): MemoryPayload {
  // Anchor priority: on the aha trajectory > higher priority > earlier in time.
  return [...mems].sort((a, b) => {
    const ta = trajIds.has(a.id) ? 1 : 0;
    const tb = trajIds.has(b.id) ? 1 : 0;
    if (ta !== tb) return tb - ta;
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.createdAt.localeCompare(b.createdAt);
  })[0];
}

function organicLayout(scenes: SceneBundle[], trajIds: Set<string>): LayoutResult {
  const positions = new Map<string, { x: number; y: number }>();
  const anchorOf = new Map<string, string>();
  const withinEdges: LayoutResult["withinEdges"] = [];
  const anchorEdges: LayoutResult["anchorEdges"] = [];

  const N = scenes.length;
  if (N === 0) return { positions, anchorOf, withinEdges, anchorEdges };

  // ── 1. Seed anchor positions on a wide arc, alternating two shells so
  //       adjacent scenes sit at different depths (creates organic V-stagger). ──
  const ARC_HALF = 78; // degrees off vertical
  const INNER_R = 470;
  const OUTER_R = 680;
  const anchorIds: string[] = [];

  for (let i = 0; i < N; i++) {
    const { scene, mems } = scenes[i];
    const anchor = pickAnchor(mems, trajIds);
    anchorIds.push(anchor.id);
    anchorOf.set(scene.filename, anchor.id);

    const angleDeg =
      N === 1 ? 0 : -ARC_HALF + (2 * ARC_HALF * i) / (N - 1);
    const wiggle = jitter(scene.filename + ":θ", 6);
    const finalAngle = ((angleDeg + wiggle) * Math.PI) / 180;

    const baseRadius = i % 2 === 0 ? INNER_R : OUTER_R;
    const radius = baseRadius + jitter(scene.filename + ":r", 40);

    const x = Math.sin(finalAngle) * radius + jitter(scene.filename + ":x", 22);
    // y_factor compresses outer-angle nodes so they don't fly back upward.
    const yFactor = 0.55 + 0.45 * Math.cos(finalAngle);
    const y = TOP_NODE_H + TOP_TO_FIRST_RING + radius * yFactor * 0.55 +
              jitter(scene.filename + ":y", 30);

    positions.set(anchor.id, { x, y });
  }

  // ── 2. Repel overlapping anchors (anchors are heavy — only push each other). ──
  resolveOverlaps(positions, MIN_ANCHOR_DIST, anchorIds, anchorIds, 60);

  // ── 3. Place branch memories in a fan below each anchor; bias to "lower
  //       and outward" so flow visually drops away from top. ──
  for (let i = 0; i < N; i++) {
    const { scene, mems, accent } = scenes[i];
    const anchorId = anchorOf.get(scene.filename)!;
    const anchorPos = positions.get(anchorId)!;
    const others = mems.filter((m) => m.id !== anchorId);

    anchorEdges.push({ memId: anchorId, sceneColor: accent.stripe });

    others.forEach((m, j) => {
      const total = others.length;
      // Fan: spread non-anchor memories across [-60°, 60°] below anchor.
      // Singletons get a hash-picked direction so they don't all land
      // directly below their anchor and collide with the next scene.
      const baseSub = total === 1
        ? jitter(m.id + ":dir", 40)
        : -60 + (120 * j) / (total - 1);
      const subAngle = baseSub + jitter(m.id + ":θ", 10);
      const subRad = (subAngle * Math.PI) / 180;
      const dist = 175 + Math.floor(j / 3) * 90 + jitter(m.id + ":d", 22);

      positions.set(m.id, {
        x: anchorPos.x + dist * Math.sin(subRad),
        y: anchorPos.y + dist * Math.cos(subRad),
      });

      const isSpineEdge = trajIds.has(m.id) && trajIds.has(anchorId);
      withinEdges.push({
        from: m.id,
        to: anchorId,
        sceneColor: accent.stripe,
        isSpine: isSpineEdge,
      });
    });
  }

  // ── 4. Final repulsion pass over ALL nodes — anchors stay locked,
  //       branches absorb the displacement. ──
  const fixed = new Set(anchorIds);
  resolveOverlapsFixed(positions, MIN_NODE_DIST, fixed, 40);

  return { positions, anchorOf, withinEdges, anchorEdges };
}

function resolveOverlaps(
  positions: Map<string, { x: number; y: number }>,
  minDist: number,
  poolA: string[],
  poolB: string[],
  iterations: number,
) {
  for (let iter = 0; iter < iterations; iter++) {
    let moved = false;
    for (let i = 0; i < poolA.length; i++) {
      const a = poolA[i];
      const pa = positions.get(a);
      if (!pa) continue;
      for (let j = 0; j < poolB.length; j++) {
        const b = poolB[j];
        if (a === b) continue;
        const pb = positions.get(b);
        if (!pb) continue;
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > 0.5 && d < minDist) {
          const push = (minDist - d) / 2;
          const nx = dx / d;
          const ny = dy / d;
          pa.x -= nx * push;
          pa.y -= ny * push;
          pb.x += nx * push;
          pb.y += ny * push;
          moved = true;
        } else if (d <= 0.5) {
          pb.x += 90;
          pb.y += 45;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
}

function resolveOverlapsFixed(
  positions: Map<string, { x: number; y: number }>,
  minDist: number,
  fixed: Set<string>,
  iterations: number,
) {
  const ids = Array.from(positions.keys());
  for (let iter = 0; iter < iterations; iter++) {
    let moved = false;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i];
        const b = ids[j];
        const pa = positions.get(a)!;
        const pb = positions.get(b)!;
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > 0.5 && d < minDist) {
          const push = minDist - d;
          const nx = dx / d;
          const ny = dy / d;
          const aFixed = fixed.has(a);
          const bFixed = fixed.has(b);
          if (aFixed && bFixed) continue; // both locked
          if (aFixed) {
            pb.x += nx * push;
            pb.y += ny * push;
          } else if (bFixed) {
            pa.x -= nx * push;
            pa.y -= ny * push;
          } else {
            pa.x -= (nx * push) / 2;
            pa.y -= (ny * push) / 2;
            pb.x += (nx * push) / 2;
            pb.y += (ny * push) / 2;
          }
          moved = true;
        } else if (d <= 0.5) {
          pb.x += 60;
          pb.y += 40;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
}

// ──────────────────────────────────────
// Build the ReactFlow node + edge lists
// ──────────────────────────────────────

function buildGraph(
  aha: AhaPayload,
  evidence: EvidenceData,
  onSelect: (d: SelectedDetail | null) => void,
  t: TranslationSet,
): { nodes: Node[]; edges: Edge[] } {
  const sceneMems = evidence.memories.filter((m) => !!m.sceneFilename);
  const memsByScene = new Map<string, MemoryPayload[]>();
  for (const m of sceneMems) {
    const k = m.sceneFilename!;
    if (!memsByScene.has(k)) memsByScene.set(k, []);
    memsByScene.get(k)!.push(m);
  }

  const ordered: SceneBundle[] = evidence.scenes
    .filter((s) => memsByScene.has(s.filename))
    .map((scene, idx) => ({
      scene,
      mems: memsByScene.get(scene.filename)!,
      accent: SCENE_ACCENTS[idx % SCENE_ACCENTS.length],
    }));

  if (ordered.length === 0) return { nodes: [], edges: [] };

  const trajIds = new Set((aha.trajectory ?? []).map((tr) => tr.memoryId));
  const layout = organicLayout(ordered, trajIds);

  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // ── Top node — fixed at the visual centre top of the canvas. ──
  nodes.push({
    id: "top",
    type: "topNode",
    position: { x: -TOP_NODE_W / 2, y: 0 },
    draggable: false,
    data: {
      observationSnippet: shortText(aha.observation, 130),
      count: aha.supportingMemoryIds.length,
      noticedLabel: t.aha.noticed,
      evidenceLabel: t.aha.evidenceCount(aha.supportingMemoryIds.length),
      clickLabel: t.aha.clickExpand,
      onClick: () => onSelect({ kind: "top", aha }),
    } satisfies TopNodeData as unknown as Record<string, unknown>,
  });

  // ── Memory nodes (anchor gets scene title; others don't). ──
  for (const { scene, mems, accent } of ordered) {
    const anchorId = layout.anchorOf.get(scene.filename);
    for (const m of mems) {
      const pos = layout.positions.get(m.id);
      if (!pos) continue;
      const isAnchor = m.id === anchorId;
      const sourceIds = m.sourceMessageIds ?? [];
      const convs = sourceIds
        .map((id) => evidence.conversations[id])
        .filter((c): c is ConversationPayload => !!c);
      nodes.push({
        id: `memory:${m.id}`,
        type: "memoryNode",
        position: { x: pos.x - MEMORY_W / 2, y: pos.y - MEMORY_H / 2 },
        draggable: true,
        data: {
          type: m.type,
          priority: m.priority,
          contentSnippet: shortText(m.content, 70),
          sceneAccent: accent.stripe,
          sceneTitle: isAnchor ? shortText(scene.title, 28) : undefined,
          onClick: () =>
            onSelect({
              kind: "memory",
              memory: m,
              conversations: convs,
              sceneAccent: accent.stripe,
              why: (aha.trajectory ?? []).find((tr) => tr.memoryId === m.id)?.why,
            }),
        } satisfies MemoryNodeData as unknown as Record<string, unknown>,
      });
    }
  }

  // ── Within-scene edges: branch memory → anchor (dashed, scene-coloured). ──
  for (const e of layout.withinEdges) {
    edges.push({
      id: `mem-${e.from}-${e.to}`,
      source: `memory:${e.from}`,
      target: `memory:${e.to}`,
      sourceHandle: "up",
      targetHandle: "down-in",
      type: "bezier",
      animated: e.isSpine,
      style: e.isSpine
        ? { stroke: e.sceneColor, strokeWidth: 1.8, opacity: 0.8 }
        : { stroke: e.sceneColor, strokeWidth: 1.3, strokeDasharray: "5 4", opacity: 0.55 },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: e.sceneColor,
        width: 14,
        height: 14,
      },
    });
  }

  // ── Anchor → Top edges: scene-coloured, solid, the visible "convergence". ──
  for (const a of layout.anchorEdges) {
    edges.push({
      id: `anchor-${a.memId}-top`,
      source: `memory:${a.memId}`,
      target: "top",
      sourceHandle: "up",
      type: "bezier",
      style: { stroke: a.sceneColor, strokeWidth: 2.2, opacity: 0.85 },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: a.sceneColor,
        width: 16,
        height: 16,
      },
    });
  }

  return { nodes, edges };
}

// ──────────────────────────────────────
// Component
// ──────────────────────────────────────

export function EvidenceGraph({ aha, evidence, onSelect }: Props) {
  return (
    <ReactFlowProvider>
      <EvidenceGraphInner aha={aha} evidence={evidence} onSelect={onSelect} />
    </ReactFlowProvider>
  );
}

function EvidenceGraphInner({ aha, evidence, onSelect }: Props) {
  const { t } = useI18n();
  const initial = useMemo(
    () => buildGraph(aha, evidence, onSelect, t),
    [aha, evidence, onSelect, t],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const flowRef = useRef<any>(null);

  useEffect(() => {
    setNodes(initial.nodes);
    setEdges(initial.edges);
  }, [initial, setNodes, setEdges]);

  useEffect(() => {
    const refit = () => {
      flowRef.current?.fitView?.({ padding: 0.14, duration: 200 });
    };
    refit();
    const ro = new ResizeObserver(refit);
    const el = document.querySelector(".react-flow") as HTMLElement | null;
    if (el) ro.observe(el);
    window.addEventListener("resize", refit);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", refit);
    };
  }, [initial]);

  return (
    <div style={{ width: "100%", height: "100%", background: COLORS.bg }}>
      <ReactFlow
        onInit={(instance) => { flowRef.current = instance; }}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onPaneClick={() => onSelect(null)}
        fitView
        fitViewOptions={{ padding: 0.14, includeHiddenNodes: false }}
        minZoom={0.05}
        maxZoom={1.8}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={true}
        nodesConnectable={false}
        elementsSelectable={true}
        panOnScroll={false}
        panOnDrag={true}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#E8E8E0" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
