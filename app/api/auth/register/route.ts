import { NextRequest, NextResponse } from "next/server";
import { getUserByEmail, createEmailUser } from "@/lib/memory/store";

export async function POST(req: NextRequest) {
  const { email, password } = await req.json();
  if (!email || !password || typeof email !== "string" || typeof password !== "string") {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  if (password.length < 6) {
    return NextResponse.json({ error: "Password must be at least 6 characters" }, { status: 400 });
  }
  const normalized = email.trim().toLowerCase();
  if (getUserByEmail(normalized)) {
    return NextResponse.json({ error: "Email already registered" }, { status: 409 });
  }
  createEmailUser(normalized, password);
  return NextResponse.json({ ok: true });
}
