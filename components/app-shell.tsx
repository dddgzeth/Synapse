/**
 * AppShell — top-level layout: persistent sidebar (left) + scrollable content (right).
 *
 * Used by app/layout.tsx so the sidebar survives client-side navigation to
 * /persona, /scenes/[filename], /memories/[id], etc. (Claude.ai-style.)
 */
"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "./sidebar";
import { DetailModal } from "./detail-modal";
import { AhaModal } from "./aha-modal";
import { I18nProvider } from "./i18n";
import { AuthProvider } from "./auth-provider";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLogin = pathname === "/login";

  return (
    <AuthProvider>
      <I18nProvider>
        {isLogin ? (
          children
        ) : (
          <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
            <Sidebar />
            <div style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
              {children}
            </div>
            {/* Floating modals — listen for window events */}
            <DetailModal />
            <AhaModal />
          </div>
        )}
      </I18nProvider>
    </AuthProvider>
  );
}
