"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
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
import { useI18n, type ApiSettings } from "./i18n";
import { SynnyMascot } from "./synny-mascot";

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

interface SearchHit {
  recordId: string;
  sessionKey: string;
  sessionTitle: string;
  role: string;
  snippet: string;
  recordedAt: string;
}

interface ChatSession {
  sessionKey: string;
  title: string;
  lastMessageAt: string;
  messageCount: number;
}

interface MemoriesData {
  l0Count: number;
  l1Count: number;
  persona: string | null;
  scenes: SceneBlock[];
  recentMemories: RecentMemory[];
}

interface AhaHistoryItem {
  id: string;
  detectedAt: string;
  pattern: string;
  observation: string;
}

interface TreeNode {
  name: string;
  path: string;
  kind: "file" | "directory";
  handle: any;
  children?: TreeNode[];
  isText?: boolean;
  isImage?: boolean;
  isOffice?: boolean;
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
// Office docs the LLM can read autonomously via read_synced_file (browser-parsed).
const OFFICE_EXTS = [".pdf", ".docx", ".pptx", ".xlsx", ".xls"];

function classifyFile(name: string): { isText: boolean; isImage: boolean; isOffice: boolean } {
  const lower = name.toLowerCase();
  return {
    isText: TEXT_EXTS.some((e) => lower.endsWith(e)),
    isImage: IMAGE_EXTS.some((e) => lower.endsWith(e)),
    isOffice: OFFICE_EXTS.some((e) => lower.endsWith(e)),
  };
}

const TYPE_COLORS: Record<string, string> = {
  claim: "#7C6EF7",
  method: "#3B82F6",
  observation: "#F59E0B",
  dataset: "#10B981",
  experiment: "#EF4444",
  finding: "#8B5CF6",
  question: "#06B6D4",
  goal: "#6B7280",
};

// Custom event ChatPanel dispatches when L0/L1 may have changed → sidebar refetches.
const REFRESH_EVENT = "synapse:memory-update";

export function Sidebar() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const { data: session, status: sessionStatus } = useSession();
  const userId = session?.user?.id ?? null;
  const [data, setData] = useState<MemoriesData | null>(null);
  const [folders, setFolders] = useState<SyncedFolder[]>([]);
  const [uploading, setUploading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionKey, setActiveSessionKey] = useState<string | null>(null);
  // Per-folder ephemeral scan progress: { [folderName]: discoveredFileCount }.
  // Lives in component state because it's transient and not part of SyncedFolder.
  const [scanProgress, setScanProgress] = useState<Record<string, number>>({});
  // Aha notification state — polled from /api/aha/last on memory refresh.
  const [ahaUnseen, setAhaUnseen] = useState(false);
  const [ahaHistory, setAhaHistory] = useState<AhaHistoryItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchTimeout = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    fetch("/api/memories")
      .then((r) => r.json())
      .then(setData)
      .catch(console.error);
    // Poll Aha state — cheap GET, cached on server.
    fetch("/api/aha/last")
      .then((r) => r.json())
      .then((d) => setAhaUnseen(!!d.unseen))
      .catch(() => {});
    fetch("/api/aha/history")
      .then((r) => r.json())
      .then((d) => setAhaHistory(d.items ?? []))
      .catch(() => {});
    // Per-user chat sessions list (derived from L0 group-by).
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((d) => {
        setSessions(d.sessions ?? []);
        if (!activeSessionKey && d.defaultSessionKey) {
          setActiveSessionKey(d.defaultSessionKey);
        }
      })
      .catch(() => {});
  }, [refreshTick]);

  // Listen for session changes (driven by synapse-app on its own; we just mirror).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { sessionKey: string };
      if (detail?.sessionKey) setActiveSessionKey(detail.sessionKey);
    };
    window.addEventListener("synapse:set-session", handler);
    return () => window.removeEventListener("synapse:set-session", handler);
  }, []);

  // History refreshes via `refreshTick` whenever a chat turn / aha trigger
  // fires elsewhere, so no extra listener is needed here. (The old listener
  // was tied to the now-removed `synapse:open-aha` modal event.)

  // Listen for cross-component refresh signal (chat sent a message, files uploaded, etc.).
  useEffect(() => {
    const onRefresh = () => setRefreshTick((n) => n + 1);
    window.addEventListener(REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(REFRESH_EVENT, onRefresh);
  }, []);

  // Clear folders whenever the logged-in user changes (logout / switch account).
  useEffect(() => {
    if (sessionStatus !== "loading") setFolders([]);
  }, [userId, sessionStatus]);

  // Restore previously connected folders from IndexedDB on mount (per user).
  // Permission status of "granted" → re-scan tree immediately.
  // Permission status of "prompt"/"denied" → show a "重新授权" button on the card.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      try {
        const cached = await loadFolderHandles(userId);
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
            scannedAt: t.sidebar.cached,
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
  }, [userId, t.sidebar.cached]);

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
      if (userId) {
        saveFolderHandle(userId, handle.name, handle).catch((err) =>
          console.warn("[sidebar] failed to cache folder handle:", err),
        );
      }
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
    } else {
      // Try office-doc parsing (pdf/docx/pptx/xlsx). Returns empty string if
      // not supported.
      try {
        const { classifyKind, parsePdfToText, parseDocxToText, parsePptxToText, parseXlsxToText } =
          await import("@/lib/synced-files");
        const kind = classifyKind(file.name);
        if (kind === "pdf") content = await parsePdfToText(file);
        else if (kind === "docx") content = await parseDocxToText(file);
        else if (kind === "pptx") content = await parsePptxToText(file);
        else if (kind === "xlsx") content = await parseXlsxToText(file);
      } catch (parseErr) {
        console.error("[sidebar] file-input parse failed:", parseErr);
      }
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
    if (userId) {
      removeFolderHandle(userId, name).catch((err) =>
        console.warn("[sidebar] failed to remove cached handle:", err),
      );
    }
  }

  // ── Chat session management ────────────────────────────────────────
  function switchSession(sessionKey: string, recordId?: string) {
    setActiveSessionKey(sessionKey);
    // Persist across route changes so navigating from /persona → / picks it up.
    try {
      sessionStorage.setItem("synapse:pending-session", JSON.stringify({
        sessionKey, recordId: recordId ?? null,
      }));
    } catch { /* ignore */ }
    // Dispatch immediately for the in-page case (SynapseApp already mounted).
    window.dispatchEvent(new CustomEvent("synapse:set-session", {
      detail: { sessionKey, ...(recordId ? { recordId } : {}) },
    }));
    // If the user is on /persona, /scenes/..., /memories/..., go back to /
    // so SynapseApp actually mounts and picks up the pending session.
    if (pathname && pathname !== "/") {
      router.push("/");
    }
  }

  function startNewSession() {
    if (!userId) return;
    const newKey = `chat_${userId}_${Date.now().toString(36)}`;
    // No L0 rows yet — the session "exists" once the first message is sent.
    switchSession(newKey);
  }

  async function deleteSessionAndRefresh(sessionKey: string) {
    if (!confirm(t.common.confirmDeleteConversation)) return;
    try {
      await fetch(`/api/sessions?key=${encodeURIComponent(sessionKey)}`, { method: "DELETE" });
      setSessions((prev) => prev.filter((s) => s.sessionKey !== sessionKey));
      // If the deleted session was active, fall back to default.
      if (activeSessionKey === sessionKey && userId) {
        switchSession(`chat_${userId}`);
      }
      setRefreshTick((n) => n + 1);
    } catch (err) {
      console.warn("[sidebar] delete session failed:", err);
    }
  }

  async function deleteAhaInsight(id: string) {
    if (!confirm(t.common.confirmDeleteInsight)) return;
    try {
      await fetch(`/api/aha/${encodeURIComponent(id)}`, { method: "DELETE" });
      setAhaHistory((prev) => prev.filter((a) => a.id !== id));
      // Refresh aha state (the deleted item may have been the active "last" one,
      // in which case the badge should disappear too).
      const r = await fetch("/api/aha/last", { cache: "no-store" });
      const j = await r.json();
      setAhaUnseen(!!j.unseen);
    } catch (err) {
      console.warn("[sidebar] delete aha failed:", err);
    }
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
      } else if (node.isOffice) {
        // PDF / docx / pptx / xlsx — parse on click so the content is inlined
        // into the prompt instead of relying on LLM tool-call roundtrip.
        const { classifyKind, parsePdfToText, parseDocxToText, parsePptxToText, parseXlsxToText } =
          await import("@/lib/synced-files");
        const kind = classifyKind(file.name);
        try {
          if (kind === "pdf") content = await parsePdfToText(file);
          else if (kind === "docx") content = await parseDocxToText(file);
          else if (kind === "pptx") content = await parsePptxToText(file);
          else if (kind === "xlsx") content = await parseXlsxToText(file);
        } catch (e) {
          console.error("[sidebar] office parse failed:", e);
          content = `[failed to parse ${node.name}: ${e instanceof Error ? e.message : String(e)}]`;
        }
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
      <div style={{ padding: "14px 16px 10px", position: "relative" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo-horizontal.jpg"
            alt="Synapse"
            style={{ height: 40, width: "auto", mixBlendMode: "multiply", display: "block", marginLeft: -4 }}
          />
          <SynnyMascot size={34} style={{ flexShrink: 0 }} />
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4, display: "flex", alignItems: "center", gap: 8 }}>
          <span>{data ? t.sidebar.memoryStats(data.l1Count, Math.round(data.l0Count / 2)) : t.sidebar.loadingStats}</span>
          {data && (data.l1Count > 0 || data.l0Count > 0) && (
            <a
              href="/api/memories/export"
              download
              title={t.sidebar.exportMemoriesTitle}
              style={{
                color: "var(--accent)", textDecoration: "none",
                fontSize: 11, fontWeight: 600, whiteSpace: "nowrap",
                cursor: "pointer", opacity: 0.85,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
              onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.85")}
            >
              ⬇ {t.sidebar.exportMemories}
            </a>
          )}
        </div>
        {ahaUnseen && (
          <button
            onClick={() => {
              router.push("/aha/latest");
              // Optimistically clear; server is updated by the route handler.
              setAhaUnseen(false);
            }}
            title={t.sidebar.newInsightTitle}
            style={{
              position: "absolute", top: 12, right: 14,
              background: "linear-gradient(135deg, #FFE5B0 0%, #F5C57E 100%)",
              border: "1px solid #D6A84F",
              borderRadius: 14,
              padding: "3px 9px 3px 7px",
              fontSize: 11, fontWeight: 700, color: "#7A5A10",
              cursor: "pointer",
              boxShadow: "0 2px 6px rgba(214, 168, 79, 0.35)",
              display: "flex", alignItems: "center", gap: 4,
              animation: "synapse-pulse 1.8s ease-in-out infinite",
            }}
          >
            ✨ <span>{t.sidebar.newInsight}</span>
          </button>
        )}
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
            placeholder={t.sidebar.searchPlaceholder}
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

        {/* Search Results — L0 conversation hits across all sessions */}
        {searchResults !== null && (
          <Section label={t.sidebar.searchResults(searchResults.length)}>
            {searchResults.length === 0 ? (
              <div style={{ padding: "8px 14px", fontSize: 12, color: "var(--text-muted)" }}>{t.sidebar.noResults}</div>
            ) : (
              searchResults.slice(0, 20).map((hit) => (
                <SearchHitRow
                  key={hit.recordId}
                  hit={hit}
                  query={searchQuery}
                  onJump={() => {
                    switchSession(hit.sessionKey, hit.recordId);
                    setSearchQuery("");
                  }}
                />
              ))
            )}
          </Section>
        )}

        {/* Conversations — list all sessions for this user */}
        {searchResults === null && (
          <Section label={`Conversations (${sessions.length})`}>
            <button
              onClick={startNewSession}
              style={{
                width: "calc(100% - 28px)", margin: "4px 14px 6px",
                padding: "7px 10px", background: "var(--surface)",
                border: "1px dashed var(--border)", borderRadius: 8,
                color: "var(--accent)", cursor: "pointer", fontSize: 12, fontWeight: 600,
              }}
            >+ New chat</button>
            <div style={{ overflowY: "auto", maxHeight: "calc(10 * 40px)" }}>
              {sessions.map((s) => (
                <SessionRow
                  key={s.sessionKey}
                  session={s}
                  active={s.sessionKey === activeSessionKey}
                  onClick={() => switchSession(s.sessionKey)}
                  onDelete={() => deleteSessionAndRefresh(s.sessionKey)}
                />
              ))}
              {sessions.length === 0 && (
                <div style={{ padding: "6px 14px", fontSize: 11, color: "var(--text-muted)" }}>
                  Start chatting to create your first conversation.
                </div>
              )}
            </div>
          </Section>
        )}

        {/* Local Folders */}
        {searchResults === null && (
          <Section label={t.sidebar.localFolders}>
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
              {uploading ? t.sidebar.scanning : t.sidebar.connectFolder}
            </button>
            <input ref={fileInputRef} type="file" accept=".txt,.md,.pdf,.tex,.csv,.docx,.pptx,.xlsx,.xls,.json,.yaml,.yml,.rst" style={{ display: "none" }} onChange={handleFileInput} />
          </Section>
        )}

        {/* Manual Aha trigger — let the user look back at their recent threads
            on demand, in addition to the passive background detection. */}
        {searchResults === null && (
          <Section label="✨ Threads">
            <LookBackButton onTriggered={() => setRefreshTick((n) => n + 1)} />
          </Section>
        )}

        {/* Aha History — every detected Aha, clickable to re-open in modal */}
        {searchResults === null && ahaHistory.length > 0 && (
          <Section label={`✨ ${t.sidebar.ahaHistory(ahaHistory.length)}`}>
            <div style={{ overflowY: "auto", maxHeight: "calc(10 * 52px)" }}>
              {ahaHistory.map((item) => (
                <AhaHistoryRow key={item.id} item={item} locale={locale} onDelete={deleteAhaInsight} />
              ))}
            </div>
          </Section>
        )}

        {/* L3 Persona — link to /persona */}
        {searchResults === null && data?.persona && (
          <Section label={t.sidebar.persona}>
            <PersonaLink persona={data.persona} />
          </Section>
        )}

        {/* L2 Scenes — each row links to /scenes/[filename] */}
        {searchResults === null && data && data.scenes.length > 0 && (
          <Section label={t.sidebar.scenes(data.scenes.length)}>
            <div style={{ overflowY: "auto", maxHeight: "calc(10 * 52px)" }}>
              {data.scenes.map((scene) => <SceneRow key={scene.filename} scene={scene} />)}
            </div>
          </Section>
        )}

        {/* Recent Memories — disabled per user request (2026-05-26). L1 records
            still exist in the DB and are searched/retrieved by the LLM; only the
            sidebar list view is hidden. */}
        {/*
        {searchResults === null && data && data.recentMemories.length > 0 && (
          <Section label={t.sidebar.recentMemories(data.l1Count)}>
            {data.recentMemories.slice(0, 15).map((m) => <MemoryRow key={m.id} m={m} />)}
          </Section>
        )}

        {searchResults === null && data && data.recentMemories.length === 0 && (
          <div style={{ padding: "20px 14px", textAlign: "center" }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>🌱</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
              {t.sidebar.emptyMemories}
            </div>
          </div>
        )}
        */}
      </div>
      <AccountCenter />
    </div>
  );
}

function SearchHitRow({
  hit, query, onJump,
}: {
  hit: SearchHit; query: string; onJump: () => void;
}) {
  const dateStr = hit.recordedAt
    ? new Date(hit.recordedAt).toLocaleString(undefined, {
        month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
      })
    : "";
  return (
    <button
      onClick={onJump}
      title={hit.snippet}
      style={{
        display: "block", width: "calc(100% - 12px)", margin: "2px 6px",
        padding: "7px 10px", textAlign: "left",
        background: "transparent", border: "none",
        borderRadius: 6, cursor: "pointer",
        color: "inherit", fontFamily: "inherit",
        transition: "background 0.12s",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
        <span style={{
          fontSize: 10, padding: "1px 5px", borderRadius: 4,
          background: hit.role === "user" ? "rgba(124,110,247,0.12)" : "rgba(16,185,129,0.12)",
          color: hit.role === "user" ? "#7C6EF7" : "#10B981", fontWeight: 600,
        }}>{hit.role}</span>
        <span style={{
          fontSize: 11, color: "var(--text-muted)", flex: 1,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{hit.sessionTitle}</span>
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{dateStr}</span>
      </div>
      <div style={{
        fontSize: 12, color: "var(--text)", lineHeight: 1.5,
        display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2,
        overflow: "hidden",
      }}>
        {highlightMatches(hit.snippet, query)}
      </div>
    </button>
  );
}

function highlightMatches(text: string, query: string): React.ReactNode {
  const term = query.trim().split(/\s+/)[0];
  if (!term) return text;
  const lower = text.toLowerCase();
  const needle = term.toLowerCase();
  const idx = lower.indexOf(needle);
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark style={{ background: "rgba(245,197,126,0.55)", color: "inherit", padding: 0 }}>
        {text.slice(idx, idx + needle.length)}
      </mark>
      {text.slice(idx + needle.length)}
    </>
  );
}

function SessionRow({
  session, active, onClick, onDelete,
}: {
  session: ChatSession; active: boolean;
  onClick: () => void; onDelete: () => void;
}) {
  const dateStr = session.lastMessageAt
    ? new Date(session.lastMessageAt).toLocaleString(undefined, {
        month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
      })
    : "";
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex", alignItems: "center", gap: 4,
        padding: "6px 10px 6px 14px",
        background: active ? "var(--surface)" : "transparent",
        borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
        cursor: "pointer",
        transition: "background 0.12s",
      }}
      onClick={onClick}
    >
      <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
        <div style={{
          fontSize: 12, color: "var(--text)", fontWeight: active ? 600 : 500,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{session.title}</div>
        <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
          {session.messageCount} msgs · {dateStr}
        </div>
      </div>
      {hover && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title="Delete conversation"
          style={{
            background: "none", border: "none", cursor: "pointer",
            color: "var(--text-muted)", fontSize: 14, padding: "2px 4px",
            opacity: 0.7,
          }}
        >🗑</button>
      )}
    </div>
  );
}

function MemoryRow({ m }: { m: { id: string; content: string; type: string; scene_name?: string } }) {
  const { t } = useI18n();
  const color = TYPE_COLORS[m.type] ?? "#6B7280";
  const label = (t.typeLabels as Record<string, string>)[m.type] ?? m.type;
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
          background: `${color}18`, color,
          borderRadius: 4, fontWeight: 600, flexShrink: 0,
        }}>
          {label}
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

function LookBackButton({ onTriggered }: { onTriggered: () => void }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  async function run() {
    if (loading) return;
    setLoading(true);
    setHint(null);
    try {
      const r = await fetch("/api/aha/last?force=1", { cache: "no-store" });
      const j = await r.json();
      if (j?.aha?.id) {
        // Navigate to the full-page view of the freshly-generated insight.
        router.push(`/aha/${encodeURIComponent(j.aha.id)}`);
        onTriggered();
      } else {
        setHint(j?.reason ?? "No threads yet — keep chatting to build memory.");
        setTimeout(() => setHint(null), 4000);
      }
    } catch (err) {
      setHint(err instanceof Error ? err.message : String(err));
      setTimeout(() => setHint(null), 4000);
    } finally {
      setLoading(false);
    }
  }
  return (
    <div style={{ padding: "2px 12px 6px" }}>
      <button
        onClick={run}
        disabled={loading}
        style={{
          width: "100%", padding: "7px 10px",
          background: loading ? "var(--surface-2)" : "var(--surface)",
          border: "1px dashed var(--border)", borderRadius: 8,
          color: loading ? "var(--text-muted)" : "var(--accent)",
          cursor: loading ? "wait" : "pointer", fontSize: 12, fontWeight: 600,
          transition: "background 0.12s",
        }}
        onMouseEnter={(e) => { if (!loading) e.currentTarget.style.background = "var(--insight)"; }}
        onMouseLeave={(e) => { if (!loading) e.currentTarget.style.background = "var(--surface)"; }}
      >
        {loading ? "Analyzing your trajectories…" : "📈 Look back at recent threads"}
      </button>
      {hint && (
        <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-muted)", padding: "0 2px" }}>
          {hint}
        </div>
      )}
    </div>
  );
}

function AhaHistoryRow({
  item, locale, onDelete,
}: {
  item: AhaHistoryItem;
  locale: string;
  onDelete: (id: string) => void;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [hover, setHover] = useState(false);
  const date = item.detectedAt
    ? new Date(item.detectedAt).toLocaleString(locale, {
        month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
      })
    : "";
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => router.push(`/aha/${encodeURIComponent(item.id)}`)}
      title={item.observation}
      style={{
        position: "relative",
        width: "calc(100% - 12px)", margin: "2px 6px",
        padding: "7px 10px",
        background: hover ? "var(--insight)" : "transparent",
        borderRadius: 6,
        transition: "background 0.12s",
        color: "inherit",
        cursor: "pointer",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 3 }}>
        <span style={{ fontSize: 11 }}>✨</span>
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{date}</span>
      </div>
      <div style={{
        fontSize: 12, color: "var(--text)", lineHeight: 1.45,
        display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2,
        overflow: "hidden",
        paddingRight: hover ? 22 : 0,  // make room for the trash button on hover
        transition: "padding 0.12s",
      }}>
        {item.pattern || item.observation || t.common.none}
      </div>
      {hover && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(item.id); }}
          title={t.common.delete}
          style={{
            position: "absolute", top: 4, right: 4,
            background: "none", border: "none", cursor: "pointer",
            color: "var(--text-muted)", fontSize: 14, padding: "2px 4px",
            lineHeight: 1, opacity: 0.7,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.7")}
        >🗑</button>
      )}
    </div>
  );
}

// Extract the short quoted label from the Archetype line, e.g. "务实建造者".
// The persona-generation prompt always ends the Archetype sentence with a quoted
// core label inside curly/straight double-quotes.
function extractPersonaLabel(persona: string): string {
  const archetypeLine = persona.match(/>\s*\*\*Archetype[^*]*\*\*[：:]\s*(.+)/)?.[1] ?? "";
  if (archetypeLine) {
    // Match Chinese curly quotes "xxx" or straight "xxx"
    const hits = [...archetypeLine.matchAll(/[“"]([^”"]{2,16})[”"]/g)];
    if (hits.length > 0) return hits[hits.length - 1][1].trim();
    // Fallback: last bold **xxx** in the line
    const bolds = [...archetypeLine.matchAll(/\*\*([^*]{2,16})\*\*/g)];
    if (bolds.length > 0) return bolds[bolds.length - 1][1].trim();
  }
  return "";
}

// Full Archetype sentence for the subtitle row.
function extractPersonaSummary(persona: string): string {
  const m = persona.match(/>\s*\*\*Archetype[^*]*\*\*[：:]\s*(.+)/);
  if (m) return m[1].trim();
  for (const line of persona.split("\n")) {
    const clean = line.replace(/^[>#*\-\s]+/, "").trim();
    if (clean.length > 10) return clean;
  }
  return "";
}

function PersonaLink({ persona }: { persona: string }) {
  const { t } = useI18n();
  const label = extractPersonaLabel(persona);
  const summary = extractPersonaSummary(persona);
  return (
    <Link
      href="/persona"
      style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "6px 12px", textDecoration: "none", color: "inherit",
        userSelect: "none", transition: "background 0.12s",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <span style={{ fontSize: 12, flexShrink: 0 }}>🧠</span>
      <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
        <div style={{
          fontSize: 12, color: "var(--text)", fontWeight: 600,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{label || t.sidebar.viewPersona}</div>
        {summary && (
          <div style={{
            fontSize: 10, color: "var(--text-muted)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>{summary}</div>
        )}
      </div>
    </Link>
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

function AccountCenter() {
  const { language, setLanguage, apiSettings, setApiSettings, t } = useI18n();
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const displayName = session?.user?.name || session?.user?.email || t.account.name;
  const displayEmail = session?.user?.email || t.account.plan;
  const avatarLetter = (displayName || displayEmail || "S").slice(0, 1).toUpperCase();

  return (
    <div style={{ position: "relative", borderTop: "1px solid var(--border)", padding: 10 }}>
      {open && (
        <div
          style={{
            position: "absolute",
            left: 10,
            bottom: 72,
            width: 252,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 14,
            boxShadow: "0 16px 40px rgba(0,0,0,0.16)",
            padding: 8,
            zIndex: 40,
          }}
        >
          <div style={{ padding: "8px 10px 7px", fontSize: 12, color: "var(--text-muted)" }}>
            {displayEmail}
          </div>
          <AccountMenuButton icon="⚙" label={t.account.settings} />
          <button
            onClick={() => setLanguage(language === "en" ? "zh" : "en")}
            style={accountMenuButtonStyle}
          >
            <span style={accountIconStyle}>🌐</span>
            <span style={{ flex: 1 }}>{t.account.language}</span>
            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
              {language === "en" ? t.account.english : t.account.chinese}
            </span>
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            style={accountMenuButtonStyle}
          >
            <span style={accountIconStyle}>🔑</span>
            <span style={{ flex: 1 }}>{t.account.apiSettings}</span>
            <span style={{ color: "var(--text-muted)" }}>›</span>
          </button>
          <div style={{ height: 1, background: "var(--border)", margin: "7px 4px" }} />
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            style={accountMenuButtonStyle}
          >
            <span style={accountIconStyle}>↪</span>
            <span style={{ flex: 1 }}>{t.account.logout}</span>
          </button>
        </div>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: open ? "var(--surface)" : "transparent",
          border: "none",
          borderRadius: 10,
          padding: "8px 7px",
          color: "var(--text)",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{
          width: 34,
          height: 34,
          borderRadius: "50%",
          background: "#1f1f1f",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 15,
          fontWeight: 700,
          flexShrink: 0,
        }}>{avatarLetter}</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontSize: 13, fontWeight: 700, lineHeight: 1.2 }}>
            {displayName}
          </span>
          <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)", lineHeight: 1.2 }}>
            {displayEmail}
          </span>
        </span>
        <span style={{ color: "var(--text-muted)", fontSize: 14 }}>⌄</span>
      </button>

      {settingsOpen && (
        <ApiSettingsModal
          initial={apiSettings}
          onClose={() => setSettingsOpen(false)}
          onSave={(next) => {
            setApiSettings(next);
            setSettingsOpen(false);
          }}
        />
      )}
    </div>
  );
}

function AccountMenuButton({ icon, label }: { icon: string; label: string }) {
  return (
    <button type="button" style={accountMenuButtonStyle}>
      <span style={accountIconStyle}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
    </button>
  );
}

function ApiSettingsModal({
  initial,
  onClose,
  onSave,
}: {
  initial: ApiSettings;
  onClose: () => void;
  onSave: (settings: ApiSettings) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<ApiSettings>(initial);

  const update = (key: keyof ApiSettings, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 300,
        background: "rgba(20, 20, 18, 0.42)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <section
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(520px, 100%)",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          boxShadow: "0 24px 60px rgba(0,0,0,0.24)",
          overflow: "hidden",
        }}
      >
        <header style={{
          padding: "16px 20px 12px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          justifyContent: "space-between",
          gap: 16,
        }}>
          <div>
            <h2 style={{ fontSize: 17, margin: 0, color: "var(--text)" }}>{t.apiSettings.title}</h2>
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.5 }}>
              {t.apiSettings.description}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label={t.common.close}
            style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 20, lineHeight: 1 }}
          >×</button>
        </header>

        <div style={{ padding: 20, display: "grid", gap: 14 }}>
          <SettingsField
            label={t.apiSettings.apiKey}
            value={draft.apiKey}
            placeholder={t.apiSettings.apiKeyPlaceholder}
            type="password"
            onChange={(value) => update("apiKey", value)}
          />
          <SettingsField
            label={t.apiSettings.baseUrl}
            value={draft.baseUrl}
            placeholder={t.apiSettings.baseUrlPlaceholder}
            onChange={(value) => update("baseUrl", value)}
          />
          <SettingsField
            label={t.apiSettings.model}
            value={draft.model}
            placeholder={t.apiSettings.modelPlaceholder}
            onChange={(value) => update("model", value)}
          />
        </div>

        <footer style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "12px 20px 18px",
          borderTop: "1px solid var(--border)",
        }}>
          <button
            onClick={() => setDraft({ apiKey: "", baseUrl: "", model: "" })}
            style={{
              border: "none",
              background: "transparent",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            {t.apiSettings.clear}
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={onClose}
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--surface-2)",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              {t.common.cancel}
            </button>
            <button
              onClick={() => onSave(draft)}
              style={{
                padding: "8px 16px",
                borderRadius: 8,
                border: "none",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 700,
              }}
            >
              {t.common.save}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function SettingsField({
  label,
  value,
  placeholder,
  type = "text",
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  type?: "text" | "password";
  onChange: (value: string) => void;
}) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          padding: "10px 11px",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--surface-2)",
          color: "var(--text)",
          outline: "none",
          fontSize: 13,
          fontFamily: "inherit",
        }}
      />
    </label>
  );
}

const accountMenuButtonStyle: React.CSSProperties = {
  width: "100%",
  display: "flex",
  alignItems: "center",
  gap: 10,
  border: "none",
  background: "transparent",
  color: "var(--text)",
  padding: "9px 10px",
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 14,
  textAlign: "left",
  fontFamily: "inherit",
};

const accountIconStyle: React.CSSProperties = {
  width: 18,
  color: "var(--text-muted)",
  textAlign: "center",
  flexShrink: 0,
};

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
        const { isText, isImage, isOffice } = classifyFile(name);
        children.push({
          name, path: childPath, kind: "file", handle, isText, isImage, isOffice,
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
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const needsAuth = folder.permission !== "granted";
  const scanning = scanInProgress !== undefined;
  const statusLine = needsAuth
    ? t.sidebar.needsAuth
    : scanning
      ? t.sidebar.scanProgress(scanInProgress)
      : t.sidebar.ready;

  async function copyRootPath(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(folder.name);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = folder.name;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div style={{ padding: "2px 8px 6px" }}>
      <div
        title={folder.name}
        style={{
          display: "flex", alignItems: "center", gap: 4,
          padding: "4px 6px", borderRadius: 6,
          cursor: "pointer", userSelect: "none",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--surface)";
          setHovered(true);
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
          setHovered(false);
        }}
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
        {(hovered || copied) && (
          <button
            onClick={copyRootPath}
            title={t.sidebar.copyPath(folder.name)}
            aria-label={t.sidebar.copyPathLabel}
            style={{
              background: copied ? "var(--accent)" : "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              padding: "1px 5px",
              fontSize: 10,
              color: copied ? "#fff" : "var(--text-muted)",
              cursor: "pointer",
              lineHeight: 1.2,
              flexShrink: 0,
            }}
          >
            {copied ? t.common.copied : `📋 ${t.common.path}`}
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          title={t.sidebar.remove}
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
          {t.sidebar.reauthorize}
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
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(depth < 1);
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const indent = depth * 10;

  async function copyPath(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(node.path);
    } catch {
      // Older browsers: fallback via temporary input
      const ta = document.createElement("textarea");
      ta.value = node.path;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  if (node.kind === "directory") {
    return (
      <div>
        <div
          onClick={() => setExpanded((v) => !v)}
          title={node.path}
          style={{
            display: "flex", alignItems: "center", gap: 4,
            padding: "3px 6px", paddingLeft: 6 + indent,
            cursor: "pointer", borderRadius: 5, userSelect: "none",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--surface)";
            setHovered(true);
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            setHovered(false);
          }}
        >
          <span style={{
            width: 10, fontSize: 8, color: "var(--text-muted)",
            transform: expanded ? "rotate(90deg)" : "none",
            transition: "transform 0.12s",
            display: "inline-block", textAlign: "center",
          }}>▶</span>
          <span style={{ fontSize: 12, flexShrink: 0 }}>📂</span>
          <span
            onClick={(e) => e.stopPropagation()}
            style={{
              fontSize: 12, color: "var(--text)",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              userSelect: "text", cursor: "text",
              flex: 1, minWidth: 0,
            }}
          >{node.name}</span>
          {(hovered || copied) && (
            <button
              onClick={copyPath}
              title={t.sidebar.copyPath(node.path)}
              aria-label={t.sidebar.copyPathLabel}
              style={{
                background: copied ? "var(--accent)" : "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                padding: "1px 5px",
                fontSize: 10,
                color: copied ? "#fff" : "var(--text-muted)",
                cursor: "pointer",
                lineHeight: 1.2,
                flexShrink: 0,
              }}
            >
              {copied ? t.common.copied : `📋 ${t.common.path}`}
            </button>
          )}
          <span style={{ fontSize: 10, color: "var(--text-muted)", flexShrink: 0 }}>
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
  const clickable = node.isText || node.isImage || node.isOffice;
  const icon = node.isImage
    ? "🖼️"
    : node.isText
      ? "📄"
      : node.isOffice
        ? (node.name.toLowerCase().endsWith(".pdf") ? "📕"
            : node.name.toLowerCase().endsWith(".docx") ? "📘"
            : node.name.toLowerCase().endsWith(".pptx") ? "📙"
            : "📊")
        : "📦";
  return (
    <div
      onClick={() => clickable && onFileClick(node)}
      title={clickable ? t.sidebar.fileTitleClickable(node.path) : t.sidebar.fileTitleUnsupported(node.path)}
      style={{
        display: "flex", alignItems: "center", gap: 4,
        padding: "3px 6px", paddingLeft: 20 + indent,
        cursor: clickable ? "pointer" : "default",
        borderRadius: 5, userSelect: "none",
        opacity: clickable ? 1 : 0.45,
        position: "relative",
      }}
      onMouseEnter={(e) => {
        if (clickable) e.currentTarget.style.background = "var(--insight)";
        setHovered(true);
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        setHovered(false);
      }}
    >
      <span style={{ fontSize: 11, flexShrink: 0 }}>{icon}</span>
      <span
        onClick={(e) => e.stopPropagation()}
        style={{
          fontSize: 12, color: "var(--text-muted)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          userSelect: "text", cursor: "text",
          flex: 1, minWidth: 0,
        }}
      >{node.name}</span>
      {(hovered || copied) && (
        <button
          onClick={copyPath}
          title={t.sidebar.copyPath(node.path)}
          aria-label={t.sidebar.copyPathLabel}
          style={{
            background: copied ? "var(--accent)" : "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            padding: "1px 5px",
            fontSize: 10,
            color: copied ? "#fff" : "var(--text-muted)",
            cursor: "pointer",
            lineHeight: 1.2,
            flexShrink: 0,
          }}
        >
          {copied ? t.common.copied : `📋 ${t.common.path}`}
        </button>
      )}
    </div>
  );
}
