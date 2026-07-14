/**
 * Landing — public marketing page at "/" (no login required).
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
const YT = "https://www.youtube.com/watch?v=3FjaOnHsJBY";

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

export function Landing() {
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
          <a href={YT} target="_blank" rel="noreferrer" style={{ ...btnGhost, padding: "10px 18px" }}>Watch demo</a>
          <Link href="/app" style={{ ...btnPrimary, padding: "10px 20px" }}>Open app</Link>
        </div>
      </nav>

      {/* Hero */}
      <header style={{ ...container, textAlign: "center", paddingTop: 70, paddingBottom: 40 }}>
        <div style={eyebrow}>Your second memory</div>
        <h1 style={{ fontSize: 60, fontWeight: 800, letterSpacing: -1.5, lineHeight: 1.05, margin: "16px 0 0" }}>
          The AI memory that<br />remembers <span style={{ color: VIOLET }}>everything</span>.
        </h1>
        <p style={{ fontSize: 20, color: MUTED, maxWidth: 640, margin: "22px auto 0", lineHeight: 1.5 }}>
          Synapse keeps every conversation you have with AI, connects the ideas across them,
          and surfaces patterns you never asked it to find.
        </p>
        <div style={{ display: "flex", gap: 14, justifyContent: "center", marginTop: 34 }}>
          <Link href="/app" style={btnPrimary}>Get started</Link>
          <a href={YT} target="_blank" rel="noreferrer" style={btnGhost}>Watch the demo →</a>
        </div>
      </header>

      {/* Problem */}
      <section style={{ ...container, paddingTop: 60, paddingBottom: 20 }}>
        <div style={eyebrow}>The problem</div>
        <h2 style={{ fontSize: 34, fontWeight: 800, letterSpacing: -0.8, margin: "12px 0 26px" }}>
          AI can remember. It just can&apos;t keep all of it.
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 18 }}>
          <Feature title="Context windows fill up" body="As a conversation grows, older messages get compacted or dropped, and the model stops seeing them." />
          <Feature title="Memory needs babysitting" body="You decide what to save, tag it, and organize it. Miss a step and the insight is gone." />
          <Feature title="Nothing connects the dots" body="The patterns that matter span weeks and dozens of chats, and you are the only one keeping track." />
        </div>
      </section>

      {/* How it works */}
      <section style={{ ...container, paddingTop: 60, paddingBottom: 20 }}>
        <div style={eyebrow}>How it works</div>
        <h2 style={{ fontSize: 34, fontWeight: 800, letterSpacing: -0.8, margin: "12px 0 26px" }}>
          One simple loop: chat, memory, recall, reply.
        </h2>
        <div style={{ ...card, display: "flex", gap: 28 }}>
          <Step n="01 · CHAT" title="You talk" body="Just have a normal conversation. No tagging, no buttons." />
          <Step n="02 · MEMORY" title="It becomes memory" body="Every turn is saved in full and distilled into layers, automatically." />
          <Step n="03 · RECALL" title="The right context returns" body="Before each reply, Synapse pulls your most relevant memories from disk." />
          <Step n="04 · REPLY" title="Grounded answers" body="Every answer is grounded in everything you have ever told it." />
        </div>
      </section>

      {/* Features */}
      <section style={{ ...container, paddingTop: 60, paddingBottom: 20 }}>
        <div style={eyebrow}>What you get</div>
        <h2 style={{ fontSize: 34, fontWeight: 800, letterSpacing: -0.8, margin: "12px 0 26px" }}>
          A memory layer for everything you think through with AI.
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 18 }}>
          <Feature title="Synapse Noticed" body="Synapse detects patterns across your conversations on its own, and surfaces them when they matter — no button required." />
          <Feature title="Evidence graph" body="Every insight traces all the way back to the original message it came from. Explainable, not a black box." />
          <Feature title="Full-text recall" body="Search any word from any past conversation and jump straight to it. Nothing is ever truly lost." />
          <Feature title="Deep Research" body="Agentic web research over Semantic Scholar and arXiv, streamed live, with results folded back into your memory." />
          <Feature title="Local-first & private" body="Your data lives on your own server in a single database. Privacy you control." />
          <Feature title="One-click export" body="Export your entire memory as a single file at any time. Your memory is yours — migrate whenever you want." />
        </div>
      </section>

      {/* Pricing / Business model */}
      <section style={{ ...container, paddingTop: 60, paddingBottom: 20 }}>
        <div style={eyebrow}>Pricing</div>
        <h2 style={{ fontSize: 34, fontWeight: 800, letterSpacing: -0.8, margin: "12px 0 8px" }}>
          A simple, value-based business model.
        </h2>
        <p style={{ fontSize: 16, color: MUTED, maxWidth: 720, margin: "0 0 26px", lineHeight: 1.6 }}>
          We don&apos;t sell tokens — we sell the memory layer. The core product is a subscription,
          heavy AI usage and Deep Research are billed by usage, and teams pay per seat.
        </p>
        <div style={{ display: "flex", gap: 18, alignItems: "stretch" }}>
          <Tier
            name="Free"
            price="$0"
            tagline="For individuals getting started with a second memory."
            features={[
              "Full four-layer memory pipeline",
              "Passive “Synapse Noticed” insights",
              "Full-text conversation search",
              "Single user",
            ]}
            cta="Start free"
            ctaHref="/app"
          />
          <Tier
            name="Pro"
            price="$12/mo"
            tagline="For power users who live in AI all day."
            features={[
              "Everything in Free",
              "Deep Research (Semantic Scholar + arXiv)",
              "Usage-based AI compute, billed transparently",
              "Higher memory & recall limits",
              "One-click full export",
            ]}
            cta="Go Pro"
            ctaHref="/app"
            highlight
          />
          <Tier
            name="Team"
            price="Custom"
            tagline="For labs and teams that need a shared memory layer."
            features={[
              "Everything in Pro",
              "Shared / team memory layer",
              "Self-hosted or private deployment",
              "Admin controls & priority support",
            ]}
            cta="Contact us"
            ctaHref="mailto:congjian.lin@u.nus.edu"
          />
        </div>
        <p style={{ fontSize: 13, color: MUTED, marginTop: 16 }}>
          Pricing shown is indicative and may change as the product evolves.
        </p>
      </section>

      {/* CTA */}
      <section style={{ ...container, paddingTop: 64, paddingBottom: 40, textAlign: "center" }}>
        <h2 style={{ fontSize: 38, fontWeight: 800, letterSpacing: -1, margin: "0 0 8px" }}>
          Memory that stays with your work.
        </h2>
        <p style={{ fontSize: 18, color: MUTED, margin: "0 0 26px" }}>
          For everyone who thinks out loud with AI.
        </p>
        <Link href="/app" style={btnPrimary}>Open Synapse →</Link>
      </section>

      {/* Footer */}
      <footer style={{ borderTop: `1px solid ${BORDER}`, marginTop: 30 }}>
        <div style={{ ...container, display: "flex", justifyContent: "space-between", alignItems: "center", padding: "24px 24px", flexWrap: "wrap", gap: 12 }}>
          <div style={{ fontSize: 14, color: MUTED }}>© 2026 Synapse · Your second memory.</div>
          <div style={{ display: "flex", gap: 18, fontSize: 14 }}>
            <a href={YT} target="_blank" rel="noreferrer" style={{ color: MUTED, textDecoration: "none" }}>Demo</a>
            <Link href="/app" style={{ color: MUTED, textDecoration: "none" }}>Open app</Link>
            <Link href="/login" style={{ color: MUTED, textDecoration: "none" }}>Sign in</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
