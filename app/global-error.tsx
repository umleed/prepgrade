"use client";

/**
 * Global error boundary (prompt 37). This renders when the ROOT layout itself
 * fails, so it cannot depend on anything from that layout — no shared fonts,
 * no providers, and not even the Tailwind stylesheet. It therefore declares
 * its own <html>/<body> (required by Next for this boundary) and uses inline
 * styles drawn from the same design tokens, so the recovery screen always
 * renders. Copy stays honest: no fabricated support contacts or guarantees.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#f8fafc",
          color: "#0f172a",
          font:
            "16px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          WebkitFontSmoothing: "antialiased",
        }}
      >
        <main
          role="alert"
          style={{
            maxWidth: "32rem",
            width: "100%",
            padding: "24px",
            textAlign: "center",
          }}
        >
          <div
            aria-hidden="true"
            style={{
              width: 48,
              height: 48,
              margin: "0 auto 16px",
              borderRadius: "9999px",
              background: "#fef2f2",
              color: "#b91c1c",
              fontSize: 24,
              lineHeight: "48px",
            }}
          >
            !
          </div>
          <h1 style={{ margin: "0 0 8px", fontSize: 18, fontWeight: 700 }}>
            Something went wrong
          </h1>
          <p style={{ margin: "0 0 20px", fontSize: 14, color: "#475569" }}>
            A critical error prevented the app from loading. Try again — if it
            keeps happening, reload the page.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              height: 40,
              padding: "0 16px",
              borderRadius: 8,
              border: "none",
              background: "#2563eb",
              color: "#ffffff",
              fontSize: 14,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          {error.digest ? (
            <p style={{ marginTop: 16, fontSize: 12, color: "#94a3b8" }}>
              Reference: {error.digest}
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
