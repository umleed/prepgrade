/**
 * Platform settings presentation tests — Super Admin read-only "Settings".
 *
 * Pure modules only (lib/platform-settings.ts) — no Supabase, no Next, no
 * server-only import. These pin the honest rules the screen depends on:
 *   - a configuration signal maps to a status word + tone from the boolean the
 *     server already established (never a guessed value),
 *   - the privacy guard: a rendered row exposes a variable NAME and never a
 *     value, and the runtime guard REFUSES any extra field,
 *   - health posture states are distinct: available/unavailable and the three
 *     audit-liveness branches never collapse into a fake "green" or "zero",
 *   - the degraded banner is driven by an unavailable core signal only.
 *
 * The SUPER_ADMIN gate that guards the route is covered by
 * tests/platform/super-admin-access.test.mts (the page calls requireSuperAdmin,
 * i.e. the same decideAccess({roles:["SUPER_ADMIN"]}) rule that file pins); no
 * new schema or write path exists here, so there is nothing further to probe.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertConfigurationRowSafe,
  auditLivenessPresentation,
  configurationRow,
  healthSignalPresentation,
  isPostureDegraded,
  type ConfigSignalLike,
} from "../../lib/platform-settings.ts";

// --- Configuration signal → row --------------------------------------------------

describe("configurationRow", () => {
  const configured: ConfigSignalLike = {
    label: "Supabase service-role connection",
    variable: "SUPABASE_SERVICE_ROLE_KEY",
    configured: true,
    missingNote: "Nothing works without it.",
  };

  it("maps a configured signal to a success row and drops the warning text", () => {
    const row = configurationRow(configured);
    assert.equal(row.status, "Configured");
    assert.equal(row.tone, "success");
    assert.equal(row.missingNote, null);
    // The name is shown; there is no value field to show.
    assert.equal(row.variable, "SUPABASE_SERVICE_ROLE_KEY");
    assert.equal("value" in row, false, "a row must never carry a secret value");
  });

  it("maps an absent signal to a warning row that keeps the missing note", () => {
    const row = configurationRow({ ...configured, configured: false });
    assert.equal(row.status, "Not configured");
    assert.equal(row.tone, "warning");
    assert.equal(row.missingNote, "Nothing works without it.");
  });

  it("fails closed on a blank variable name without ever inventing a value", () => {
    const row = configurationRow({ ...configured, variable: "   " });
    assert.equal(row.variable, "Unknown variable");
  });
});

describe("assertConfigurationRowSafe (secret-leak guard)", () => {
  it("passes a well-formed row through unchanged", () => {
    const row = configurationRow({
      label: "Auth provider server keys (Clerk)",
      variable: "CLERK_SECRET_KEY",
      configured: false,
      missingNote: "Invitations unavailable.",
    });
    assert.equal(assertConfigurationRowSafe(row), row);
  });

  it("throws when a value-bearing field appears on the row", () => {
    const row = {
      ...configurationRow({
        label: "x",
        variable: "SECRET",
        configured: true,
        missingNote: "y",
      }),
      // Simulate a future edit that leaked the raw secret onto the row.
      value: "sk-live-do-not-render",
    };
    assert.throws(() => assertConfigurationRowSafe(row), /secret values/);
  });
});

// --- Health posture -----------------------------------------------------------------

describe("healthSignalPresentation", () => {
  it("shows an available signal as success with the good label", () => {
    assert.deepEqual(
      healthSignalPresentation({ state: "available" }, "Reachable", "Unreachable"),
      { tone: "success", label: "Reachable" },
    );
  });

  it("shows an unavailable signal as its own neutral state, not a failure colour", () => {
    assert.deepEqual(
      healthSignalPresentation({ state: "unavailable", reason: "error" }, "Readable", "Not readable"),
      { tone: "neutral", label: "Unavailable" },
    );
  });
});

describe("auditLivenessPresentation", () => {
  it("keeps the three honest branches distinct", () => {
    assert.equal(auditLivenessPresentation({ state: "live", newestEventAt: "x" }).tone, "success");
    assert.equal(auditLivenessPresentation({ state: "empty" }).tone, "info");
    assert.equal(
      auditLivenessPresentation({ state: "unavailable", reason: "missing_table" }).tone,
      "warning",
    );
  });

  it("names the two unavailable reasons differently", () => {
    assert.match(
      auditLivenessPresentation({ state: "unavailable", reason: "missing_table" }).detail,
      /not migrated/,
    );
    assert.match(
      auditLivenessPresentation({ state: "unavailable", reason: "error" }).detail,
      /could not be read/,
    );
  });
});

describe("isPostureDegraded", () => {
  it("is false only when every core signal is available", () => {
    assert.equal(
      isPostureDegraded([{ state: "available" }, { state: "available" }]),
      false,
    );
  });

  it("is true when any core signal could not run", () => {
    assert.equal(
      isPostureDegraded([{ state: "available" }, { state: "unavailable", reason: "error" }]),
      true,
    );
  });
});
