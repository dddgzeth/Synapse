/**
 * DemoPlayer — self-hosted demo video page (no YouTube dependency).
 *
 * Serves the rendered mp4 directly from /public/demo, so the demo works from
 * mainland China (YouTube is blocked there) without uploading the video to
 * any third-party platform. Static files under /public support HTTP range
 * requests out of the box, so seeking/scrubbing works normally.
 */
import Link from "next/link";

const VIOLET = "#6D28D9";
const PAPER = "#FAFAF8";
const INK = "#1A1A1A";
const MUTED = "#6B7280";
const BORDER = "#E8E8E0";

type Lang = "en" | "zh";

const COPY: Record<Lang, {
  back: string; title: string; sub: string; download: string; switchTo: string; switchHref: string;
}> = {
  en: {
    back: "← Back to home",
    title: "Synapse — Demo",
    sub: "96-second walkthrough: the memory loop, connecting Claude Code / Codex, and Synapse noticing a pattern on its own.",
    download: "Download the video",
    switchTo: "中文版 →",
    switchHref: "/demo-zh",
  },
  zh: {
    back: "← 返回首页",
    title: "Synapse — 产品演示",
    sub: "96 秒演示:记忆循环、连接 Claude Code / Codex,以及 Synapse 自己发现规律的那一刻。",
    download: "下载视频",
    switchTo: "→ English version",
    switchHref: "/demo-en",
  },
};

export function DemoPlayer({ lang }: { lang: Lang }) {
  const t = COPY[lang];
  const src = lang === "en" ? "/demo/demo-en.mp4" : "/demo/demo-zh.mp4";
  const homeHref = lang === "en" ? "/en" : "/zh";

  return (
    <div style={{
      minHeight: "100vh",
      background: PAPER,
      color: INK,
      fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
      padding: "28px 24px 60px",
    }}>
      <div style={{ maxWidth: 960, margin: "0 auto" }}>
        <Link href={homeHref} style={{ fontSize: 14, color: MUTED, textDecoration: "none" }}>
          {t.back}
        </Link>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 18, flexWrap: "wrap", gap: 12 }}>
          <h1 style={{ fontSize: 30, fontWeight: 800, margin: 0, letterSpacing: -0.5 }}>{t.title}</h1>
          <Link href={t.switchHref} style={{ fontSize: 14, fontWeight: 700, color: VIOLET, textDecoration: "none" }}>
            {t.switchTo}
          </Link>
        </div>
        <p style={{ fontSize: 16, color: MUTED, margin: "10px 0 24px", lineHeight: 1.5, maxWidth: 680 }}>
          {t.sub}
        </p>

        <div style={{
          borderRadius: 16, overflow: "hidden", border: `1px solid ${BORDER}`,
          boxShadow: "0 18px 50px rgba(30,20,60,0.10)", background: "#000",
        }}>
          <video
            src={src}
            controls
            playsInline
            preload="metadata"
            style={{ width: "100%", display: "block", aspectRatio: "16 / 9", background: "#000" }}
          />
        </div>

        <div style={{ marginTop: 16 }}>
          <a href={src} download style={{ fontSize: 14, color: MUTED, textDecoration: "underline" }}>
            {t.download}
          </a>
        </div>
      </div>
    </div>
  );
}
