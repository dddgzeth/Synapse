/**
 * /persona — L3 detail page: full persona.md rendered in main content area.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import { useI18n } from "@/components/i18n";

export default function PersonaPage() {
  const { t } = useI18n();
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/memories")
      .then((r) => r.json())
      .then((d) => setText(d.persona ?? null))
      .catch((e) => console.error(e))
      .finally(() => setLoading(false));
  }, []);

  return (
    <main style={pageWrap}>
      <Link href="/" style={backLink}>{t.common.backToChat}</Link>
      <header style={{ marginBottom: 18 }}>
        <div style={eyebrow}>{t.details.personaEyebrow}</div>
        <h1 style={h1}>{t.details.personaTitle}</h1>
      </header>

      <article style={card} className="prose">
        {loading && <p style={{ color: "var(--text-muted)" }}>{t.common.loading}</p>}
        {!loading && !text && (
          <p style={{ color: "var(--text-muted)" }}>
            {t.details.personaEmpty}
          </p>
        )}
        {!loading && text && <ReactMarkdown>{text}</ReactMarkdown>}
      </article>
    </main>
  );
}

const pageWrap: React.CSSProperties = {
  maxWidth: 820,
  margin: "0 auto",
  padding: "32px 28px 60px",
  fontFamily: "system-ui, sans-serif",
  color: "var(--text)",
};
const backLink: React.CSSProperties = {
  display: "inline-block",
  marginBottom: 18,
  fontSize: 13,
  color: "var(--accent)",
  textDecoration: "none",
  fontWeight: 600,
};
const eyebrow: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "var(--accent)",
  textTransform: "uppercase",
  letterSpacing: 1.2,
  marginBottom: 4,
};
const h1: React.CSSProperties = {
  fontSize: 28,
  fontWeight: 700,
  margin: 0,
  color: "var(--text)",
};
const card: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: "26px 32px",
  fontSize: 15,
  lineHeight: 1.75,
  color: "var(--text)",
};
