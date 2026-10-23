/**
 * Institution profile-update tests — Settings › General self-service edit.
 *
 * Pure module only (lib/institutions.ts), same Node built-in runner as the rest
 * of the suite — no Supabase, no Next. These pin the input contract the
 * INSTITUTION_ADMIN server action depends on:
 *   - only the name is required (it is NOT NULL in the schema), everything else
 *     is optional and a blank stays null (never coerced to an empty string),
 *   - length bounds mirror the migration 0015 CHECK constraints,
 *   - an optional institution type is refused unless it is a known vocabulary,
 *   - a supplied email/phone is validated and normalised the same way the
 *     registration flow does,
 *   - all field errors are collected in one pass.
 *
 * The database half (column CHECKs, the unique name index that surfaces as a
 * duplicate-name refusal) is covered by supabase/tests; the INSTITUTION_ADMIN
 * gate by tests/navigation/institution-nav.test.mts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  INSTITUTION_REGISTRATION_LIMITS,
  validateInstitutionProfileUpdate,
} from "../../lib/institutions.ts";

describe("validateInstitutionProfileUpdate", () => {
  it("accepts a name-only change and nulls every empty optional", () => {
    const result = validateInstitutionProfileUpdate({ name: "  Bright Stars Academy  " });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.name, "Bright Stars Academy");
      assert.equal(result.value.type, null);
      assert.equal(result.value.shortName, null);
      assert.equal(result.value.description, null);
      assert.equal(result.value.country, null);
      assert.equal(result.value.contactEmail, null);
      assert.equal(result.value.contactPhone, null);
    }
  });

  it("rejects a blank or whitespace name (fail-closed, never defaulted)", () => {
    const result = validateInstitutionProfileUpdate({ name: "   " });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.name);
  });

  it("bounds the name to the schema limit", () => {
    const tooLong = "x".repeat(INSTITUTION_REGISTRATION_LIMITS.name + 1);
    const result = validateInstitutionProfileUpdate({ name: tooLong });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.name);
  });

  it("accepts a known institution type and maps it through", () => {
    const result = validateInstitutionProfileUpdate({ name: "A School", type: "tutorial_centre" });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.type, "tutorial_centre");
  });

  it("refuses an unknown institution type rather than guessing", () => {
    const result = validateInstitutionProfileUpdate({ name: "A School", type: "university" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.type);
  });

  it("keeps an empty type as null (optional field, legacy rows)", () => {
    const result = validateInstitutionProfileUpdate({ name: "A School", type: "" });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.type, null);
  });

  it("lower-cases a supplied contact email when well-formed", () => {
    const result = validateInstitutionProfileUpdate({
      name: "A School",
      contactEmail: "Admin@School.EDU.NG",
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.contactEmail, "admin@school.edu.ng");
  });

  it("refuses a malformed contact email", () => {
    const result = validateInstitutionProfileUpdate({ name: "A School", contactEmail: "not-an-email" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.contactEmail);
  });

  it("normalises a supplied contact phone", () => {
    const result = validateInstitutionProfileUpdate({
      name: "A School",
      contactPhone: "(0803) 123-4567",
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.contactPhone, "08031234567");
  });

  it("refuses a phone with letters", () => {
    const result = validateInstitutionProfileUpdate({ name: "A School", contactPhone: "call me" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.contactPhone);
  });

  it("bounds an optional description to the schema limit", () => {
    const tooLong = "d".repeat(INSTITUTION_REGISTRATION_LIMITS.description + 1);
    const result = validateInstitutionProfileUpdate({ name: "A School", description: tooLong });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.description);
  });

  it("collects every field error in one pass and echoes trimmed values", () => {
    const result = validateInstitutionProfileUpdate({
      name: "",
      type: "nope",
      contactEmail: "bad",
      contactPhone: "abc",
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.name);
      assert.ok(result.errors.type);
      assert.ok(result.errors.contactEmail);
      assert.ok(result.errors.contactPhone);
      assert.equal(result.values.contactEmail, "bad");
    }
  });

  it("normalises a complete profile into the data-layer payload shape", () => {
    const result = validateInstitutionProfileUpdate({
      name: "Greenfield College",
      type: "school",
      shortName: "GC",
      description: "A secondary school.",
      country: "Nigeria",
      state: "Lagos",
      city: "Ikeja",
      address: "12 Example Road",
      contactPerson: "Jane Doe",
      contactEmail: "principal@greenfield.edu.ng",
      contactPhone: "+234 803 123 4567",
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.value, {
        name: "Greenfield College",
        type: "school",
        shortName: "GC",
        description: "A secondary school.",
        country: "Nigeria",
        state: "Lagos",
        city: "Ikeja",
        address: "12 Example Road",
        contactPerson: "Jane Doe",
        contactEmail: "principal@greenfield.edu.ng",
        contactPhone: "+2348031234567",
      });
    }
  });
});
