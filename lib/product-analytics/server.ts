/**
 * Product-analytics dispatcher — SERVER-ONLY (prompt 36).
 *
 * The thin operational half of the tracking layer: it normalises a call
 * through the pure contract (`lib/product-analytics.ts`), hands the resulting
 * event to the REGISTERED adapter, and swallows every failure — an analytics
 * fault must never turn a successful lifecycle write into an error, the same
 * non-throwing posture as the audit writer (`lib/data/audit.ts`).
 *
 * PROVIDER STATUS (honest, per AGENTS.md §7 "no fabricated claims")
 * No analytics provider is configured in PrepGrade. The default adapter is a
 * NO-OP that announces itself once on the first event, so the logs never imply
 * events are being shipped anywhere. When a provider (e.g. PostHog) is
 * approved, `registerProductAnalyticsAdapter` is the single bootstrap seam —
 * no call site changes.
 *
 * FIRE-ONCE DEDUP
 * Call sites pass a `onceKey` for events whose DB guard cannot see every
 * replay (retry-after-lost-response reads of the same moment). The in-memory
 * gate is bounded; the authoritative dedup stays in the database CAS/UPSERT
 * guards that surround each call.
 */

import "server-only";
import {
  buildProductAnalyticsEvent,
  createOnceGate,
  type ProductAnalyticsEvent,
} from "@/lib/product-analytics";

/** The seam a real provider implements. */
export type ProductAnalyticsAdapter = {
  readonly id: string;
  capture(event: ProductAnalyticsEvent): void | Promise<void>;
};

/** The default: keeps the pipeline honest by saying so once, loudly, in the
 *  server log — and shipping nothing. */
const noopAdapter: ProductAnalyticsAdapter = {
  id: "noop",
  capture(): void {
    // Intentionally empty — no provider configured (see header note).
  },
};

let adapter: ProductAnalyticsAdapter = noopAdapter;
let noopAnnounced = false;

/** The shared once-only gate for `trackProductAnalytics({ onceKey })` calls. */
const onceGate = createOnceGate();

/**
 * Replace the active adapter (called ONCE at bootstrapping by a future
 * provider setup — there is no such caller today because no provider is
 * configured). A null/undefined registration restores the no-op.
 */
export function registerProductAnalyticsAdapter(
  next: ProductAnalyticsAdapter | null,
): void {
  adapter = next ?? noopAdapter;
  noopAnnounced = false;
}

/** Which adapter is currently active (for diagnostics and tests). */
export function activeProductAnalyticsAdapterId(): string {
  return adapter.id;
}

/**
 * Track one product-analytics event. Never throws and never blocks the
 * caller's flow on a failure: the event is normalised by the pure layer
 * (privacy/allowlist/bounds), optionally deduplicated via `onceKey`, then
 * handed to the adapter. Returns whether an event was dispatched, which is
 * `false` for dropped (contract-violating) or duplicate calls.
 */
export async function trackProductAnalytics(
  name: string,
  properties?: Record<string, unknown>,
  options?: { institutionId?: string | null; occurredAt?: string; onceKey?: string },
): Promise<boolean> {
  if (options?.onceKey !== undefined && options.onceKey !== "") {
    if (!onceGate.claim(options.onceKey)) return false;
  }

  const event = buildProductAnalyticsEvent({
    name,
    properties,
    institutionId: options?.institutionId ?? null,
    occurredAt: options?.occurredAt,
  });
  if (!event) return false;

  if (adapter === noopAdapter) {
    if (!noopAnnounced) {
      noopAnnounced = true;
      console.info(
        "[product-analytics] no provider configured — events are not being shipped " +
          "(adapter: noop). Register an adapter to enable delivery.",
      );
    }
    return false;
  }

  try {
    await adapter.capture(event);
    return true;
  } catch (error) {
    // Honest, non-fatal — same posture as the platform audit write.
    console.error(
      "[product-analytics] capture failed:",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}
