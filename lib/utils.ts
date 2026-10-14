/**
 * Shared class-name helper.
 *
 * Dependency-free conditional joiner used by UI primitives to compose Tailwind
 * classes. Kept intentionally small so no new packages (clsx / tailwind-merge)
 * are introduced without approval (AGENTS.md §9).
 */
export type ClassValue =
  | string
  | number
  | null
  | undefined
  | false
  | ClassValue[];

/** Flatten conditional inputs and join them into a single class string. */
export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];

  for (const input of inputs) {
    if (!input) continue;

    if (Array.isArray(input)) {
      const nested = cn(...input);
      if (nested) out.push(nested);
    } else {
      out.push(String(input));
    }
  }

  return out.join(" ");
}
