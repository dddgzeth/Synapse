"use client";

import Image from "next/image";
import { FormEvent, useState } from "react";
import { signIn, useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { SynnyMascot } from "./synny-mascot";

// Email login has 3 steps:
//   "email"    — collect email, check if registered
//   "login"    — user exists, collect password
//   "register" — new user, set password + confirm
type Step = "email" | "login" | "register";

const CAPABILITY_CARDS = [
  { icon: "📄", label: "Read research papers" },
  { icon: "🔗", label: "Surface hidden patterns" },
  { icon: "🧠", label: "Build long-term memory" },
  { icon: "🔍", label: "Deep research on demand" },
  { icon: "📁", label: "Connect local folders" },
  { icon: "💡", label: "Track research threads" },
];

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" style={{ flexShrink: 0 }}>
      <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z" />
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 6.293C4.672 4.166 6.656 3.58 9 3.58z" />
    </svg>
  );
}

function StaticPreview() {
  return (
    <div style={{
      flex: 1,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "48px 40px",
    }}>
      <div style={{
        background: "rgba(255,255,255,0.72)",
        backdropFilter: "blur(8px)",
        border: "1px solid rgba(0,0,0,0.08)",
        borderRadius: 20,
        padding: "28px 28px 20px",
        width: "100%",
        maxWidth: 460,
        boxShadow: "0 8px 40px rgba(0,0,0,0.07)",
      }}>
        <div style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 10,
          marginBottom: 20,
        }}>
          {CAPABILITY_CARDS.map((c) => (
            <div key={c.label} style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 12px",
              background: "#fff",
              border: "1px solid rgba(0,0,0,0.08)",
              borderRadius: 10,
              fontSize: 12,
              color: "#333",
              fontWeight: 500,
            }}>
              <span style={{ fontSize: 15 }}>{c.icon}</span>
              <span style={{ lineHeight: 1.3 }}>{c.label}</span>
            </div>
          ))}
        </div>

        <div style={{
          background: "#fff",
          border: "1px solid rgba(0,0,0,0.10)",
          borderRadius: 12,
          padding: "14px 16px",
        }}>
          <p style={{ margin: "0 0 12px", fontSize: 13, color: "#444", lineHeight: 1.5 }}>
            Summarize the key findings across my Zotero papers on FAIR data infrastructure
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "5px 10px", background: "#f5f0e8", borderRadius: 8,
              fontSize: 12, color: "#555",
            }}>
              <span>📁</span><span>Research_Papers</span>
            </div>
            <div style={{ flex: 1 }} />
            <div style={{
              padding: "6px 16px", background: "#1a1a1a", color: "#fff",
              borderRadius: 8, fontSize: 12, fontWeight: 600,
            }}>
              Let's go →
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  height: 44,
  border: "1px solid rgba(0,0,0,0.15)",
  borderRadius: 10,
  padding: "0 14px",
  fontSize: 14,
  background: "#fafafa",
  color: "#1a1a1a",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

const darkBtn: React.CSSProperties = {
  width: "100%",
  height: 44,
  background: "#1a1a1a",
  color: "#fff",
  border: "none",
  borderRadius: 10,
  fontSize: 14,
  fontWeight: 700,
  cursor: "pointer",
};

export function LoginPanel() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { status } = useSession();

  const callbackUrl = searchParams.get("callbackUrl") || "/";

  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState<"google" | "email" | null>(null);

  if (status === "authenticated") {
    router.replace(callbackUrl);
  }

  // Step 1: check email
  async function handleEmailSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading("email");
    try {
      const res = await fetch("/api/auth/check-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();
      setStep(data.exists ? "login" : "register");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(null);
    }
  }

  // Step 2a: login with password
  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading("email");
    const result = await signIn("credentials", {
      email: email.trim(),
      password,
      redirect: false,
      callbackUrl,
    });
    setLoading(null);
    if (result?.error) {
      setError("Incorrect password. Please try again.");
      return;
    }
    router.replace(result?.url || callbackUrl);
  }

  // Step 2b: register new account
  async function handleRegister(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    setLoading("email");
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Registration failed.");
        setLoading(null);
        return;
      }
    } catch {
      setError("Network error. Please try again.");
      setLoading(null);
      return;
    }
    // Auto sign in after registration
    const result = await signIn("credentials", {
      email: email.trim(),
      password,
      redirect: false,
      callbackUrl,
    });
    setLoading(null);
    if (result?.error) {
      setError("Account created but sign-in failed. Try logging in.");
      setStep("login");
      return;
    }
    router.replace(result?.url || callbackUrl);
  }

  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      background: "#f5f0e8",
      color: "#1a1a1a",
      fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      {/* ── Left panel ── */}
      <div style={{
        width: "min(520px, 55%)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "60px 64px",
        flexShrink: 0,
      }}>
        {/* Logo */}
        <div style={{ marginBottom: 48 }}>
          <Image
            src="/logo-horizontal.jpg"
            alt="Synapse"
            width={160}
            height={40}
            style={{ objectFit: "contain", objectPosition: "left", mixBlendMode: "multiply" }}
          />
        </div>

        {/* Headline */}
        <h1 style={{
          margin: "0 0 12px",
          fontSize: 42,
          fontWeight: 700,
          lineHeight: 1.15,
          letterSpacing: "-1px",
          color: "#111",
        }}>
          Research deeper,<br />think further
        </h1>
        <p style={{ margin: "0 0 36px", fontSize: 16, color: "#666", lineHeight: 1.5 }}>
          Your second memory
        </p>

        {/* Login card */}
        <div style={{
          background: "#fff",
          border: "1px solid rgba(0,0,0,0.08)",
          borderRadius: 16,
          padding: "28px 28px 24px",
          boxShadow: "0 4px 24px rgba(0,0,0,0.06)",
          maxWidth: 380,
        }}>
          {/* Google */}
          <button
            type="button"
            onClick={() => { setLoading("google"); signIn("google", { callbackUrl }); }}
            disabled={loading !== null}
            style={{
              width: "100%", height: 44,
              display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
              border: "1px solid rgba(0,0,0,0.15)", borderRadius: 10,
              background: "#fff", color: "#1a1a1a",
              fontSize: 14, fontWeight: 600,
              cursor: loading ? "not-allowed" : "pointer",
              opacity: loading ? 0.6 : 1,
            }}
          >
            <GoogleIcon />
            {loading === "google" ? "Opening Google…" : "Continue with Google"}
          </button>

          {/* OR divider */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "18px 0", color: "#aaa", fontSize: 12 }}>
            <div style={{ height: 1, flex: 1, background: "rgba(0,0,0,0.10)" }} />
            <span>OR</span>
            <div style={{ height: 1, flex: 1, background: "rgba(0,0,0,0.10)" }} />
          </div>

          {/* ── Step 1: email ── */}
          {step === "email" && (
            <form onSubmit={handleEmailSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="Enter your email"
                autoComplete="email"
                required
                style={inputStyle}
              />
              {error && <div style={{ color: "#c0392b", fontSize: 13 }}>{error}</div>}
              <button type="submit" disabled={loading !== null} style={{ ...darkBtn, opacity: loading ? 0.6 : 1, cursor: loading ? "not-allowed" : "pointer" }}>
                {loading === "email" ? "Checking…" : "Continue with email"}
              </button>
            </form>
          )}

          {/* ── Step 2a: existing user — login ── */}
          {step === "login" && (
            <form onSubmit={handleLogin} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 13, color: "#555", marginBottom: 2 }}>
                Signing in as <strong>{email}</strong>
                <button type="button" onClick={() => { setStep("email"); setError(""); setPassword(""); }}
                  style={{ marginLeft: 8, fontSize: 12, color: "#1a1a1a", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>
                  Change
                </button>
              </div>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Password"
                autoComplete="current-password"
                autoFocus
                required
                style={inputStyle}
              />
              {error && <div style={{ color: "#c0392b", fontSize: 13 }}>{error}</div>}
              <button type="submit" disabled={loading !== null} style={{ ...darkBtn, opacity: loading ? 0.6 : 1, cursor: loading ? "not-allowed" : "pointer" }}>
                {loading === "email" ? "Signing in…" : "Sign in"}
              </button>
            </form>
          )}

          {/* ── Step 2b: new user — register ── */}
          {step === "register" && (
            <form onSubmit={handleRegister} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 13, color: "#555", marginBottom: 2 }}>
                Creating account for <strong>{email}</strong>
                <button type="button" onClick={() => { setStep("email"); setError(""); setPassword(""); setConfirm(""); }}
                  style={{ marginLeft: 8, fontSize: 12, color: "#1a1a1a", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>
                  Change
                </button>
              </div>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Create password"
                autoComplete="new-password"
                autoFocus
                required
                style={inputStyle}
              />
              <input
                type="password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                placeholder="Confirm password"
                autoComplete="new-password"
                required
                style={inputStyle}
              />
              {error && <div style={{ color: "#c0392b", fontSize: 13 }}>{error}</div>}
              <button type="submit" disabled={loading !== null} style={{ ...darkBtn, opacity: loading ? 0.6 : 1, cursor: loading ? "not-allowed" : "pointer" }}>
                {loading === "email" ? "Creating account…" : "Create account"}
              </button>
            </form>
          )}

          <p style={{ margin: "16px 0 0", fontSize: 11, color: "#aaa", textAlign: "center", lineHeight: 1.5 }}>
            By continuing, you agree to Synapse's Terms of Service and Privacy Policy.
          </p>
        </div>
      </div>

      {/* ── Right panel ── */}
      <div style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(135deg, #ede8df 0%, #e8e0d4 100%)",
        flexDirection: "column",
        gap: 4,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: -8 }}>
          <SynnyMascot size={92} />
          <div style={{
            background: "rgba(255,255,255,0.82)",
            border: "1px solid rgba(0,0,0,0.06)",
            borderRadius: "14px 14px 14px 2px",
            padding: "10px 16px",
            fontSize: 14,
            fontWeight: 600,
            color: "#4C1D95",
            boxShadow: "0 4px 16px rgba(0,0,0,0.05)",
          }}>
            Hi, I&apos;m Synny — I&apos;ll remember it all for you.
          </div>
        </div>
        <StaticPreview />
      </div>
    </div>
  );
}
