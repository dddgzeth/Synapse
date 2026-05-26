import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export async function getCurrentUserId(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  return session?.user?.id ?? null;
}

export async function getCurrentSessionKey(fallback?: string): Promise<string | null> {
  const userId = await getCurrentUserId();
  if (userId) return `chat_${userId}`;
  return fallback ?? null;
}
