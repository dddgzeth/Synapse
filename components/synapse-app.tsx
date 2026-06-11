/**
 * SynapseApp — chat column only. The sidebar lives in app/layout.tsx (AppShell)
 * so it persists across navigation to /persona, /scenes/[…], /memories/[…].
 *
 * Owns the "current session" state. The sidebar dispatches
 * `synapse:set-session` events to switch sessions or start a new one.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { ChatPanel } from "./chat-panel";

const REFRESH_EVENT = "synapse:memory-update";
const SET_SESSION_EVENT = "synapse:set-session";
const ACTIVE_SESSION_STORAGE_KEY = "synapse:active-session";

export function SynapseApp() {
  const { data: session, status } = useSession();
  const userId = session?.user?.id ?? null;
  const defaultSessionKey = userId ? `chat_${userId}` : null;

  const [sessionKey, setSessionKey] = useState<string | null>(defaultSessionKey);
  // Optional message ID to scroll to after history loads (from search clicks).
  const [scrollToRecordId, setScrollToRecordId] = useState<string | null>(null);

  // On mount / user change: prefer a pending session left by the sidebar
  // (set when navigating from /persona, /scenes/..., /memories/...).
  // Otherwise fall back to the default session for this user.
  useEffect(() => {
    if (!defaultSessionKey) return;
    let initial: string = defaultSessionKey;
    let initialRecord: string | null = null;
    try {
      const persisted = localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
      if (persisted) {
        const parsed = JSON.parse(persisted) as { sessionKey?: string; userId?: string | null };
        if (parsed.userId === userId && parsed.sessionKey?.startsWith(`chat_${userId}`)) {
          initial = parsed.sessionKey;
        }
      }
      const raw = sessionStorage.getItem("synapse:pending-session");
      if (raw) {
        const parsed = JSON.parse(raw) as { sessionKey?: string; recordId?: string | null };
        if (parsed.sessionKey?.startsWith(`chat_${userId}`)) {
          initial = parsed.sessionKey;
          initialRecord = parsed.recordId ?? null;
        }
        sessionStorage.removeItem("synapse:pending-session");
      }
    } catch { /* ignore */ }
    setSessionKey(initial);
    setScrollToRecordId(initialRecord);
  }, [defaultSessionKey, userId]);

  // Listen for session-switch events from the sidebar.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { sessionKey: string; recordId?: string };
      if (!detail?.sessionKey) return;
      setSessionKey(detail.sessionKey);
      setScrollToRecordId(detail.recordId ?? null);
    };
    window.addEventListener(SET_SESSION_EVENT, handler);
    return () => window.removeEventListener(SET_SESSION_EVENT, handler);
  }, []);

  const onMemoryUpdate = useCallback(() => {
    window.dispatchEvent(new CustomEvent(REFRESH_EVENT));
  }, []);

  useEffect(() => {
    if (!sessionKey || !userId) return;
    try {
      localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, JSON.stringify({ userId, sessionKey }));
    } catch { /* ignore */ }
  }, [sessionKey, userId]);

  // Flush leftover turns on initial mount (recovery after a gap).
  useEffect(() => {
    if (!sessionKey) return;
    fetch("/api/pipeline/flush", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionKey }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.triggeredL1) {
          console.log("[synapse] flushed pending turns on mount:", d);
          window.dispatchEvent(new CustomEvent(REFRESH_EVENT));
        }
      })
      .catch((err) => console.warn("[synapse] flush on mount failed:", err));
  }, [sessionKey]);

  if (status === "loading" || !sessionKey) {
    return <div style={{ height: "100%", background: "var(--bg)" }} />;
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <ChatPanel
        key={sessionKey}
        sessionKey={sessionKey}
        scrollToRecordId={scrollToRecordId}
        onScrollHandled={() => setScrollToRecordId(null)}
        onMemoryUpdate={onMemoryUpdate}
      />
    </div>
  );
}
