/**
 * Single source of truth for "bare" public pages — no login required, no app
 * chrome (sidebar). Used by BOTH middleware.ts (auth gate) and app-shell.tsx
 * (sidebar rendering) — these used to be two separately-maintained lists and
 * it was easy to add a new marketing page to one and forget the other
 * (exactly what happened with /en and /zh).
 */
export const BARE_PAGES = ["/", "/en", "/zh", "/demo-en", "/demo-zh"];

export function isBarePage(pathname: string): boolean {
  return BARE_PAGES.includes(pathname);
}
