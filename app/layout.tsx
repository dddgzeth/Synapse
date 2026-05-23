import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/app-shell";

export const metadata: Metadata = {
  title: "Synapse — Your Second Memory",
  description: "An AI assistant that remembers across conversations and surfaces insights you haven't noticed.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
