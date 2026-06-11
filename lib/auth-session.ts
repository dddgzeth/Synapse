import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export async function getCurrentUserId(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  return session?.user?.id ?? null;
}

/**
 * Resolve the effective sessionKey for the current request.
 *
 * Accepts a `requested` sessionKey (from query param / body) and validates that
 * it belongs to the signed-in user — only `chat_<userId>` or
 * `chat_<userId>_<anything>` are allowed. Returns the requested key when valid,
 * otherwise the default `chat_<userId>`. Returns null if no user is signed in.
 */
export async function getCurrentSessionKey(requested?: string | null): Promise<string | null> {
  const userId = await getCurrentUserId();
  if (!userId) return null;
  const defaultKey = `chat_${userId}`;
  if (!requested) return defaultKey;
  if (requested === defaultKey || requested.startsWith(`${defaultKey}_`)) {
    return requested;
  }
  return defaultKey;
}
