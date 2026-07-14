/**
 * Landing — public marketing page, bilingual.
 *
 * Served at three routes sharing this one component:
 *   /      -> lang="en" (default)
 *   /en    -> lang="en"
 *   /zh    -> lang="zh"  (the link to hand out for the Trae competition)
 *
 * Google for Startups credit eligibility requires a public page where visitors
 * can see what we're building, with a clear business model, without logging in.
 * The actual app lives at /app (auth-gated).
 */
import Link from "next/link";

const VIOLET = "#6D28D9";
const VIOLET_SOFT = "#8B5CF6";
const PAPER = "#FAFAF8";
const INK = "#1A1A1A";
const MUTED = "#6B7280";
const SURFACE = "#FFFFFF";
const BORDER = "#E8E8E0";

type Lang = "en" | "zh";

const wrap: React.CSSProperties = {
  minHeight: "100vh",
  background: PAPER,
  color: INK,
  fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
  overflowY: "auto",
  height: "100vh",
};
const container: React.CSSProperties = { maxWidth: 1080, margin: "0 auto", padding: "0 24px" };
const btnPrimary: React.CSSProperties = {
  display: "inline-block", background: VIOLET, color: "#fff", fontWeight: 700,
  fontSize: 16, padding: "13px 26px", borderRadius: 12, textDecoration: "none",
};
const btnGhost: React.CSSProperties = {
  display: "inline-block", background: "transparent", color: INK, fontWeight: 600,
  fontSize: 16, padding: "13px 24px", borderRadius: 12, textDecoration: "none",
  border: `1px solid ${BORDER}`,
};
const eyebrow: React.CSSProperties = {
  fontSize: 13, fontWeight: 700, letterSpacing: 2, textTransform: "uppercase", color: VIOLET_SOFT,
};
const card: React.CSSProperties = {
  background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 18, padding: "28px 26px",
};

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div style={card}>
      <div style={{ fontSize: 19, fontWeight: 800, marginBottom: 10 }}>{title}</div>
      <div style={{ fontSize: 15.5, color: MUTED, lineHeight: 1.6 }}>{body}</div>
    </div>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: VIOLET, letterSpacing: 1 }}>{n}</div>
      <div style={{ fontSize: 18, fontWeight: 800, marginTop: 8 }}>{title}</div>
      <div style={{ fontSize: 14.5, color: MUTED, lineHeight: 1.55, marginTop: 6 }}>{body}</div>
    </div>
  );
}

function Tier({
  name, price, tagline, features, cta, ctaHref, highlight,
}: {
  name: string; price: string; tagline: string; features: string[];
  cta: string; ctaHref: string; highlight?: boolean;
}) {
  return (
    <div style={{
      ...card, flex: 1, display: "flex", flexDirection: "column",
      border: highlight ? `2px solid ${VIOLET}` : `1px solid ${BORDER}`,
      boxShadow: highlight ? "0 18px 50px rgba(109,40,217,0.12)" : "none",
    }}>
      <div style={{ fontSize: 18, fontWeight: 800 }}>{name}</div>
      <div style={{ fontSize: 30, fontWeight: 800, marginTop: 10 }}>{price}</div>
      <div style={{ fontSize: 14, color: MUTED, marginTop: 6, minHeight: 38 }}>{tagline}</div>
      <ul style={{ listStyle: "none", padding: 0, margin: "18px 0 22px", display: "flex", flexDirection: "column", gap: 10 }}>
        {features.map((f) => (
          <li key={f} style={{ fontSize: 14.5, lineHeight: 1.5, display: "flex", gap: 9 }}>
            <span style={{ color: VIOLET, fontWeight: 800 }}>✓</span><span>{f}</span>
          </li>
        ))}
      </ul>
      <div style={{ marginTop: "auto" }}>
        <Link href={ctaHref} style={{ ...(highlight ? btnPrimary : btnGhost), width: "100%", textAlign: "center", boxSizing: "border-box" }}>
          {cta}
        </Link>
      </div>
    </div>
  );
}

const COPY: Record<Lang, {
  nav: { watchDemo: string; openApp: string; switchTo: string; switchHref: string };
  hero: { eyebrow: string; line1: string; line2Prefix: string; line2Highlight: string; sub: string; cta: string; watch: string };
  problem: { eyebrow: string; h2: string; f: [string, string][] };
  how: { eyebrow: string; h2: string; steps: [string, string, string][] };
  features: { eyebrow: string; h2: string; f: [string, string][] };
  pricing: {
    eyebrow: string; h2: string; sub: string; note: string;
    tiers: { name: string; price: string; tagline: string; features: string[]; cta: string; ctaHref: string; highlight?: boolean }[];
  };
  cta: { h2: string; sub: string; button: string };
  footer: { copyright: string; demo: string; openApp: string; signIn: string };
}> = {
  en: {
    nav: { watchDemo: "Watch demo", openApp: "Open app", switchTo: "中文", switchHref: "/zh" },
    hero: {
      eyebrow: "Your second memory",
      line1: "The AI memory that",
      line2Prefix: "remembers ",
      line2Highlight: "everything.",
      sub: "Synapse keeps every conversation you have with AI — in the browser, in Claude Code, in Codex, anywhere — connects the ideas across them, and surfaces patterns you never asked it to find.",
      cta: "Get started",
      watch: "Watch the demo →",
    },
    problem: {
      eyebrow: "The problem",
      h2: "AI can remember. It just can't keep all of it.",
      f: [
        ["Context windows fill up", "As a conversation grows, older messages get compacted or dropped, and the model stops seeing them."],
        ["Memory needs babysitting", "You decide what to save, tag it, and organize it. Miss a step and the insight is gone."],
        ["Nothing connects the dots", "The patterns that matter span weeks and dozens of chats, and you are the only one keeping track."],
      ],
    },
    how: {
      eyebrow: "How it works",
      h2: "One simple loop: chat, memory, recall, reply.",
      steps: [
        ["01 · CHAT", "You talk", "Just have a normal conversation. No tagging, no buttons."],
        ["02 · MEMORY", "It becomes memory", "Every turn is saved in full and distilled into layers, automatically."],
        ["03 · RECALL", "The right context returns", "Before each reply, Synapse pulls your most relevant memories from disk."],
        ["04 · REPLY", "Grounded answers", "Every answer is grounded in everything you have ever told it."],
      ],
    },
    features: {
      eyebrow: "What you get",
      h2: "A memory layer for everything you think through with AI.",
      f: [
        ["Synapse noticed", "Synapse detects patterns across your conversations on its own, and surfaces them when they matter — no button required."],
        ["Works across every AI tool", "Connect Claude Code, Codex, Cursor, or any MCP client with one pasted instruction. Every finished turn syncs back automatically — no copy-paste, no manual saving."],
        ["Evidence graph", "Every insight traces all the way back to the original message it came from. Explainable, not a black box."],
        ["Full-text recall", "Search any word from any past conversation and jump straight to it. Nothing is ever truly lost."],
        ["Deep Research", "Agentic web research over Semantic Scholar and arXiv, streamed live, with results folded back into your memory."],
        ["One-click export", "Export your entire memory as a single file at any time. Your memory is yours — migrate whenever you want."],
      ],
    },
    pricing: {
      eyebrow: "Pricing",
      h2: "A simple, value-based business model.",
      sub: "We don't sell tokens — we sell the memory layer. The core product is a subscription, heavy AI usage and Deep Research are billed by usage, and teams pay per seat.",
      note: "Pricing shown is indicative and may change as the product evolves.",
      tiers: [
        {
          name: "Free", price: "$0", tagline: "For individuals getting started with a second memory.",
          features: ["Full four-layer memory pipeline", "Passive “Synapse noticed” insights", "Full-text conversation search", "Single user"],
          cta: "Start free", ctaHref: "/app",
        },
        {
          name: "Pro", price: "$12/mo", tagline: "For power users who live in AI all day.",
          features: ["Everything in Free", "Connect every AI tool via MCP", "Deep Research (Semantic Scholar + arXiv)", "Usage-based AI compute, billed transparently", "One-click full export"],
          cta: "Go Pro", ctaHref: "/app", highlight: true,
        },
        {
          name: "Team", price: "Custom", tagline: "For labs and teams that need a shared memory layer.",
          features: ["Everything in Pro", "Shared / team memory layer", "Self-hosted or private deployment", "Admin controls & priority support"],
          cta: "Contact us", ctaHref: "mailto:congjian.lin@u.nus.edu",
        },
      ],
    },
    cta: {
      h2: "Memory that stays with your work.",
      sub: "For everyone who thinks out loud with AI.",
      button: "Open Synapse →",
    },
    footer: { copyright: "© 2026 Synapse · Your second memory.", demo: "Demo", openApp: "Open app", signIn: "Sign in" },
  },
  zh: {
    nav: { watchDemo: "观看演示", openApp: "打开应用", switchTo: "EN", switchHref: "/en" },
    hero: {
      eyebrow: "你的第二记忆",
      line1: "记住一切的",
      line2Prefix: "",
      line2Highlight: "AI 记忆。",
      sub: "Synapse 保留你和 AI 的每一次对话——网页里、Claude Code 里、Codex 里,不管在哪——把它们之间的想法连接起来,主动浮现你从未开口去找的规律。",
      cta: "开始使用",
      watch: "观看演示 →",
    },
    problem: {
      eyebrow: "问题所在",
      h2: "AI 能记住,只是记不全。",
      f: [
        ["上下文窗口会填满", "对话越聊越长,早期的消息会被压缩或丢弃,模型也就看不到了。"],
        ["记忆需要人盯着", "存什么、怎么打标签、怎么整理,都得你自己决定。漏一步,想法就没了。"],
        ["没有人帮你把点连起来", "真正重要的规律,往往横跨几周、几十次对话,而记住这一切的只有你自己。"],
      ],
    },
    how: {
      eyebrow: "工作原理",
      h2: "一个简单的循环:对话、记忆、召回、回复。",
      steps: [
        ["01 · 对话", "你说话", "正常聊天就行,不用打标签,不用点按钮。"],
        ["02 · 记忆", "自动变成记忆", "每一轮对话都被完整保存,并自动蒸馏成分层记忆。"],
        ["03 · 召回", "对的上下文会回来", "每次回复之前,Synapse 都会从硬盘里把最相关的记忆找回来。"],
        ["04 · 回复", "有据可依的回答", "每一个回答,都建立在你曾经告诉过它的一切之上。"],
      ],
    },
    features: {
      eyebrow: "你会获得什么",
      h2: "一层记忆,覆盖你用 AI 思考过的一切。",
      f: [
        ["Synapse 注意到", "Synapse 会自己在你的对话里发现规律,在真正有意义的时候主动说出来——不需要你按任何按钮。"],
        ["跨越你用的每一个 AI 工具", "粘贴一段指令,就能连上 Claude Code、Codex、Cursor 或任何支持 MCP 的工具。每一轮对话结束后自动同步回来,不用手动复制粘贴,也不用自己保存。"],
        ["证据图谱", "每一条发现,都能一路追溯回最初的那条消息。有据可查,不是黑箱。"],
        ["全文检索", "搜索任何一个词,从任何一次历史对话里,直接跳过去。没有什么会真正丢失。"],
        ["深度调研", "对 Semantic Scholar 和 arXiv 进行智能体式联网调研,实时流式呈现,结果自动折叠进你的记忆。"],
        ["一键导出", "随时把整个记忆导出成一个文件。你的记忆是你的,想搬走随时搬走。"],
      ],
    },
    pricing: {
      eyebrow: "定价",
      h2: "一套简单、按价值收费的商业模式。",
      sub: "我们卖的不是 token,是这一层记忆本身。核心产品走订阅制,重度 AI 用量和深度调研按用量计费,团队按席位付费。",
      note: "以上定价仅供参考,可能随产品迭代调整。",
      tiers: [
        {
          name: "免费版", price: "$0", tagline: "适合刚开始搭建第二记忆的个人用户。",
          features: ["完整的四层记忆流水线", "被动的“Synapse 注意到”洞察", "全文对话搜索", "单用户"],
          cta: "免费开始", ctaHref: "/app",
        },
        {
          name: "专业版", price: "$12/月", tagline: "适合整天泡在 AI 里的重度用户。",
          features: ["包含免费版全部功能", "通过 MCP 连接每一个 AI 工具", "深度调研(Semantic Scholar + arXiv)", "按用量计费的 AI 算力,透明计价", "一键完整导出"],
          cta: "升级专业版", ctaHref: "/app", highlight: true,
        },
        {
          name: "团队版", price: "定制", tagline: "适合需要共享记忆层的实验室和团队。",
          features: ["包含专业版全部功能", "共享/团队记忆层", "自托管或私有化部署", "管理员控制 + 优先支持"],
          cta: "联系我们", ctaHref: "mailto:congjian.lin@u.nus.edu",
        },
      ],
    },
    cta: {
      h2: "记忆,始终陪着你的工作。",
      sub: "献给每一个愿意对 AI 说出所思所想的人。",
      button: "打开 Synapse →",
    },
    footer: { copyright: "© 2026 Synapse · 你的第二记忆。", demo: "演示", openApp: "打开应用", signIn: "登录" },
  },
};

export function Landing({ lang = "en" }: { lang?: Lang }) {
  const t = COPY[lang];
  // Self-hosted, not YouTube — YouTube is blocked in mainland China, and this
  // avoids a third-party platform dependency entirely.
  const demoHref = lang === "en" ? "/demo-en" : "/demo-zh";
  return (
    <div style={wrap}>
      {/* Nav */}
      <nav style={{ ...container, display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 22, paddingBottom: 22 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-mark.png" alt="Synapse" style={{ height: 30, width: "auto" }} />
          <span style={{ fontSize: 19, fontWeight: 800, letterSpacing: 1, color: VIOLET }}>SYNAPSE</span>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Link href={t.nav.switchHref} style={{ color: MUTED, textDecoration: "none", fontSize: 14, fontWeight: 700 }}>{t.nav.switchTo}</Link>
          <Link href={demoHref} style={{ ...btnGhost, padding: "10px 18px" }}>{t.nav.watchDemo}</Link>
          <Link href="/app" style={{ ...btnPrimary, padding: "10px 20px" }}>{t.nav.openApp}</Link>
        </div>
      </nav>

      {/* Hero */}
      <header style={{ ...container, textAlign: "center", paddingTop: 70, paddingBottom: 40 }}>
        <div style={eyebrow}>{t.hero.eyebrow}</div>
        <h1 style={{ fontSize: 60, fontWeight: 800, letterSpacing: -1.5, lineHeight: 1.05, margin: "16px 0 0" }}>
          {t.hero.line1}<br />{t.hero.line2Prefix}<span style={{ color: VIOLET }}>{t.hero.line2Highlight}</span>
        </h1>
        <p style={{ fontSize: 20, color: MUTED, maxWidth: 640, margin: "22px auto 0", lineHeight: 1.5 }}>
          {t.hero.sub}
        </p>
        <div style={{ display: "flex", gap: 14, justifyContent: "center", marginTop: 34 }}>
          <Link href="/app" style={btnPrimary}>{t.hero.cta}</Link>
          <Link href={demoHref} style={btnGhost}>{t.hero.watch}</Link>
        </div>
      </header>

      {/* Problem */}
      <section style={{ ...container, paddingTop: 60, paddingBottom: 20 }}>
        <div style={eyebrow}>{t.problem.eyebrow}</div>
        <h2 style={{ fontSize: 34, fontWeight: 800, letterSpacing: -0.8, margin: "12px 0 26px" }}>
          {t.problem.h2}
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 18 }}>
          {t.problem.f.map(([title, body]) => <Feature key={title} title={title} body={body} />)}
        </div>
      </section>

      {/* How it works */}
      <section style={{ ...container, paddingTop: 60, paddingBottom: 20 }}>
        <div style={eyebrow}>{t.how.eyebrow}</div>
        <h2 style={{ fontSize: 34, fontWeight: 800, letterSpacing: -0.8, margin: "12px 0 26px" }}>
          {t.how.h2}
        </h2>
        <div style={{ ...card, display: "flex", gap: 28 }}>
          {t.how.steps.map(([n, title, body]) => <Step key={n} n={n} title={title} body={body} />)}
        </div>
      </section>

      {/* Features */}
      <section style={{ ...container, paddingTop: 60, paddingBottom: 20 }}>
        <div style={eyebrow}>{t.features.eyebrow}</div>
        <h2 style={{ fontSize: 34, fontWeight: 800, letterSpacing: -0.8, margin: "12px 0 26px" }}>
          {t.features.h2}
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 18 }}>
          {t.features.f.map(([title, body]) => <Feature key={title} title={title} body={body} />)}
        </div>
      </section>

      {/* Pricing / Business model */}
      <section style={{ ...container, paddingTop: 60, paddingBottom: 20 }}>
        <div style={eyebrow}>{t.pricing.eyebrow}</div>
        <h2 style={{ fontSize: 34, fontWeight: 800, letterSpacing: -0.8, margin: "12px 0 8px" }}>
          {t.pricing.h2}
        </h2>
        <p style={{ fontSize: 16, color: MUTED, maxWidth: 720, margin: "0 0 26px", lineHeight: 1.6 }}>
          {t.pricing.sub}
        </p>
        <div style={{ display: "flex", gap: 18, alignItems: "stretch" }}>
          {t.pricing.tiers.map((tier) => <Tier key={tier.name} {...tier} />)}
        </div>
        <p style={{ fontSize: 13, color: MUTED, marginTop: 16 }}>
          {t.pricing.note}
        </p>
      </section>

      {/* CTA */}
      <section style={{ ...container, paddingTop: 64, paddingBottom: 40, textAlign: "center" }}>
        <h2 style={{ fontSize: 38, fontWeight: 800, letterSpacing: -1, margin: "0 0 8px" }}>
          {t.cta.h2}
        </h2>
        <p style={{ fontSize: 18, color: MUTED, margin: "0 0 26px" }}>
          {t.cta.sub}
        </p>
        <Link href="/app" style={btnPrimary}>{t.cta.button}</Link>
      </section>

      {/* Footer */}
      <footer style={{ borderTop: `1px solid ${BORDER}`, marginTop: 30 }}>
        <div style={{ ...container, display: "flex", justifyContent: "space-between", alignItems: "center", padding: "24px 24px", flexWrap: "wrap", gap: 12 }}>
          <div style={{ fontSize: 14, color: MUTED }}>{t.footer.copyright}</div>
          <div style={{ display: "flex", gap: 18, fontSize: 14 }}>
            <Link href={demoHref} style={{ color: MUTED, textDecoration: "none" }}>{t.footer.demo}</Link>
            <Link href="/app" style={{ color: MUTED, textDecoration: "none" }}>{t.footer.openApp}</Link>
            <Link href="/login" style={{ color: MUTED, textDecoration: "none" }}>{t.footer.signIn}</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
