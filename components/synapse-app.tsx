/**
 * SynapseApp — chat column only. The sidebar lives in app/layout.tsx (AppShell)
 * so it persists across navigation to /persona, /scenes/[…], /memories/[…].
 */
"use client";

import { useCallback, useState } from "react";
import { ChatPanel } from "./chat-panel";

const REFRESH_EVENT = "synapse:memory-update";

export function SynapseApp() {
  const [sessionKey] = useState("chat_main");

  // ChatPanel will broadcast a window event after L0/L1 likely changed.
  // Sidebar listens for the same event and refetches /api/memories.
  const onMemoryUpdate = useCallback(() => {
    window.dispatchEvent(new CustomEvent(REFRESH_EVENT));
  }, []);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <ChatPanel sessionKey={sessionKey} onMemoryUpdate={onMemoryUpdate} />
    </div>
  );
}
