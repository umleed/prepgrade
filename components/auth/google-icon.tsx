import { cn } from "@/lib/utils";

/**
 * Official four-colour Google "G" mark for the OAuth button. Uses fixed brand
 * colours (not currentColor) because it is a logo, so it is always paired with
 * visible text and marked `aria-hidden`.
 */
export function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={cn("h-5 w-5", className)}
    >
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.81Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.08 7.94-2.92l-3.88-3c-1.08.72-2.46 1.15-4.06 1.15-3.12 0-5.76-2.11-6.7-4.94H1.28v3.11A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.3 14.29a7.2 7.2 0 0 1 0-4.58V6.6H1.28a12 12 0 0 0 0 10.8l4.02-3.11Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44A11.98 11.98 0 0 0 12 0 12 12 0 0 0 1.28 6.6l4.02 3.11C6.24 6.88 8.88 4.77 12 4.77Z"
      />
    </svg>
  );
}
