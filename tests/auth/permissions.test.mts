/**
 * Permission catalog tests — the explicit role definitions prompt 09 asks for,
 * plus the least-privilege invariants that keep the catalog from widening by
 * accident. Pure module, same runner as the rest of `tests/auth`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PERMISSIONS,
  PERMISSION_LABELS,
  RESOURCE_OPERATIONS,
  ROLE_PERMISSIONS,
  hasPermission,
  isPermission,
  isResourceOperation,
  permissionsForRole,
} from "../../lib/auth/permissions.ts";
import { USER_ROLES } from "../../lib/auth/roles.ts";

describe("permission catalog guards", () => {
  it("accepts every declared permission and rejects everything else", () => {
    for (const permission of PERMISSIONS) {
      assert.equal(isPermission(permission), true, permission);
    }

    // Values a hostile client could try to smuggle through a payload.
    for (const value of [
      undefined,
      null,
      "",
      "admin",
      "SUPER_ADMIN",
      "member.delete_everything",
      42,
      ["member.manage"],
    ]) {
      assert.equal(isPermission(value), false, String(value));
    }
  });

  it("recognises only the three declared operations", () => {
    for (const operation of RESOURCE_OPERATIONS) {
      assert.equal(isResourceOperation(operation), true, operation);
    }
    for (const value of ["write", "DROP TABLE", "read ", undefined]) {
      assert.equal(isResourceOperation(value), false, String(value));
    }
  });

  it("labels every permission, so denial copy can name the real capability", () => {
    for (const permission of PERMISSIONS) {
      assert.ok(PERMISSION_LABELS[permission].length > 0, permission);
    }
  });
});

describe("role → permission matrix", () => {
  it("defines an explicit set for each of the four roles", () => {
    for (const role of USER_ROLES) {
      const granted = ROLE_PERMISSIONS[role];
      assert.ok(granted instanceof Set, `${role} has a permission set`);
      for (const permission of granted) {
        assert.ok(isPermission(permission), `${role}/${permission} is catalogued`);
      }
    }
  });

  it("gives students only own-scope read permissions", () => {
    // AGENTS.md §5: students see only their own assigned exams, attempts, and
    // results — the catalog must not hand them any manage/answer-key capability.
    assert.deepEqual(permissionsForRole("STUDENT"), [
      "result.read_own",
      "analytics.read_own",
    ]);
    assert.equal(hasPermission("STUDENT", "question.manage"), false);
    assert.equal(hasPermission("STUDENT", "question.read_answer_key"), false);
    assert.equal(hasPermission("STUDENT", "exam.manage"), false);
    assert.equal(hasPermission("STUDENT", "member.manage"), false);
  });

  it("gives teachers teaching permissions but no member or delete-level rights", () => {
    assert.equal(hasPermission("TEACHER", "question.manage"), true);
    assert.equal(hasPermission("TEACHER", "exam.publish"), true);
    assert.equal(hasPermission("TEACHER", "result.read_class"), true);
    assert.equal(hasPermission("TEACHER", "member.manage"), false);
    assert.equal(hasPermission("TEACHER", "class.manage"), false);
    assert.equal(hasPermission("TEACHER", "analytics.read_institution"), false);
  });

  it("gives institution admins the full tenant surface except platform rights", () => {
    assert.equal(hasPermission("INSTITUTION_ADMIN", "member.manage"), true);
    assert.equal(hasPermission("INSTITUTION_ADMIN", "class.manage"), true);
    assert.equal(hasPermission("INSTITUTION_ADMIN", "analytics.read_institution"), true);
    assert.equal(hasPermission("INSTITUTION_ADMIN", "platform.audit"), false);
  });

  it("holds SUPER_ADMIN to exactly one platform permission — least privilege", () => {
    // AGENTS.md §5: super-admin operations are limited and auditable. If this
    // ever lists a tenant permission, silent admin-by-inheritance has begun.
    assert.deepEqual(permissionsForRole("SUPER_ADMIN"), ["platform.audit"]);
  });

  it("grants nothing to an unresolved role", () => {
    assert.equal(hasPermission(null, "result.read_own"), false);
    assert.deepEqual(permissionsForRole(null), []);
  });

  it("never overlaps student and staff manage capabilities", () => {
    // A STUDENT must not gain any permission that mutates shared tenant data.
    for (const permission of ROLE_PERMISSIONS.STUDENT) {
      assert.equal(
        permission.endsWith(".manage") || permission.includes("answer_key"),
        false,
        `STUDENT unexpectedly holds ${permission}`,
      );
    }
  });
});
