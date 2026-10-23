/**
 * Institution navigation tests — run with `npm test` (Node's built-in runner).
 *
 * Asserts the ROUTE-OWNERSHIP contract for the Institution Admin workspace:
 * every visible sidebar destination resolves to an institution-owned
 * `/institution/*` route (never the teaching workspace), the shared deep
 * lifecycle stays reachable but the sidebar and its landing/create actions
 * never point into `/teacher/*`, and the role guard admits INSTITUTION_ADMIN
 * while refusing a teacher. These are the exact data the sidebar renders, so a
 * routing regression fails here rather than in the browser.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  INSTITUTION_EXAMS_PATH,
  INSTITUTION_EXAMS_NEW_PATH,
  INSTITUTION_QUESTION_BANK_PATH,
  INSTITUTION_QUESTION_NEW_PATH,
  INSTITUTION_SETTINGS_PATH,
  INSTITUTION_EXAM_PREP_CATEGORIES,
  INSTITUTION_EXAM_PREP_NAV,
  examPrepPath,
  INSTITUTION_MAIN_NAV,
  findMainNavItem,
  isNavItemActive,
} from "../../lib/navigation/institution-nav.ts";
import { decideAccess } from "../../lib/auth/access.ts";
import { readTrustedPrincipal } from "../../lib/auth/principal.ts";

describe("institution sidebar destinations (route ownership)", () => {
  it("sends Exams to the institution exam-management route", () => {
    const exams = findMainNavItem("Exams");
    assert.ok(exams, "Exams nav item exists");
    assert.equal(exams.href, "/institution/exams");
    assert.equal(INSTITUTION_EXAMS_PATH, "/institution/exams");
  });

  it("creates exams on an institution-owned route, not the teaching workspace", () => {
    assert.equal(INSTITUTION_EXAMS_NEW_PATH, "/institution/exams/new");
    assert.ok(INSTITUTION_EXAMS_NEW_PATH.startsWith("/institution/"));
  });

  it("routes Question Bank to the institution-owned bank (no teacher shell)", () => {
    assert.equal(findMainNavItem("Question Bank")?.href, "/institution/question-bank");
    assert.equal(INSTITUTION_QUESTION_BANK_PATH, "/institution/question-bank");
    assert.notEqual(findMainNavItem("Question Bank")?.href, "/teacher/questions");
  });

  it("creates questions on an institution-owned route", () => {
    assert.equal(INSTITUTION_QUESTION_NEW_PATH, "/institution/question-bank/new");
    assert.ok(INSTITUTION_QUESTION_NEW_PATH.startsWith("/institution/"));
  });

  it("routes Settings to the real institution settings page", () => {
    assert.equal(findMainNavItem("Settings")?.href, "/institution/settings");
    assert.equal(INSTITUTION_SETTINGS_PATH, "/institution/settings");
  });

  it("keeps every tenant page inside /institution", () => {
    const tenantLabels = [
      "Students",
      "Teachers",
      "Classes",
      "Subjects",
      "Results & Analytics",
    ];
    for (const label of tenantLabels) {
      const item = findMainNavItem(label);
      assert.ok(item, `${label} nav item exists`);
      assert.ok(item.href?.startsWith("/institution/"), `${label} is institution-scoped`);
    }
  });

  it("routes Dashboard to the institution workspace home", () => {
    assert.equal(findMainNavItem("Dashboard")?.href, "/institution");
  });

  it("never points a visible main-nav item into the teaching workspace", () => {
    // The reported bug class: an enabled Institution link resolving to a
    // teacher-only route and rendering the teaching shell. No sidebar item may
    // point at /teacher, and none may be a null (missing) destination.
    for (const item of INSTITUTION_MAIN_NAV) {
      assert.notEqual(item.href, null, `${item.label} must be a real destination`);
      assert.ok(
        !item.href?.startsWith("/teacher"),
        `${item.label} must not resolve into the teaching workspace`,
      );
      assert.ok(
        item.href === "/institution" || item.href?.startsWith("/institution/"),
        `${item.label} must stay within /institution`,
      );
    }
  });

  it("points every exam-preparation category at its own institution route", () => {
    assert.deepEqual(
      [...INSTITUTION_EXAM_PREP_CATEGORIES],
      ["JAMB", "WAEC", "NECO"],
    );
    assert.equal(INSTITUTION_EXAM_PREP_NAV.length, 3);
    for (const item of INSTITUTION_EXAM_PREP_NAV) {
      assert.notEqual(item.href, null, `${item.label} is a real destination`);
      assert.ok(!item.href?.startsWith("/teacher"), `${item.label} stays institution-owned`);
      assert.equal(item.href, examPrepPath(item.label as (typeof INSTITUTION_EXAM_PREP_CATEGORIES)[number]));
    }
    assert.equal(examPrepPath("JAMB"), "/institution/jamb");
    assert.equal(examPrepPath("WAEC"), "/institution/waec");
    assert.equal(examPrepPath("NECO"), "/institution/neco");
  });

  it("asserts the full main-nav surface stays within tested routes", () => {
    // Guard against silent drift: every destination is one of the routes above,
    // in order, all institution-owned.
    const destinations = INSTITUTION_MAIN_NAV.map((item) => item.href);
    assert.deepEqual(destinations, [
      "/institution",
      "/institution/exams",
      "/institution/question-bank",
      "/institution/students",
      "/institution/teachers",
      "/institution/classes",
      "/institution/subjects",
      "/institution/analytics",
      "/institution/settings",
    ]);
  });
});

describe("isNavItemActive", () => {
  it("marks Dashboard active only on the exact route", () => {
    const dashboard = findMainNavItem("Dashboard")!;
    assert.equal(isNavItemActive("/institution", dashboard), true);
    assert.equal(isNavItemActive("/institution/exams", dashboard), false);
    assert.equal(isNavItemActive("/institution/students", dashboard), false);
  });

  it("marks Exams active on its route and its children", () => {
    const exams = findMainNavItem("Exams")!;
    assert.equal(isNavItemActive("/institution/exams", exams), true);
    assert.equal(isNavItemActive("/institution/exams/abc-123", exams), true);
  });

  it("does not treat a sibling string prefix as a child route", () => {
    const exams = findMainNavItem("Exams")!;
    assert.equal(isNavItemActive("/institution/exams-archive", exams), false);
  });

  it("marks the institution Question Bank on its own children only", () => {
    const bank = findMainNavItem("Question Bank")!;
    assert.equal(isNavItemActive("/institution/question-bank", bank), true);
    assert.equal(isNavItemActive("/institution/question-bank/new", bank), true);
    assert.equal(isNavItemActive("/teacher/questions", bank), false);
  });

  it("marks Settings active on the settings route and children", () => {
    const settings = findMainNavItem("Settings")!;
    assert.equal(isNavItemActive("/institution/settings", settings), true);
    assert.equal(isNavItemActive("/institution", settings), false);
  });

  it("activates exam-prep only on its exact category route", () => {
    for (const item of INSTITUTION_EXAM_PREP_NAV) {
      assert.equal(isNavItemActive(item.href!, item), true);
      assert.equal(isNavItemActive("/institution", item), false);
      assert.equal(isNavItemActive(`${item.href}/extra`, item), false);
    }
  });
});

describe("institution route guard rule (decideAccess)", () => {
  // Institution-owned routes (exams, question-bank, settings, jamb/…) run:
  // requireRole(["INSTITUTION_ADMIN"]).
  const requirement = { roles: ["INSTITUTION_ADMIN"] as const };

  function principalFor(metadata: Record<string, unknown>) {
    return {
      session: "active" as const,
      principal: readTrustedPrincipal({ userId: "user_test", privateMetadata: metadata }),
    };
  }

  it("admits an institution admin — no bounce to any other dashboard", () => {
    const decision = decideAccess(
      principalFor({ role: "INSTITUTION_ADMIN", institutionId: "inst-a" }),
      requirement,
    );
    assert.equal(decision.allowed, true);
    if (decision.allowed) {
      assert.equal(decision.principal.institutionId, "inst-a");
    }
  });

  it("denies a teacher who tries to open an institution-only route", () => {
    const decision = decideAccess(
      principalFor({ role: "TEACHER", institutionId: "inst-a" }),
      requirement,
    );
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.reason, "roleNotAllowed");
  });

  it("denies a student", () => {
    const decision = decideAccess(
      principalFor({ role: "STUDENT", institutionId: "inst-a" }),
      requirement,
    );
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.reason, "roleNotAllowed");
  });

  it("denies an unassigned account with no membership", () => {
    const decision = decideAccess(principalFor({}), requirement);
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.reason, "noMembership");
  });

  it("ignores client-writable metadata when resolving the admin tenant", () => {
    // readTrustedPrincipal only ever receives privateMetadata; a public
    // institutionId never reaches the trusted shape (AGENTS.md §5).
    const principal = readTrustedPrincipal({
      userId: "user_test",
      privateMetadata: { role: "STUDENT", institutionId: "inst-a" },
    });
    assert.equal(principal?.role, "STUDENT");
    const decision = decideAccess({ session: "active", principal }, requirement);
    assert.equal(decision.allowed, false);
  });
});
