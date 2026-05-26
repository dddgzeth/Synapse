import { NextRequest, NextResponse } from "next/server";
import { getUserByEmail } from "@/lib/memory/store";

export async function POST(req: NextRequest) {
  const { email } = await req.json();
  if (!email || typeof email !== "string") {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const user = getUserByEmail(email.trim().toLowerCase());
  return NextResponse.json({ exists: !!user });
}
