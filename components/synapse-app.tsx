/**
 * SynapseApp — chat column only. The sidebar lives in app/layout.tsx (AppShell)
 * so it persists across navigation to /persona, /scenes/[…], /memories/[…].
 */
"use client";

import { useCallback, useEffect } from "react";
import { useSession } from "next-auth/react";
import { ChatPanel } from "./chat-panel";

const REFRESH_EVENT = "synapse:memory-update";

export function SynapseApp() {
  const { data: session, status } = useSession();
  const sessionKey = session?.user?.id ? `chat_${session.user.id}` : null;

  // ChatPanel will broadcast a window event after L0/L1 likely changed.
  // Sidebar listens for the same event and refetches /api/memories.
  const onMemoryUpdate = useCallback(() => {
    window.dispatchEvent(new CustomEvent(REFRESH_EVENT));
  }, []);

  // On mount, ask the server to flush any L0 turns that didn't reach the L1
  // batch threshold last time the user was active. This is the "user returns
  // after a gap" recovery path — replaces the original 10-min idle timer.
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
          // Tell sidebar to refresh memory counts now.
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
      <ChatPanel sessionKey={sessionKey} onMemoryUpdate={onMemoryUpdate} />
    </div>
  );
}
