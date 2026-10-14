/**
 * Role model tests — run with `npm test` (Node's built-in test runner).
 *
 * These cover the authorization matrix itself: how a role value is normalised,
 * where each role is routed after login, and which application areas each role
 * may enter. Pure modules only, so the app's real rules are exercised rather
 * than a stand-in.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  APP_AREAS,
  ROLE_AREAS,
  ROLE_HOME_PATH,
  USER_ROLES,
  accessibleAreas,
  canAccessArea,
  isUserRole,
  normalizeUserRole,
  roleHomePath,
  roleLabel,
} from "../../lib/auth/roles.ts";

describe("normalizeUserRole", () => {
  it("accepts every declared role, in the canonical spelling", () => {
    for (const role of USER_ROLES) {
      assert.equal(normalizeUserRole(role), role);
    }
  });

  it("tolerates casing, padding, hyphens, and internal spaces", () => {
    assert.equal(normalizeUserRole(" teacher "), "TEACHER");
    assert.equal(normalizeUserRole("Institution-Admin"), "INSTITUTION_ADMIN");
    assert.equal(normalizeUserRole("super admin"), "SUPER_ADMIN");
    assert.equal(normalizeUserRole("student"), "STUDENT");
  });

  it("returns null instead of guessing a default for anything unknown", () => {
    for (const value of [
      undefined,
      null,
      "",
      "   ",
      "ADMIN",
      "root",
      "SUPERADMIN",
      42,
      { role: "TEACHER" },
      ["TEACHER"],
    ]) {
      assert.equal(normalizeUserRole(value), null, `for ${String(value)}`);
    }
  });

  it("isUserRole only recognises real roles", () => {
    assert.equal(isUserRole("TEACHER"), true);
    assert.equal(isUserRole("teacher"), false); // normalisation is explicit
    assert.equal(isUserRole("OWNER"), false);
  });
});

describe("role routing spine", () => {
  it("routes every declared role to a dashboard path", () => {
    for (const role of USER_ROLES) {
      assert.equal(typeof ROLE_HOME_PATH[role], "string");
      assert.match(ROLE_HOME_PATH[role], /^\//);
      assert.equal(roleHomePath(role), ROLE_HOME_PATH[role]);
    }
  });

  it("routes an unassigned role to /dashboard, where the no-membership state renders", () => {
    assert.equal(roleHomePath(null), "/dashboard");
  });

  it("routes SUPER_ADMIN to the platform dashboard (prompt 31), and no other role there", () => {
    assert.equal(ROLE_HOME_PATH.SUPER_ADMIN, "/platform");
    assert.equal(roleHomePath("SUPER_ADMIN"), "/platform");
    // The platform area is not a post-login destination for tenant roles.
    for (const role of ["INSTITUTION_ADMIN", "TEACHER", "STUDENT"] as const) {
      assert.notEqual(ROLE_HOME_PATH[role], "/platform");
    }
  });

  it("routes STUDENT to the student workspace (prompt 20), and no other role there", () => {
    assert.equal(ROLE_HOME_PATH.STUDENT, "/student");
    assert.equal(roleHomePath("STUDENT"), "/student");
    // /student is guarded to STUDENT only — other roles keep their own home.
    for (const role of ["SUPER_ADMIN", "INSTITUTION_ADMIN", "TEACHER"] as const) {
      assert.notEqual(ROLE_HOME_PATH[role], "/student");
    }
  });
});

describe("role/area authorization matrix", () => {
  it("grants each role exactly its declared areas", () => {
    assert.deepEqual([...ROLE_AREAS.STUDENT], ["student"]);
    assert.deepEqual([...ROLE_AREAS.TEACHER], ["teacher"]);
    assert.deepEqual([...ROLE_AREAS.INSTITUTION_ADMIN], [
      "institution",
      "teacher",
    ]);
    assert.deepEqual([...ROLE_AREAS.SUPER_ADMIN], ["platform"]);
  });

  it("does not let a school admin's role leak into the platform area", () => {
    assert.equal(canAccessArea("INSTITUTION_ADMIN", "platform"), false);
    assert.equal(canAccessArea("TEACHER", "institution"), false);
    assert.equal(canAccessArea("STUDENT", "institution"), false);
    assert.equal(canAccessArea("STUDENT", "teacher"), false);
  });

  it("keeps super admin out of tenant areas — platform rights are not tenant rights", () => {
    // AGENTS.md §5: super-admin actions must be limited and auditable, so the
    // platform role never inherits institution/teacher/student surfaces.
    assert.equal(canAccessArea("SUPER_ADMIN", "institution"), false);
    assert.equal(canAccessArea("SUPER_ADMIN", "teacher"), false);
    assert.equal(canAccessArea("SUPER_ADMIN", "student"), false);
  });

  it("denies every area for an unresolved role", () => {
    for (const area of APP_AREAS) {
      assert.equal(canAccessArea(null, area), false);
    }
    assert.deepEqual([...accessibleAreas(null)], []);
  });

  it("lists only areas the role actually holds", () => {
    assert.deepEqual([...accessibleAreas("INSTITUTION_ADMIN")], [
      "institution",
      "teacher",
    ]);
  });

  it("labels each role, and marks an unresolved one as unassigned", () => {
    assert.equal(roleLabel("INSTITUTION_ADMIN"), "Institution admin");
    assert.equal(roleLabel("SUPER_ADMIN"), "Super admin");
    assert.equal(roleLabel("TEACHER"), "Teacher");
    assert.equal(roleLabel("STUDENT"), "Student");
    assert.equal(roleLabel(null), "Unassigned");
  });
});
