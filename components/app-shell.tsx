/**
 * AppShell — top-level layout: persistent sidebar (left) + scrollable content (right).
 *
 * Used by app/layout.tsx so the sidebar survives client-side navigation to
 * /persona, /scenes/[filename], /memories/[id], etc. (Claude.ai-style.)
 */
"use client";

import { Sidebar } from "./sidebar";
import { DetailModal } from "./detail-modal";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
      <Sidebar />
      <div style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
        {children}
      </div>
      {/* Floating modal host — listens for synapse:open-detail events */}
      <DetailModal />
    </div>
  );
}
