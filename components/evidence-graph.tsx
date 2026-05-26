/**
 * EvidenceGraph — interactive xyflow canvas for an Aha's evidence chain.
 *
 * Layout (no edges from scene → memory — visual grouping replaces them):
 *
 *   ┌─ Top "Synapse 注意到" (warm orange gradient) ─┐
 *   │           observation snippet                 │
 *   └─────────────┬─────────────────────────────────┘
 *                 │ (single accent line)
 *      ┌──────────┴──────────┐
 *      │                     │
 *   Scene A (cream)        杂项 (warm gray)
 *   │ │ │ │                │
 *   memory grid (4 cols)   memory grid
 *
 * Each memory carries a 3px top stripe in the parent scene's accent color so
 * "which scene owns this memory" reads without explicit edges.
 *
 * Nodes are draggable (user can rearrange anything).
 */
"use client";

import { useEffect, useMemo } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
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

export interface AhaPayload {
  pattern: string;
  observation: string;
  hypothesis: string;
  reframe: string;
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
  | { kind: "memory"; memory: MemoryPayload; conversations: ConversationPayload[]; sceneAccent: string };

interface Props {
  aha: AhaPayload;
  evidence: EvidenceData;
  onSelect: (detail: SelectedDetail) => void;
}

// ──────────────────────────────────────
// Palette — Synapse warm cream + Anthropic orange accent
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

// Per-scene accent so memories under each scene read as a group.
// Cycled across scenes; misc scene is muted gray.
const SCENE_ACCENTS = [
  { stripe: "#D97757", soft: "#FFF0E8", border: "#F0D4C4", text: "#7A2E10" },
  { stripe: "#5B7DB1", soft: "#EEF3FA", border: "#CFDDED", text: "#1F3C66" },
  { stripe: "#7AA66D", soft: "#F0F6EC", border: "#D4E5CD", text: "#2E4A24" },
  { stripe: "#A583E0", soft: "#F4ECFB", border: "#DECFEE", text: "#4D2A8A" },
];
const MISC_ACCENT = { stripe: "#A8A8A0", soft: "#F2F2EC", border: "#DCDCD2", text: "#5A5A50" };

// Memory type — muted earthy palette, the type label is the colored chip
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
// Custom node components
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
        boxShadow: "0 6px 20px rgba(217, 119, 87, 0.12), 0 1px 3px rgba(0,0,0,0.04)",
        cursor: "pointer",
        fontFamily: "system-ui, sans-serif",
        transition: "transform 120ms ease, box-shadow 120ms ease",
      }}
    >
      <div style={{
        display: "flex", alignItems: "center", gap: 7,
        fontSize: 10.5, fontWeight: 700, color: COLORS.accent,
        textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 10,
      }}>
        <span style={{ fontSize: 13 }}>✨</span>
        <span>{d.noticedLabel}</span>
      </div>
      <div style={{
        fontSize: 13.5, lineHeight: 1.65, color: COLORS.text, fontWeight: 450,
      }}>
        {d.observationSnippet}
      </div>
      <div style={{
        marginTop: 12, paddingTop: 10, borderTop: `1px solid ${COLORS.border}`,
        fontSize: 11, color: COLORS.textMuted, display: "flex", justifyContent: "space-between",
      }}>
        <span>{d.evidenceLabel}</span>
        <span style={{ color: COLORS.accent, fontWeight: 600 }}>{d.clickLabel}</span>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}

interface SceneNodeData {
  title: string;
  summary: string;
  memoryCount: number;
  maxPriority: number;
  accent: typeof SCENE_ACCENTS[number];
  isMisc: boolean;
  miscLabel: string;
  sceneLabel: string;
  onClick: () => void;
}

function SceneNode({ data }: NodeProps) {
  const d = data as unknown as SceneNodeData;
  const a = d.accent;
  return (
    <div
      onClick={d.onClick}
      style={{
        width: 280,
        padding: "13px 15px",
        background: COLORS.surface,
        border: `1px solid ${a.border}`,
        borderTop: `3px solid ${a.stripe}`,
        borderRadius: 10,
        boxShadow: "0 2px 8px rgba(0,0,0,0.05)",
        cursor: "pointer",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div style={{
        fontSize: 10, fontWeight: 700, color: a.stripe, marginBottom: 6,
        textTransform: "uppercase", letterSpacing: 1,
      }}>
        {d.isMisc ? d.miscLabel : d.sceneLabel}
      </div>
      <div style={{
        fontSize: 14, fontWeight: 600, color: a.text,
        marginBottom: 6, lineHeight: 1.4,
      }}>
        {d.title}
      </div>
      <div style={{
        fontSize: 11.5, color: COLORS.textMuted,
        lineHeight: 1.5, marginBottom: 10,
      }}>
        {shortText(d.summary, 70)}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <span style={statBadge(a.stripe)}>M{d.memoryCount}</span>
        <span style={statBadge(a.stripe)}>P{d.maxPriority}</span>
      </div>
    </div>
  );
}

interface MemoryNodeData {
  type: string;
  priority: number;
  contentSnippet: string;
  sceneAccent: string;
  onClick: () => void;
}

function MemoryNode({ data }: NodeProps) {
  const d = data as unknown as MemoryNodeData;
  const chipColor = chipForType(d.type);
  return (
    <div
      onClick={d.onClick}
      style={{
        width: 230,
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderTop: `3px solid ${d.sceneAccent}`,
        borderRadius: 8,
        boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
        cursor: "pointer",
        fontFamily: "system-ui, sans-serif",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "9px 11px 10px" }}>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          marginBottom: 6,
        }}>
          <span style={{
            fontSize: 9.5, fontWeight: 700, color: "#fff",
            background: chipColor, padding: "2px 7px", borderRadius: 3,
            textTransform: "uppercase", letterSpacing: 0.7,
          }}>
            {d.type}
          </span>
          <span style={{
            fontSize: 10, color: COLORS.textMuted, fontWeight: 600,
          }}>
            P{d.priority}
          </span>
        </div>
        <div style={{
          fontSize: 11.5, color: COLORS.text, lineHeight: 1.5,
        }}>
          {d.contentSnippet}
        </div>
      </div>
    </div>
  );
}

function statBadge(color: string): React.CSSProperties {
  return {
    fontSize: 10,
    fontWeight: 700,
    color: "#fff",
    background: color,
    padding: "2px 7px",
    borderRadius: 4,
    letterSpacing: 0.4,
  };
}

const nodeTypes = {
  topNode: TopNode,
  sceneNode: SceneNode,
  memoryNode: MemoryNode,
};

// ──────────────────────────────────────
// Layout: deterministic, swimlane-style
// ──────────────────────────────────────

const MEMORY_W = 230;
const MEMORY_H = 92;
const MEMORY_GAP_X = 14;
const MEMORY_GAP_Y = 12;
const MEMS_PER_ROW = 4;
const SCENE_W = 280;
const SCENE_GAP = 80;
const TOP_NODE_H = 240;   // ample room for a 4-5 line observation + footer
const SCENE_Y = TOP_NODE_H + 60;       // 300
const SCENE_NODE_H = 160;              // scene card incl. heading + summary + stats
const MEMORY_BLOCK_Y = SCENE_Y + SCENE_NODE_H + 40; // 500

function buildGraph(
  aha: AhaPayload,
  evidence: EvidenceData,
  onSelect: (d: SelectedDetail) => void,
  t: TranslationSet,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Group memories by sceneFilename (null → "__misc__"), preserve order
  const memsByScene = new Map<string, MemoryPayload[]>();
  for (const m of evidence.memories) {
    const key = m.sceneFilename ?? "__misc__";
    if (!memsByScene.has(key)) memsByScene.set(key, []);
    memsByScene.get(key)!.push(m);
  }

  // Scene columns: real scenes (by maxPriority desc), then misc
  const sceneOrder: Array<{ key: string; scene: ScenePayload | null; mems: MemoryPayload[]; accent: typeof SCENE_ACCENTS[number] | typeof MISC_ACCENT }> = [];
  let accentIdx = 0;
  for (const s of evidence.scenes) {
    const mems = memsByScene.get(s.filename) ?? [];
    if (mems.length === 0) continue;
    sceneOrder.push({
      key: s.filename,
      scene: s,
      mems,
      accent: SCENE_ACCENTS[accentIdx % SCENE_ACCENTS.length],
    });
    accentIdx++;
  }
  if (memsByScene.has("__misc__")) {
    sceneOrder.push({
      key: "__misc__",
      scene: null,
      mems: memsByScene.get("__misc__")!,
      accent: MISC_ACCENT,
    });
  }

  // Each scene block width = max(scene node width, grid width)
  const sceneBlockWidths = sceneOrder.map(({ mems }) => {
    const cols = Math.min(mems.length, MEMS_PER_ROW);
    const gridW = cols * MEMORY_W + (cols - 1) * MEMORY_GAP_X;
    return Math.max(SCENE_W, gridW);
  });
  const totalWidth =
    sceneBlockWidths.reduce((s, w) => s + w, 0) +
    SCENE_GAP * Math.max(0, sceneOrder.length - 1);

  // ── Top node (centered) ──
  const TOP_W = 360;
  const TOP_X = totalWidth / 2 - TOP_W / 2;
  nodes.push({
    id: "top",
    type: "topNode",
    position: { x: TOP_X, y: 0 },
    data: {
      observationSnippet: shortText(aha.observation, 130),
      count: aha.supportingMemoryIds.length,
      noticedLabel: t.aha.noticed,
      evidenceLabel: t.aha.evidenceCount(aha.supportingMemoryIds.length),
      clickLabel: t.aha.clickExpand,
      onClick: () => onSelect({ kind: "top", aha }),
    } satisfies TopNodeData as unknown as Record<string, unknown>,
  });

  // ── Scene + memory grid ──
  let cursorX = 0;
  sceneOrder.forEach(({ key, scene, mems, accent }, sceneIdx) => {
    const blockW = sceneBlockWidths[sceneIdx];
    const blockCenter = cursorX + blockW / 2;
    const sceneX = blockCenter - SCENE_W / 2;
    const sceneId = `scene:${key}`;

    nodes.push({
      id: sceneId,
      type: "sceneNode",
      position: { x: sceneX, y: SCENE_Y },
      data: {
        title: scene?.title ?? t.aha.misc,
        summary: scene?.summary ?? t.aha.miscSummary(mems.length),
        memoryCount: scene?.memoryCount ?? mems.length,
        maxPriority: scene?.maxPriority ?? Math.max(...mems.map((m) => m.priority ?? 0)),
        accent,
        isMisc: !scene,
        miscLabel: t.aha.misc,
        sceneLabel: t.aha.scene,
        onClick: () => onSelect({
          kind: "scene",
          scene: scene
            ? scene
            : {
                filename: null,
                title: t.aha.misc,
                summary: t.aha.miscSummary(mems.length),
                memoryCount: mems.length,
                maxPriority: Math.max(...mems.map((m) => m.priority ?? 0)),
                heat: 0,
              },
        }),
      } satisfies SceneNodeData as unknown as Record<string, unknown>,
    });

    // Single top → scene edge (the only edges in the graph)
    edges.push({
      id: `top-${sceneId}`,
      source: "top",
      target: sceneId,
      type: "smoothstep",
      style: { stroke: accent.stripe, strokeWidth: 1.5, opacity: 0.7 },
    });

    // Memory grid (4 cols, wrap to multiple rows)
    const cols = Math.min(mems.length, MEMS_PER_ROW);
    const gridW = cols * MEMORY_W + (cols - 1) * MEMORY_GAP_X;
    const gridStartX = blockCenter - gridW / 2;
    mems.forEach((m, mIdx) => {
      const row = Math.floor(mIdx / MEMS_PER_ROW);
      const col = mIdx % MEMS_PER_ROW;
      const memX = gridStartX + col * (MEMORY_W + MEMORY_GAP_X);
      const memY = MEMORY_BLOCK_Y + row * (MEMORY_H + MEMORY_GAP_Y);
      const memId = `memory:${m.id}`;
      const sourceIds = m.sourceMessageIds ?? [];
      const conversations = sourceIds
        .map((id) => evidence.conversations[id])
        .filter((c): c is ConversationPayload => !!c);
      nodes.push({
        id: memId,
        type: "memoryNode",
        position: { x: memX, y: memY },
        data: {
          type: m.type,
          priority: m.priority,
          contentSnippet: shortText(m.content, 78),
          sceneAccent: accent.stripe,
          onClick: () => onSelect({
            kind: "memory",
            memory: m,
            conversations,
            sceneAccent: accent.stripe,
          }),
        } satisfies MemoryNodeData as unknown as Record<string, unknown>,
      });
      // NO scene → memory edges. The matching top stripe color groups them.
    });

    cursorX += blockW + SCENE_GAP;
  });

  return { nodes, edges };
}

// ──────────────────────────────────────
// Component
// ──────────────────────────────────────

export function EvidenceGraph({ aha, evidence, onSelect }: Props) {
  const { t } = useI18n();
  const initial = useMemo(
    () => buildGraph(aha, evidence, onSelect, t),
    [aha, evidence, onSelect, t],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);

  // Re-sync local state when the underlying aha/evidence changes.
  // Without this, switching to a different historic Aha keeps the old graph.
  useEffect(() => {
    setNodes(initial.nodes);
    setEdges(initial.edges);
  }, [initial, setNodes, setEdges]);

  return (
    <div style={{ width: "100%", height: "100%", background: COLORS.bg }}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          fitView
          fitViewOptions={{ padding: 0.18, includeHiddenNodes: false }}
          minZoom={0.3}
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
      </ReactFlowProvider>
    </div>
  );
}
