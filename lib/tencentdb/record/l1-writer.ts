/**
 * L1 Memory Writer — adapted from TencentDB Agent Memory.
 *
 * v3 aligned: 3 memory types → Synapse research types (8 types).
 * Only change from TencentDB: MemoryType values + metadata.ontology_label.
 */

import crypto from "node:crypto";

// ============================
// Types (Synapse research types — only deviation from TencentDB)
// ============================

export type MemoryType =
  | "claim"        // research claim / conclusion
  | "method"       // method / technique
  | "observation"  // experimental observation / data phenomenon
  | "dataset"      // dataset / data description
  | "experiment"   // experiment design / execution
  | "finding"      // finding / result
  | "question"     // open question / research gap
  | "goal";        // research goal / direction

export interface EpisodicMetadata {
  activity_start_time?: string;
  activity_end_time?: string;
  ontology_label?: string; // e.g. "prov:Entity", "iao:information-content-entity"
}

export interface MemoryRecord {
  id: string;
  content: string;
  type: MemoryType;
  priority: number;
  scene_name: string;
  source_message_ids: string[];
  metadata: EpisodicMetadata | Record<string, never>;
  timestamps: string[];
  createdAt: string;
  updatedAt: string;
  sessionKey: string;
  sessionId: string;
}

export interface ExtractedMemory {
  content: string;
  type: MemoryType;
  priority: number;
  source_message_ids: string[];
  metadata: EpisodicMetadata | Record<string, never>;
  scene_name: string;
}

export type DedupAction = "store" | "update" | "merge" | "skip";

export interface DedupDecision {
  record_id: string;
  action: DedupAction;
  target_ids: string[];
  merged_content?: string;
  merged_type?: MemoryType;
  merged_priority?: number;
  merged_timestamps?: string[];
}

export function generateMemoryId(): string {
  return `m_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}
