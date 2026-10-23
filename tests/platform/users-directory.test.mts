/**
 * Platform users directory tests — Super Admin "Users" section.
 *
 * Pure modules only (lib/platform-users.ts), same Node built-in runner as
 * the rest of the suite — no Supabase, no Next. These pin the rules the
 * directory depends on:
 *   - the scope catalog and its fail-closed guard (never a guessed scope),
 *   - the untrusted-searchParams resolver (clamps/drops junk, clears an
 *     impossible institution filter on the unassigned tab),
 *   - the URL builder that keeps filters linkable,
 *   - the search sanitiser and the multi-column `or` clause builder,
 *   - embed normalisation: PostgREST shapes (object/array/null) never leak
 *     undefined into the row model, and unknown roles are dropped.
 *
 * The SUPER_ADMIN gate that guards the whole area is covered by
 * tests/platform/super-admin-access.test.mts; the live reads run against the
 * real tables the migrations create (no new schema here).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  USER_DIRECTORY_SCOPES,
  USER_DIRECTORY_PAGE_SIZE,
  USER_SEARCH_PROFILE_CAP,
  displayNameOr,
  isUserDirectoryScope,
  isValidInstitutionId,
  membershipStatusLabel,
  normalizeMembershipRows,
  normalizeProfileRows,
  normalizeRosterRows,
  resolveUserDirectoryQuery,
  rosterStatusLabel,
  statusBadgeTone,
  toUserContainsPattern,
  toUserSearchOrClause,
  userDirectoryHref,
  type RawMembershipRow,
  type RawProfileRow,
  type RawRosterRow,
} from "../../lib/platform-users.ts";

// --- Scope catalog -----------------------------------------------------------

describe("user directory scope catalog", () => {
  it("holds exactly the four honest scopes", () => {
    assert.deepEqual([...USER_DIRECTORY_SCOPES], [
      "accounts",
      "unassigned",
      "students",
      "teachers",
    ]);
  });

  it("guards scope strings fail-closed", () => {
    for (const scope of USER_DIRECTORY_SCOPES) {
      assert.equal(isUserDirectoryScope(scope), true, scope);
    }
    for (const value of ["Accounts", "all", "", null, undefined, 42]) {
      assert.equal(isUserDirectoryScope(value), false, String(value));
    }
  });
});

// --- Institution id validation ------------------------------------------------

describe("institution id guard", () => {
  it("accepts only well-formed UUIDs", () => {
    assert.equal(
      isValidInstitutionId("3f2504e0-4f89-11d3-9a0c-0305e82c3301"),
      true,
    );
    for (const value of [
      "drop table",
      "3f2504e0-4f89-11d3-9a0c-0305e82c330",
      "abc",
      "",
      null,
      undefined,
    ]) {
      assert.equal(isValidInstitutionId(value), false, String(value));
    }
  });
});

// --- Untrusted searchParams resolver -------------------------------------------

describe("resolveUserDirectoryQuery", () => {
  it("defaults to the accounts scope and page 1", () => {
    const query = resolveUserDirectoryQuery({});
    assert.equal(query.scope, "accounts");
    assert.equal(query.page, 1);
    assert.equal(query.pageSize, USER_DIRECTORY_PAGE_SIZE);
    assert.equal(query.q, "");
    assert.equal(query.role, null);
    assert.equal(query.institutionId, null);
  });

  it("drops unknown scopes to the default rather than guessing", () => {
    const query = resolveUserDirectoryQuery({ scope: "billing" });
    assert.equal(query.scope, "accounts");
  });

  it("uppercases a known role and drops an unknown one", () => {
    assert.equal(
      resolveUserDirectoryQuery({ role: "teacher" }).role,
      "TEACHER",
    );
    assert.equal(resolveUserDirectoryQuery({ role: "owner" }).role, null);
  });

  it("keeps only UUID-shaped institution filters", () => {
    const uuid = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    assert.equal(
      resolveUserDirectoryQuery({ institution: uuid }).institutionId,
      uuid,
    );
    assert.equal(
      resolveUserDirectoryQuery({ institution: "1 OR 1=1" }).institutionId,
      null,
    );
  });

  it("clears the institution filter on the unassigned scope", () => {
    // Unassigned accounts have no tenant by definition — keeping the filter
    // would silently promise an empty tab.
    const uuid = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    const query = resolveUserDirectoryQuery({
      scope: "unassigned",
      institution: uuid,
    });
    assert.equal(query.institutionId, null);
  });

  it("clamps junk pages to 1 and caps the search length", () => {
    assert.equal(resolveUserDirectoryQuery({ page: "0" }).page, 1);
    assert.equal(resolveUserDirectoryQuery({ page: "-4" }).page, 1);
    assert.equal(resolveUserDirectoryQuery({ page: "abc" }).page, 1);
    assert.equal(resolveUserDirectoryQuery({ page: "3" }).page, 3);
    const long = "a".repeat(400);
    assert.equal(resolveUserDirectoryQuery({ q: long }).q.length, 120);
  });

  it("takes the first value of array params", () => {
    const query = resolveUserDirectoryQuery({ q: ["first", "second"] });
    assert.equal(query.q, "first");
  });
});

// --- Href builder ---------------------------------------------------------------

describe("userDirectoryHref", () => {
  const base = "/platform/users";
  const query = resolveUserDirectoryQuery({});

  it("keeps the default view a clean path", () => {
    assert.equal(userDirectoryHref(base, query, { scope: "accounts" }), base);
  });

  it("carries filters and switches scopes without leaking stale params", () => {
    const filtered = resolveUserDirectoryQuery({
      q: "ada",
      role: "TEACHER",
      institution: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    });
    const href = userDirectoryHref(base, filtered, { scope: "students", page: 2 });
    const params = new URL(href, "http://localhost").searchParams;
    assert.equal(params.get("scope"), "students");
    assert.equal(params.get("q"), "ada");
    assert.equal(params.get("institution"), filtered.institutionId);
    assert.equal(params.get("page"), "2");
    // The role filter only exists on the accounts scope.
    assert.equal(params.get("role"), null);
  });

  it("omits page 1 from the URL", () => {
    const href = userDirectoryHref(base, query, { scope: "teachers", page: 1 });
    assert.equal(href.includes("page"), false);
  });
});

// --- Search sanitiser -------------------------------------------------------------

describe("search pattern builders", () => {
  it("strips filter-syntax characters and wraps a contains-pattern", () => {
    assert.equal(toUserContainsPattern("ada lovelace"), "%ada lovelace%");
    assert.equal(toUserContainsPattern("20% (*)a,b"), "%20 ab%");
    assert.equal(toUserContainsPattern("   "), "");
    assert.equal(toUserContainsPattern("%*,"), "");
  });

  it("builds one or() clause per column, or null for no filter", () => {
    const clause = toUserSearchOrClause("ada", ["full_name", "email"]);
    assert.equal(clause, "full_name.ilike.%ada%,email.ilike.%ada%");
    assert.equal(toUserSearchOrClause("", ["full_name"]), null);
    assert.equal(toUserSearchOrClause("**", ["full_name"]), null);
  });

  it("pins the helper-search cap so truncation stays reportable", () => {
    assert.equal(USER_SEARCH_PROFILE_CAP, 400);
  });
});

// --- Embed normalisation (pure, defensive) ------------------------------------------

describe("normalizeMembershipRows", () => {
  const base = {
    institution_id: "inst-1",
    user_id: "user-1",
    status: "active",
  };

  it("reads object embeds", () => {
    const rows: RawMembershipRow[] = [
      {
        ...base,
        id: "m1",
        role: "TEACHER",
        institution: { name: "Greenfield College" },
        profile: { full_name: "Ada Okafor", email: "ada@example.com" },
      },
    ];
    const [row] = normalizeMembershipRows(rows);
    assert.equal(row.role, "TEACHER");
    assert.equal(row.institutionName, "Greenfield College");
    assert.equal(row.fullName, "Ada Okafor");
    assert.equal(row.key, "accounts:m1");
    assert.equal(row.className, null);
  });

  it("reads array embeds (to-one drift) without crashing", () => {
    const rows: RawMembershipRow[] = [
      {
        ...base,
        id: "m2",
        role: "STUDENT",
        institution: [{ name: "Tutorial Hub" }],
        profile: [{ full_name: "Ben Code" }],
      },
    ];
    const [row] = normalizeMembershipRows(rows);
    assert.equal(row.institutionName, "Tutorial Hub");
    assert.equal(row.fullName, "Ben Code");
    assert.equal(row.email, null);
  });

  it("survives null embeds — never undefined, never a guessed name", () => {
    const rows: RawMembershipRow[] = [
      { ...base, id: "m3", role: "INSTITUTION_ADMIN", institution: null, profile: null },
    ];
    const [row] = normalizeMembershipRows(rows);
    assert.equal(row.institutionName, null);
    assert.equal(row.fullName, null);
    assert.equal(displayNameOr(row), "Name not recorded");
  });

  it("drops rows whose role is outside the catalog (fail-closed)", () => {
    const rows: RawMembershipRow[] = [
      { ...base, id: "m4", role: "SUPERUSER", institution: null, profile: null },
    ];
    assert.deepEqual(normalizeMembershipRows(rows), []);
  });
});

describe("normalizeProfileRows", () => {
  it("derives the account status from is_active only", () => {
    const rows: RawProfileRow[] = [
      { id: "p1", email: "a@b.c", full_name: "A", is_active: true, created_at: "2026-01-01" },
      { id: "p2", email: null, full_name: null, is_active: false, created_at: "2026-01-02" },
    ];
    const [active, inactive] = normalizeProfileRows(rows);
    assert.equal(active.status, "active");
    assert.equal(inactive.status, "inactive");
    assert.equal(inactive.createdAt, "2026-01-02");
    assert.equal(displayNameOr(inactive), "Name not recorded");
    assert.equal(inactive.key, "unassigned:p2");
  });

  it("falls back to the email for display when the name is missing", () => {
    const rows: RawProfileRow[] = [
      { id: "p3", email: "only@email.test", full_name: "  ", is_active: true, created_at: "x" },
    ];
    assert.equal(displayNameOr(normalizeProfileRows(rows)[0]), "only@email.test");
  });
});

describe("normalizeRosterRows", () => {
  it("maps student codes and class embeds", () => {
    const rows: RawRosterRow[] = [
      {
        id: "s1",
        institution_id: "inst-1",
        student_code: "ST-001",
        full_name: "Chidi B",
        status: "active",
        created_at: "2026-02-01",
        institution: { name: "Greenfield College" },
        class: { name: "SS2A" },
      },
    ];
    const [row] = normalizeRosterRows(rows, "STUDENT");
    assert.equal(row.code, "ST-001");
    assert.equal(row.className, "SS2A");
    assert.equal(row.role, "STUDENT");
    assert.equal(row.key, "student:s1");
    assert.equal(row.createdAt, "2026-02-01");
  });

  it("maps teacher codes and keeps the invited status honest", () => {
    const rows: RawRosterRow[] = [
      {
        id: "t1",
        institution_id: "inst-1",
        employee_code: "TC-9",
        full_name: "Tola A",
        email: "tola@example.com",
        status: "invited",
        institution: null,
      },
    ];
    const [row] = normalizeRosterRows(rows, "TEACHER");
    assert.equal(row.code, "TC-9");
    assert.equal(row.email, "tola@example.com");
    assert.equal(row.institutionName, null);
    assert.equal(rosterStatusLabel(row.status), "Invited");
  });
});

// --- Display helpers ---------------------------------------------------------------

describe("status labels and tones", () => {
  it("labels membership statuses and neutralises unknown ones", () => {
    assert.equal(membershipStatusLabel("active"), "Active");
    assert.equal(membershipStatusLabel("inactive"), "Inactive");
    assert.equal(membershipStatusLabel("weird"), "—");
    assert.equal(membershipStatusLabel(null), "—");
  });

  it("never renders a badge tone for a status it cannot name", () => {
    assert.equal(statusBadgeTone("active"), "success");
    assert.equal(statusBadgeTone("invited"), "warning");
    assert.equal(statusBadgeTone("inactive"), "warning");
    assert.equal(statusBadgeTone(null), "neutral");
  });
});
