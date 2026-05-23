/**
 * Tiny in-browser bus to share the synced-files state (metadata index + tree
 * handles) between sidebar (publisher) and chat-panel (consumer).
 *
 * Module-level state is per-tab and only initialised after "use client" code
 * runs, so it's safe from SSR.
 */
import type { SyncedFileEntry } from "./synced-files";
import type { FolderTreeNode } from "./synced-files-types";

let _index: SyncedFileEntry[] = [];
let _trees: Array<FolderTreeNode | null> = [];
const listeners = new Set<() => void>();

export function setSyncedFiles(
  index: SyncedFileEntry[],
  trees: Array<FolderTreeNode | null>,
): void {
  _index = index;
  _trees = trees;
  for (const l of listeners) {
    try { l(); } catch (e) { console.error("[synced-files-bus] listener error:", e); }
  }
}

export function getSyncedFilesIndex(): SyncedFileEntry[] {
  return _index;
}

export function getSyncedFolderTrees(): Array<FolderTreeNode | null> {
  return _trees;
}

export function subscribeSyncedFiles(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
