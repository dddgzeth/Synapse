"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import {
  loadFolderHandles,
  saveFolderHandle,
  removeFolderHandle,
  queryReadPermission,
  requestReadPermission,
} from "@/lib/folder-cache";
import { collectSyncedFilesIndex } from "@/lib/synced-files";
import { setSyncedFiles } from "@/lib/synced-files-bus";
import type { FolderTreeNode } from "@/lib/synced-files-types";

interface SceneBlock {
  filename: string;
  title: string;
  summary: string;
  heat: number;
  updated: string;
  content: string;
}

interface RecentMemory {
  id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  updatedAt: string;
}

interface MemoriesData {
  l0Count: number;
  l1Count: number;
  persona: string | null;
  scenes: SceneBlock[];
  recentMemories: RecentMemory[];
}

interface TreeNode {
  name: string;
  path: string;
  kind: "file" | "directory";
  handle: any;
  children?: TreeNode[];
  isText?: boolean;
  isImage?: boolean;
  uploaded?: boolean;
}

interface SyncedFolder {
  name: string;
  rootHandle: any;
  tree: TreeNode | null;          // null while still waiting for permission
  scannedAt: string;              // when the tree was scanned/restored
  totalFiles: number;             // # of text files visible to LLM
  permission: "granted" | "prompt" | "denied";
  fromCache: boolean;             // restored from IDB (vs freshly picked)
}

const TEXT_EXTS = [".txt", ".md", ".tex", ".rst", ".csv", ".json", ".yaml", ".yml"];
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

function classifyFile(name: string): { isText: boolean; isImage: boolean } {
  const lower = name.toLowerCase();
  return {
    isText: TEXT_EXTS.some((e) => lower.endsWith(e)),
    isImage: IMAGE_EXTS.some((e) => lower.endsWith(e)),
  };
}

const TYPE_CONFIG: Record<string, { color: string; label: string }> = {
  claim:       { color: "#7C6EF7", label: "观点" },
  method:      { color: "#3B82F6", label: "方法" },
  observation: { color: "#F59E0B", label: "观察" },
  dataset:     { color: "#10B981", label: "资源" },
  experiment:  { color: "#EF4444", label: "任务" },
  finding:     { color: "#8B5CF6", label: "发现" },
  question:    { color: "#06B6D4", label: "问题" },
  goal:        { color: "#6B7280", label: "目标" },
};

// Custom event ChatPanel dispatches when L0/L1 may have changed → sidebar refetches.
const REFRESH_EVENT = "synapse:memory-update";

export function Sidebar() {
  const [data, setData] = useState<MemoriesData | null>(null);
  const [folders, setFolders] = useState<SyncedFolder[]>([]);
  const [uploading, setUploading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MemoriesData["recentMemories"] | null>(null);
  const [searching, setSearching] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  // Per-folder ephemeral scan progress: { [folderName]: discoveredFileCount }.
  // Lives in component state because it's transient and not part of SyncedFolder.
  const [scanProgress, setScanProgress] = useState<Record<string, number>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchTimeout = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    fetch("/api/memories")
      .then((r) => r.json())
      .then(setData)
      .catch(console.error);
  }, [refreshTick]);

  // Listen for cross-component refresh signal (chat sent a message, files uploaded, etc.).
  useEffect(() => {
    const onRefresh = () => setRefreshTick((n) => n + 1);
    window.addEventListener(REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(REFRESH_EVENT, onRefresh);
  }, []);

  // Restore previously connected folders from IndexedDB on mount.
  // Permission status of "granted" → re-scan tree immediately.
  // Permission status of "prompt"/"denied" → show a "重新授权" button on the card.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cached = await loadFolderHandles();
        if (cached.length === 0 || cancelled) return;
        const restored: SyncedFolder[] = [];
        for (const { name, handle } of cached) {
          let perm: PermissionState = "prompt";
          try {
            perm = await queryReadPermission(handle);
          } catch { perm = "prompt"; }
          let tree: TreeNode | null = null;
          let total = 0;
          if (perm === "granted") {
            try {
              setScanProgress((p) => ({ ...p, [name]: 0 }));
              tree = await scanTree(handle, handle.name, () => {
                setScanProgress((p) => ({ ...p, [name]: (p[name] ?? 0) + 1 }));
              });
              total = flattenFiles(tree).filter((n) => n.isText).length;
            } catch (err) {
              console.warn("[sidebar] restore scan failed for", name, err);
            } finally {
              setScanProgress((p) => { const n = { ...p }; delete n[handle.name]; return n; });
            }
          }
          restored.push({
            name,
            rootHandle: handle,
            tree,
            scannedAt: "已缓存",
            totalFiles: total,
            permission: perm as SyncedFolder["permission"],
            fromCache: true,
          });
        }
        if (!cancelled) setFolders(restored);
      } catch (err) {
        console.warn("[sidebar] folder cache restore failed:", err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Publish synced-files state to bus whenever folders/tree change.
  // chat-panel reads from the bus on each sendMessage to populate body.
  useEffect(() => {
    const trees: Array<FolderTreeNode | null> = folders.map((f) => f.tree as FolderTreeNode | null);
    (async () => {
      try {
        const index = await collectSyncedFilesIndex(trees);
        setSyncedFiles(index, trees);
      } catch (err) {
        console.warn("[sidebar] collectSyncedFilesIndex failed:", err);
        setSyncedFiles([], trees);
      }
    })();
  }, [folders]);

  // Debounced search
  useEffect(() => {
    clearTimeout(searchTimeout.current);
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    searchTimeout.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}`);
        if (r.ok) {
          const d = await r.json();
          setSearchResults(d.results ?? []);
        }
      } catch { /* ignore */ }
      setSearching(false);
    }, 400);
  }, [searchQuery]);

  async function connectFolder() {
    if (!("showDirectoryPicker" in window)) {
      fileInputRef.current?.click();
      return;
    }
    try {
      const handle = await (window as any).showDirectoryPicker({ mode: "read" });
      setUploading(true);
      setScanProgress((p) => ({ ...p, [handle.name]: 0 }));
      const tree = await scanTree(handle, handle.name, () => {
        setScanProgress((p) => ({ ...p, [handle.name]: (p[handle.name] ?? 0) + 1 }));
      });
      setScanProgress((p) => { const n = { ...p }; delete n[handle.name]; return n; });
      const allFiles = flattenFiles(tree);
      // Files are NOT auto-ingested. L0 is only created when the user
      // actively references a file in chat (click → attach → send).
      const folderEntry: SyncedFolder = {
        name: handle.name,
        rootHandle: handle,
        tree,
        scannedAt: new Date().toLocaleTimeString("zh-CN"),
        totalFiles: allFiles.filter((f) => f.isText).length,
        permission: "granted",
        fromCache: false,
      };
      setFolders((prev) => [...prev.filter((f) => f.name !== handle.name), folderEntry]);
      saveFolderHandle(handle.name, handle).catch((err) =>
        console.warn("[sidebar] failed to cache folder handle:", err),
      );
      setUploading(false);
    } catch (err: any) {
      if (err?.name !== "AbortError") console.error(err);
      setUploading(false);
    }
  }

  // Re-authorize a previously-cached folder when the browser downgraded
  // permission. Must be triggered from a user click.
  async function reauthorizeFolder(name: string) {
    const folder = folders.find((f) => f.name === name);
    if (!folder) return;
    try {
      const perm = await requestReadPermission(folder.rootHandle);
      if (perm !== "granted") {
        setFolders((prev) =>
          prev.map((f) => (f.name === name ? { ...f, permission: perm as SyncedFolder["permission"] } : f)),
        );
        return;
      }
      setScanProgress((p) => ({ ...p, [name]: 0 }));
      const tree = await scanTree(folder.rootHandle, folder.rootHandle.name, () => {
        setScanProgress((p) => ({ ...p, [name]: (p[name] ?? 0) + 1 }));
      });
      setScanProgress((p) => { const n = { ...p }; delete n[name]; return n; });
      const totalText = flattenFiles(tree).filter((n) => n.isText).length;
      setFolders((prev) =>
        prev.map((f) => f.name === name
          ? { ...f, tree, totalFiles: totalText, permission: "granted" }
          : f,
        ),
      );
    } catch (err) {
      console.warn("[sidebar] reauthorize failed:", err);
    }
  }

  // Single-file fallback for browsers without showDirectoryPicker.
  // Mirrors handleFileClick: the file is attached to the chat input,
  // NOT auto-ingested into L0. L0 happens when user types a prompt and sends.
  async function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const isImage = file.type.startsWith("image/");
    const isText = !isImage && /\.(txt|md|tex|rst|csv|json|ya?ml)$/i.test(file.name);
    let content = "";
    let url = "";
    if (isImage) {
      url = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result as string);
        r.onerror = rej;
        r.readAsDataURL(file);
      });
    } else if (isText) {
      content = await file.text();
    }
    window.dispatchEvent(
      new CustomEvent("synapse:attach-file", {
        detail: {
          name: file.name,
          shortName: file.name,
          mediaType: file.type || (isImage ? "image/png" : "text/plain"),
          content,
          url,
          isImage,
        },
      }),
    );
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeFolder(name: string) {
    setFolders((prev) => prev.filter((f) => f.name !== name));
    removeFolderHandle(name).catch((err) =>
      console.warn("[sidebar] failed to remove cached handle:", err),
    );
  }

  async function handleFileClick(node: TreeNode) {
    try {
      const fileHandle = node.handle as FileSystemFileHandle;
      const file = await fileHandle.getFile();
      let content = "";
      let url = "";
      if (node.isImage) {
        url = await new Promise<string>((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result as string);
          r.onerror = rej;
          r.readAsDataURL(file);
        });
      } else if (node.isText) {
        content = await file.text();
      } else {
        // unsupported binary — still let user attach by name
        content = "";
      }
      window.dispatchEvent(
        new CustomEvent("synapse:attach-file", {
          detail: {
            name: node.path,
            shortName: node.name,
            mediaType: file.type || (node.isImage ? "image/png" : "text/plain"),
            content,
            url,
            isImage: node.isImage,
          },
        }),
      );
    } catch (err) {
      console.error("[sidebar] file click failed:", err);
    }
  }

  const displayMemories = searchResults ?? data?.recentMemories ?? [];

  return (
    <div style={{
      width: 272, minWidth: 272, background: "var(--sidebar-bg)",
      borderRight: "1px solid var(--border)",
      display: "flex", flexDirection: "column", overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{ padding: "14px 16px 10px" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logo-horizontal.jpg"
          alt="Synapse"
          style={{ height: 40, width: "auto", mixBlendMode: "multiply", display: "block", marginLeft: -4 }}
        />
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
          {data ? `${data.l1Count} 条记忆 · ${Math.round(data.l0Count / 2)} 轮` : "载入中…"}
        </div>
      </div>

      {/* Search */}
      <div style={{ padding: "0 12px 12px" }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          background: "var(--surface)", border: "1px solid var(--border)",
          borderRadius: 8, padding: "7px 10px",
        }}>
          <span style={{ color: "var(--text-muted)", fontSize: 14, flexShrink: 0 }}>🔍</span>
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索记忆…"
            style={{
              flex: 1, background: "none", border: "none", outline: "none",
              color: "var(--text)", fontSize: 13, fontFamily: "inherit",
            }}
          />
          {searching && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>⋯</span>}
          {searchQuery && !searching && (
            <button
              onClick={() => setSearchQuery("")}
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 14, padding: 0 }}
            >×</button>
          )}
        </div>
      </div>

      <div className="scrollbar-thin" style={{ flex: 1, overflowY: "auto" }}>

        {/* Search Results */}
        {searchResults !== null && (
          <Section label={`搜索结果 (${searchResults.length})`}>
            {searchResults.length === 0 ? (
              <div style={{ padding: "8px 14px", fontSize: 12, color: "var(--text-muted)" }}>无匹配记忆</div>
            ) : (
              searchResults.slice(0, 10).map((m) => <MemoryRow key={m.id} m={m} />)
            )}
          </Section>
        )}

        {/* Local Folders */}
        {searchResults === null && (
          <Section label="本地文件夹">
            {folders.map((f) => (
              <FolderTree
                key={f.name}
                folder={f}
                scanInProgress={scanProgress[f.name] ?? undefined}
                onFileClick={handleFileClick}
                onRemove={() => removeFolder(f.name)}
                onReauthorize={() => reauthorizeFolder(f.name)}
              />
            ))}
            <button
              onClick={connectFolder}
              disabled={uploading}
              style={{
                width: "calc(100% - 28px)", margin: "4px 14px",
                padding: "7px 10px", background: uploading ? "var(--surface-2)" : "var(--surface)",
                border: "1px dashed var(--border)", borderRadius: 8,
                color: uploading ? "var(--text-muted)" : "var(--accent)",
                cursor: uploading ? "wait" : "pointer", fontSize: 12,
                fontWeight: uploading ? 400 : 600,
              }}
            >
              {uploading ? "扫描中…" : "+ 连接文件夹"}
            </button>
            <input ref={fileInputRef} type="file" accept=".txt,.md,.pdf,.tex,.csv" style={{ display: "none" }} onChange={handleFileInput} />
          </Section>
        )}

        {/* L3 Persona — link to /persona */}
        {searchResults === null && data?.persona && (
          <Section label="个人画像 (L3)">
            <PersonaLink />
          </Section>
        )}

        {/* L2 Scenes — each row links to /scenes/[filename] */}
        {searchResults === null && data && data.scenes.length > 0 && (
          <Section label={`主题场景 (L2 · ${data.scenes.length})`}>
            {data.scenes.map((scene) => <SceneRow key={scene.filename} scene={scene} />)}
          </Section>
        )}

        {/* Recent Memories — each row links to /memories/[id] */}
        {searchResults === null && data && data.recentMemories.length > 0 && (
          <Section label={`最近记忆 (L1 · ${data.recentMemories.length})`}>
            {data.recentMemories.slice(0, 15).map((m) => <MemoryRow key={m.id} m={m} />)}
          </Section>
        )}

        {searchResults === null && data && data.recentMemories.length === 0 && (
          <div style={{ padding: "20px 14px", textAlign: "center" }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>🌱</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
              开始对话后，Synapse 会在这里积累你的工作记忆。
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MemoryRow({ m }: { m: { id: string; content: string; type: string; scene_name?: string } }) {
  const cfg = TYPE_CONFIG[m.type] ?? { color: "#6B7280", label: m.type };
  return (
    <a
      href={`/memories/${encodeURIComponent(m.id)}`}
      onClick={(e) => {
        // Plain left-click → modal. Modifier keys (cmd/ctrl/middle) fall through
        // to default navigation so right-click "open in new tab" still works.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("synapse:open-detail", {
          detail: { kind: "memory", id: m.id },
        }));
      }}
      style={{
        display: "block",
        padding: "6px 14px",
        textDecoration: "none",
        color: "inherit",
        transition: "background 0.12s",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 3 }}>
        <span style={{
          fontSize: 10, padding: "1px 5px",
          background: `${cfg.color}18`, color: cfg.color,
          borderRadius: 4, fontWeight: 600, flexShrink: 0,
        }}>
          {cfg.label}
        </span>
        {m.scene_name && (
          <span style={{
            fontSize: 10, color: "var(--text-muted)", overflow: "hidden",
            textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1,
          }}>· {m.scene_name}</span>
        )}
      </div>
      <div style={{
        fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5,
        display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2,
        overflow: "hidden",
      }}>
        {m.content}
      </div>
    </a>
  );
}

function SceneRow({ scene }: { scene: SceneBlock }) {
  return (
    <a
      href={`/scenes/${encodeURIComponent(scene.filename)}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("synapse:open-detail", {
          detail: { kind: "scene", filename: scene.filename },
        }));
      }}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "6px 12px", textDecoration: "none", color: "inherit",
        userSelect: "none", transition: "background 0.12s",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <span style={{ fontSize: 12, flexShrink: 0 }}>📑</span>
      <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
        <div style={{
          fontSize: 12, color: "var(--text)", fontWeight: 600,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{scene.title}</div>
        <div style={{
          fontSize: 10, color: "var(--text-muted)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{scene.summary}</div>
      </div>
      <span style={{
        fontSize: 9, padding: "1px 5px", borderRadius: 8,
        background: "var(--surface-2)", color: "var(--text-muted)", flexShrink: 0,
      }}>🔥{scene.heat}</span>
    </a>
  );
}

function PersonaLink() {
  return (
    <div style={{ padding: "2px 12px 6px" }}>
      <Link
        href="/persona"
        style={{
          display: "block", padding: "8px 12px",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 8, textDecoration: "none",
          color: "var(--accent)", fontWeight: 600, fontSize: 12,
          transition: "background 0.12s",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--insight)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "var(--surface)")}
      >
        📖 查看完整画像 →
      </Link>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 8, paddingBottom: 8, borderBottom: "1px solid var(--border)" }}>
      <div style={{
        padding: "8px 14px 5px", fontSize: 10, fontWeight: 700,
        color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em",
      }}>
        {label}
      </div>
      {children}
    </div>
  );
}

async function scanTree(
  dirHandle: any,
  path: string,
  onFile?: () => void,
): Promise<TreeNode> {
  const children: TreeNode[] = [];
  try {
    for await (const [name, handle] of dirHandle.entries()) {
      if (name.startsWith(".")) continue;
      const childPath = `${path}/${name}`;
      if (handle.kind === "directory") {
        children.push(await scanTree(handle, childPath, onFile));
      } else {
        const { isText, isImage } = classifyFile(name);
        children.push({
          name, path: childPath, kind: "file", handle, isText, isImage,
        });
        onFile?.();
      }
    }
  } catch (err) {
    console.warn("[sidebar] scan failed for", path, err);
  }
  children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { name: dirHandle.name, path, kind: "directory", handle: dirHandle, children };
}

function flattenFiles(node: TreeNode): TreeNode[] {
  if (node.kind === "file") return [node];
  return (node.children ?? []).flatMap(flattenFiles);
}

function FolderTree({
  folder,
  scanInProgress,
  onFileClick,
  onRemove,
  onReauthorize,
}: {
  folder: SyncedFolder;
  scanInProgress?: number;
  onFileClick: (node: TreeNode) => void;
  onRemove: () => void;
  onReauthorize: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const needsAuth = folder.permission !== "granted";
  const scanning = scanInProgress !== undefined;
  const statusLine = needsAuth
    ? "需重新授权"
    : scanning
      ? `扫描中… 已发现 ${scanInProgress} 个`
      : "已就绪";
  return (
    <div style={{ padding: "2px 8px 6px" }}>
      <div
        style={{
          display: "flex", alignItems: "center", gap: 4,
          padding: "4px 6px", borderRadius: 6,
          cursor: "pointer", userSelect: "none",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        <span
          onClick={() => setExpanded((v) => !v)}
          style={{
            width: 12, fontSize: 9, color: "var(--text-muted)",
            transform: expanded ? "rotate(90deg)" : "none",
            transition: "transform 0.12s",
            display: "inline-block", textAlign: "center",
          }}
        >▶</span>
        <span style={{ fontSize: 13 }} onClick={() => setExpanded((v) => !v)}>
          {needsAuth ? "🔒" : "📁"}
        </span>
        <div
          style={{ flex: 1, minWidth: 0, overflow: "hidden" }}
          onClick={() => setExpanded((v) => !v)}
        >
          <div style={{
            fontSize: 12, color: "var(--text)", fontWeight: 600,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>{folder.name}</div>
          <div style={{ fontSize: 10, color: needsAuth ? "var(--accent)" : "var(--text-muted)" }}>
            {statusLine}
          </div>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          title="移除"
          style={{
            background: "none", border: "none", cursor: "pointer",
            color: "var(--text-muted)", fontSize: 14, padding: 2, lineHeight: 1,
          }}
        >×</button>
      </div>
      {needsAuth && (
        <button
          onClick={onReauthorize}
          style={{
            margin: "4px 0 4px 24px", padding: "4px 10px",
            background: "var(--surface)", border: "1px solid var(--accent)",
            borderRadius: 5, color: "var(--accent)", cursor: "pointer",
            fontSize: 11, fontWeight: 600,
          }}
        >
          重新授权访问
        </button>
      )}
      {expanded && folder.tree?.children && (
        <div style={{ marginLeft: 14 }}>
          {folder.tree.children.map((child) => (
            <TreeNodeView key={child.path} node={child} depth={0} onFileClick={onFileClick} />
          ))}
        </div>
      )}
    </div>
  );
}

function TreeNodeView({
  node, depth, onFileClick,
}: {
  node: TreeNode;
  depth: number;
  onFileClick: (node: TreeNode) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const indent = depth * 10;
  if (node.kind === "directory") {
    return (
      <div>
        <div
          onClick={() => setExpanded((v) => !v)}
          style={{
            display: "flex", alignItems: "center", gap: 4,
            padding: "3px 6px", paddingLeft: 6 + indent,
            cursor: "pointer", borderRadius: 5, userSelect: "none",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <span style={{
            width: 10, fontSize: 8, color: "var(--text-muted)",
            transform: expanded ? "rotate(90deg)" : "none",
            transition: "transform 0.12s",
            display: "inline-block", textAlign: "center",
          }}>▶</span>
          <span style={{ fontSize: 12 }}>📂</span>
          <span
            onClick={(e) => e.stopPropagation()}
            style={{
              fontSize: 12, color: "var(--text)",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              userSelect: "text", cursor: "text",
            }}
          >{node.name}</span>
          <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: "auto", flexShrink: 0 }}>
            {node.children?.length ?? 0}
          </span>
        </div>
        {expanded && node.children && (
          <div>
            {node.children.map((child) => (
              <TreeNodeView key={child.path} node={child} depth={depth + 1} onFileClick={onFileClick} />
            ))}
          </div>
        )}
      </div>
    );
  }
  const clickable = node.isText || node.isImage;
  const icon = node.isImage ? "🖼️" : node.isText ? "📄" : "📦";
  return (
    <div
      onClick={() => clickable && onFileClick(node)}
      title={clickable ? "点击挂到输入框，针对此文件提问" : "暂不支持该文件类型"}
      style={{
        display: "flex", alignItems: "center", gap: 4,
        padding: "3px 6px", paddingLeft: 20 + indent,
        cursor: clickable ? "pointer" : "default",
        borderRadius: 5, userSelect: "none",
        opacity: clickable ? 1 : 0.45,
      }}
      onMouseEnter={(e) => { if (clickable) e.currentTarget.style.background = "var(--insight)"; }}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <span style={{ fontSize: 11 }}>{icon}</span>
      <span
        onClick={(e) => e.stopPropagation()}
        style={{
          fontSize: 12, color: "var(--text-muted)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          userSelect: "text", cursor: "text",
        }}
      >{node.name}</span>
    </div>
  );
}
