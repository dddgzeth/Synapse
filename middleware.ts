import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";

const PUBLIC_PATHS = [
  "/login",
  "/api/auth",
  // MCP endpoint authenticates via Bearer PAT inside the route (lib/api-tokens),
  // not via NextAuth cookies — terminal clients can't carry those.
  "/api/mcp",
  // Public: the auto-capture hook script, fetched by `curl` during setup.
  "/api/hook",
  "/_next",
  "/favicon.ico",
  "/logo",
  "/logo.png",
  "/logo-mark.png",
  "/logo-vertical.png",
  "/logo-horizontal.jpg",
];

function isPublicPath(pathname: string): boolean {
  // Public marketing landing page lives at the root path.
  if (pathname === "/") return true;
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (token) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("callbackUrl", req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/:path*"],
};
