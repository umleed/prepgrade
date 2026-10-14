/**
 * Small pure helpers shared by auth flows. Kept dependency-free and testable.
 */

/**
 * Allow only same-origin, root-relative redirect targets. This blocks
 * open-redirect attacks via `?next=//evil.com` or `?next=https://evil.com`.
 * Falls back to `/dashboard` for anything that is not a safe internal path.
 */
export function safeInternalRedirect(
  target: string | null | undefined,
  fallback = "/dashboard",
): string {
  if (!target || typeof target !== "string") return fallback;
  // Must start with a single slash and not a protocol-relative "//".
  if (!target.startsWith("/") || target.startsWith("//")) return fallback;
  // Reject backslashes which some browsers treat as slashes.
  if (target.includes("\\")) return fallback;
  return target;
}
