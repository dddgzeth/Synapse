import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { BARE_PAGES } from "@/lib/public-pages";

// Paths outside BARE_PAGES that also need to bypass auth: static assets, the
// static mp4 files the demo pages load (the /demo-en /demo-zh PAGES are in
// BARE_PAGES, but the video file request itself is a separate path and needs
// its own bypass or the page loads while the <video> element 401s), and a
// couple of API routes that authenticate a different way (Bearer PAT, or are
// meant to be fetched by `curl`/tools instead of a logged-in browser).
const PUBLIC_PATHS = [
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
  "/demo",
];

function isPublicPath(pathname: string): boolean {
  if (pathname === "/login" || (BARE_PAGES as readonly string[]).includes(pathname)) return true;
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
