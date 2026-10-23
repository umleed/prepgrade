/**
 * Institution registration tests — platform "Add Institution" flow.
 *
 * Pure modules only (lib/institutions.ts + the audit catalog), same Node
 * built-in runner as the rest of the suite — no Supabase, no Next. These pin
 * the input contract the SUPER_ADMIN server action depends on:
 *   - required fields fail closed (never defaulted, never guessed),
 *   - bounds mirror the migration 0015 CHECK constraints,
 *   - the controlled type vocabulary is the only accepted one,
 *   - email/phone validation and phone normalisation,
 *   - the duplicate-key normalisation shared with the DB unique index,
 *   - a valid submission normalises into the exact data-layer payload shape,
 *   - the new audited action is a recognised catalog member.
 *
 * The database half (column CHECKs, the unique name index) is covered by
 * supabase/tests/institution_registration_readiness.sql, and the SUPER_ADMIN
 * gate that guards the whole area by tests/platform/super-admin-access.test.mts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  INSTITUTION_REGISTRATION_LIMITS,
  normalizeContactPhone,
  normalizeInstitutionNameKey,
  validateInstitutionRegistration,
} from "../../lib/institutions.ts";
import {
  buildAuditEntry,
  isPlatformAuditAction,
  platformAuditActionLabel,
} from "../../lib/audit/platform.ts";

/** A complete, valid submission — the baseline the variants below mutate. */
function validRaw(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: "Al-Furqan Secondary School",
    type: "school",
    shortName: "AFSS",
    description: "A community secondary school in Borno State.",
    country: "Nigeria",
    state: "Borno",
    city: "Maiduguri",
    address: "No. 12, Maiduguri Road, Borno State",
    contactPerson: "Ahmad Sani",
    contactEmail: "Admin@School.Edu.NG",
    contactPhone: "+234 803 123 4567",
    ...overrides,
  };
}

// --- Valid submissions -------------------------------------------------------

describe("validateInstitutionRegistration (valid input)", () => {
  it("accepts a complete submission and normalises every field", () => {
    const result = validateInstitutionRegistration(validRaw());
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const { value } = result;
    assert.equal(value.name, "Al-Furqan Secondary School");
    assert.equal(value.type, "school");
    assert.equal(value.shortName, "AFSS");
    // Email is lower-cased for a stable uniqueness/lookup shape.
    assert.equal(value.contactEmail, "admin@school.edu.ng");
    // Phone is normalised to optional + plus digits only.
    assert.equal(value.contactPhone, "+2348031234567");
  });

  it("trims whitespace and folds blank optionals to null", () => {
    const result = validateInstitutionRegistration(
      validRaw({
        name: "  Greenfield Tutorial Centre  ",
        shortName: "   ",
        description: "",
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.name, "Greenfield Tutorial Centre");
    assert.equal(result.value.shortName, null);
    assert.equal(result.value.description, null);
  });

  it("accepts every controlled institution type", () => {
    for (const type of ["school", "tutorial_centre", "cbt_centre"]) {
      const result = validateInstitutionRegistration(validRaw({ type }));
      assert.equal(result.ok, true, type);
    }
  });

  it("accepts bare domestic numbers (no plus) after normalisation", () => {
    const result = validateInstitutionRegistration(
      validRaw({ contactPhone: "0803-123-4567" }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.contactPhone, "08031234567");
  });
});

// --- Required fields fail closed ---------------------------------------------

describe("validateInstitutionRegistration (required fields)", () => {
  it("reports every required field when nothing was submitted", () => {
    const result = validateInstitutionRegistration({});
    assert.equal(result.ok, false);
    if (result.ok) return;

    for (const field of [
      "name",
      "type",
      "country",
      "state",
      "city",
      "address",
      "contactPerson",
      "contactEmail",
      "contactPhone",
    ] as const) {
      assert.ok(result.errors[field], `missing error for ${field}`);
    }
    // Optionals are NOT errors when absent.
    assert.equal(result.errors.shortName, undefined);
    assert.equal(result.errors.description, undefined);
  });

  it("treats non-string values (numbers, null, arrays) as missing", () => {
    const result = validateInstitutionRegistration({
      name: 42,
      type: null,
      contactEmail: ["a@b.co", "c@d.ef"],
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.name);
    assert.ok(result.errors.type);
    assert.ok(result.errors.contactEmail);
  });

  it("refuses an unknown type instead of guessing a default", () => {
    const result = validateInstitutionRegistration(
      validRaw({ type: "kindergarten" }),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.type);
  });

  it("echoes the trimmed submitted values for re-render", () => {
    const result = validateInstitutionRegistration(
      validRaw({ name: "  Stolen Name  ", city: "  " }),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.values.name, "Stolen Name");
    assert.equal(result.values.city, "");
    assert.ok(result.errors.city);
  });
});

// --- Bounds mirror migration 0015 --------------------------------------------

describe("validateInstitutionRegistration (length bounds)", () => {
  it("refuses a name over the schema bound and accepts the bound", () => {
    const max = INSTITUTION_REGISTRATION_LIMITS.name;
    assert.equal(max, 160); // mirrored from 0001's CHECK
    assert.equal(
      validateInstitutionRegistration(validRaw({ name: "n".repeat(max) })).ok,
      true,
    );
    const tooLong = validateInstitutionRegistration(
      validRaw({ name: "n".repeat(max + 1) }),
    );
    assert.equal(tooLong.ok, false);
  });

  it("refuses over-long optionals and location/contact fields", () => {
    const limits = INSTITUTION_REGISTRATION_LIMITS;
    const cases: Array<[string, number]> = [
      ["shortName", limits.shortName],
      ["description", limits.description],
      ["country", limits.country],
      ["state", limits.state],
      ["city", limits.city],
      ["address", limits.address],
      ["contactPerson", limits.contactPerson],
    ];
    for (const [field, max] of cases) {
      const result = validateInstitutionRegistration(
        validRaw({ [field]: "x".repeat(max + 1) }),
      );
      assert.equal(result.ok, false, `${field} at ${max + 1} accepted`);
      if (result.ok) continue;
      assert.ok(result.errors[field as keyof typeof result.errors]);
    }
  });
});

// --- Email & phone ------------------------------------------------------------

describe("validateInstitutionRegistration (contact formats)", () => {
  it("refuses malformed emails", () => {
    for (const bad of ["", "plain", "a@b", "a b@c.de", "@x.co", "a@b@c.co"]) {
      const result = validateInstitutionRegistration(
        validRaw({ contactEmail: bad }),
      );
      assert.equal(result.ok, false, `accepted "${bad}"`);
    }
  });

  it("accepts ordinary addresses", () => {
    for (const good of ["admin@school.edu.ng", "a.b+c@x.co"]) {
      const result = validateInstitutionRegistration(
        validRaw({ contactEmail: good }),
      );
      assert.equal(result.ok, true, `refused "${good}"`);
    }
  });

  it("normalizeContactPhone strips separators, keeps +, refuses junk", () => {
    assert.equal(normalizeContactPhone("+234 803 123 4567"), "+2348031234567");
    assert.equal(normalizeContactPhone("(0803) 123.4567"), "08031234567");
    assert.equal(normalizeContactPhone("08031234567"), "08031234567");
    assert.equal(normalizeContactPhone("call me"), null);
    assert.equal(normalizeContactPhone("1234567"), null); // 7 digits: too short
    assert.equal(normalizeContactPhone("1".repeat(16)), null); // too long
    assert.equal(normalizeContactPhone("+234803123456+7"), null);
  });

  it("refuses phones that do not normalise", () => {
    for (const bad of ["not-a-phone", "12345", "+", "080-ABC-1234"]) {
      const result = validateInstitutionRegistration(
        validRaw({ contactPhone: bad }),
      );
      assert.equal(result.ok, false, `accepted "${bad}"`);
    }
  });
});

// --- Duplicate key -------------------------------------------------------------

describe("normalizeInstitutionNameKey (index parity)", () => {
  it("matches the DB index expression lower(btrim(name))", () => {
    assert.equal(
      normalizeInstitutionNameKey("  PrepGrade Academy "),
      "prepgrade academy",
    );
    // Case-insensitive equality is what the unique index enforces.
    assert.equal(
      normalizeInstitutionNameKey("Greenfield Tutorial Centre"),
      normalizeInstitutionNameKey("greenfield tutorial centre"),
    );
    // Internal whitespace is NOT collapsed — documented on both sides.
    assert.notEqual(
      normalizeInstitutionNameKey("A  B"),
      normalizeInstitutionNameKey("A B"),
    );
  });
});

// --- Audit catalog -------------------------------------------------------------

describe("institution.created audit action", () => {
  it("is a recognised catalog member with a label", () => {
    assert.equal(isPlatformAuditAction("institution.created"), true);
    assert.equal(
      platformAuditActionLabel("institution.created"),
      "Registered a new institution",
    );
  });

  it("normalises a success event into a row with a bounded summary", () => {
    const entry = buildAuditEntry({
      actorId: "user_ops_1",
      actorRole: "SUPER_ADMIN",
      action: "institution.created",
      targetType: "institution",
      targetId: "0f9d2a3e-0000-4000-8000-aaaaaaaaaaaa",
      outcome: "success",
      detail: "registered as School",
    });
    assert.ok(entry);
    assert.equal(entry!.action, "institution.created");
    assert.equal(entry!.outcome, "success");
    assert.equal(entry!.actor_role, "SUPER_ADMIN");
    assert.deepEqual(entry!.detail, { summary: "registered as School" });
  });

  it("records a denied anonymous attempt with the unknown actor", () => {
    const entry = buildAuditEntry({
      actorId: null,
      actorRole: null,
      action: "institution.created",
      targetType: "institution",
      targetId: null,
      outcome: "denied",
      detail: "attempted institution registration",
    });
    assert.ok(entry);
    assert.equal(entry!.actor_id, "unknown");
    assert.equal(entry!.actor_role, "unknown");
    assert.equal(entry!.outcome, "denied");
  });
});
