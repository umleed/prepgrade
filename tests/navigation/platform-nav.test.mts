/**
 * Platform (super-admin) sidebar navigation tests — run with `npm test`
 * (Node's built-in runner).
 *
 * Asserts the SINGLE-OWNERSHIP contract for the platform shell: each enabled
 * destination is claimed by exactly one sidebar entry, `/platform/usage` is
 * reachable only through the top-level Analytics item, the active-state rules
 * pick exactly the entries a super admin should see highlighted, and planned
 * sections stay visibly unavailable (`href: null`, never linked).
 *
 * The regression this pins: "Usage & Activity" used to sit in the Institutions
 * submenu while "Analytics" pointed at the same `/platform/usage` route, so two
 * rows lit up on that page and the canonical home of platform analytics was
 * ambiguous.
 *
 * Same reason as institution-nav.test.mts: the nav data is pure and lives in
 * lib/navigation/, so the real contract the sidebar renders is what is tested —
 * no React and no new test framework needed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PLATFORM_INSTITUTIONS_PATH,
  PLATFORM_MAIN_NAV,
  PLATFORM_PLATFORM_NAV,
  PLATFORM_USAGE_PATH,
  defaultExpandedGroupLabel,
  findPlatformNavItem,
  isPlatformNavChildActive,
  isPlatformNavItemActive,
} from "../../lib/navigation/platform-nav.ts";

/** One rendered row: a top-level item or a submenu child, with its label path. */
type FlatEntry = {
  label: string;
  /** Label of the top-level row this entry belongs to (itself for parents). */
  group: string;
  /** False for a top-level row, true for a submenu child. */
  isChild: boolean;
  href: string | null;
  active: boolean;
};

/** Every row the sidebar can render for a pathname, in render order. */
function renderedEntries(pathname: string): FlatEntry[] {
  const entries: FlatEntry[] = [];
  for (const group of [...PLATFORM_MAIN_NAV, ...PLATFORM_PLATFORM_NAV]) {
    entries.push({
      label: group.label,
      group: group.label,
      isChild: false,
      href: group.href,
      active: isPlatformNavItemActive(pathname, group),
    });
    const children = group.children ?? [];
    for (const child of children) {
      entries.push({
        label: `${group.label} › ${child.label}`,
        group: group.label,
        isChild: true,
        href: child.href,
        active: isPlatformNavChildActive(pathname, children, child),
      });
    }
  }
  return entries;
}

function activeLabels(pathname: string): string[] {
  return renderedEntries(pathname)
    .filter((entry) => entry.active)
    .map((entry) => entry.label);
}

describe("platform sidebar destinations (single ownership)", () => {
  it("makes Analytics the canonical entry for the usage & activity surface", () => {
    const analytics = findPlatformNavItem("Analytics");
    assert.ok(analytics, "Analytics nav item exists");
    assert.equal(analytics.href, PLATFORM_USAGE_PATH);
    assert.equal(PLATFORM_USAGE_PATH, "/platform/usage");
  });

  it("no longer files Usage & Activity under the Institutions submenu", () => {
    const institutions = findPlatformNavItem("Institutions")!;
    assert.ok(institutions.children, "Institutions keeps its submenu");
    assert.ok(
      !institutions.children!.some((child) => child.href === PLATFORM_USAGE_PATH),
      "the duplicate /platform/usage submenu entry is gone",
    );
    assert.ok(
      !institutions.children!.some((child) => child.label === "Usage & Activity"),
      "no stale Usage & Activity row remains",
    );
  });

  it("claims no enabled destination twice anywhere in the sidebar", () => {
    // The reported bug class: two rows resolving to one route both highlight.
    // One shape is sanctioned and documented: a group's landing route may be
    // shared by the parent row and one of its own children (Institutions and
    // "All Institutions") — with the submenu open the parent renders a
    // disclosure button, not a second link. Two separate groups, or two
    // siblings, may never claim the same route.
    const owners = new Map<string, FlatEntry[]>();
    for (const entry of renderedEntries("/")) {
      if (entry.href === null) continue;
      owners.set(entry.href, [...(owners.get(entry.href) ?? []), entry]);
    }
    for (const [href, rows] of owners) {
      if (rows.length === 1) continue;
      const parents = rows.filter((row) => !row.isChild);
      assert.equal(parents.length, 1, `${href} is claimed by at most one group row`);
      assert.ok(
        rows.every((row) => row.group === parents[0].group),
        `${href} is claimed by more than one navigation group`,
      );
    }
    // /platform/usage has no such sanctioned sharing: exactly one row owns it.
    const usageOwners = owners.get(PLATFORM_USAGE_PATH) ?? [];
    assert.equal(usageOwners.length, 1, "/platform/usage is reached from one entry");
    assert.deepEqual(
      usageOwners.map((row) => row.label),
      ["Analytics"],
    );
  });

  it("keeps the Institutions submenu items, labels, and order intact", () => {
    assert.deepEqual(
      findPlatformNavItem("Institutions")!.children,
      [
        { label: "All Institutions", href: PLATFORM_INSTITUTIONS_PATH },
        { label: "Add Institution", href: "/platform/institutions/new" },
        { label: "Pending Approvals", href: "/platform/institutions/pending-approvals" },
        { label: "Subscription Plans", href: "/platform/subscription-plans" },
      ],
    );
  });

  it("pins the full enabled destination list against silent drift", () => {
    assert.deepEqual(
      renderedEntries("/").flatMap((entry) => (entry.href ? [entry.label] : [])),
      [
        "Dashboard",
        "Institutions",
        "Institutions › All Institutions",
        "Institutions › Add Institution",
        "Institutions › Pending Approvals",
        "Institutions › Subscription Plans",
        "Users",
        "Assessments",
        "Question Bank",
        "Analytics",
        "Moderation",
        "System Health",
        "Settings",
        "Audit Logs",
      ],
    );
  });

  it("keeps every planned section unavailable rather than inventing a route", () => {
    const disabled = [
      "Billing & Subscriptions",
      "Plans & Features",
      "Payment History",
      "Announcements",
      "Help & Support",
    ];
    for (const label of disabled) {
      const item = findPlatformNavItem(label);
      assert.ok(item, `${label} row exists`);
      assert.equal(item.href, null, `${label} stays a not-yet-built section`);
      for (const pathname of [
        "/platform",
        PLATFORM_USAGE_PATH,
        "/platform/audit",
        "/platform/users",
      ]) {
        assert.equal(
          isPlatformNavItemActive(pathname, item),
          false,
          `${label} never highlights`,
        );
      }
    }
  });
});

describe("platform active-state rules", () => {
  it("highlights only Analytics on /platform/usage", () => {
    assert.deepEqual(activeLabels(PLATFORM_USAGE_PATH), ["Analytics"]);
  });

  it("keeps the Institutions group silent on /platform/usage", () => {
    const institutions = findPlatformNavItem("Institutions")!;
    assert.equal(isPlatformNavItemActive(PLATFORM_USAGE_PATH, institutions), false);
    for (const child of institutions.children ?? []) {
      assert.equal(
        isPlatformNavChildActive(PLATFORM_USAGE_PATH, institutions.children!, child),
        false,
        `${child.label} is not active on the analytics route`,
      );
    }
  });

  it("honours the dashboard's exact-match rule", () => {
    assert.deepEqual(activeLabels("/platform"), ["Dashboard"]);
    assert.deepEqual(activeLabels("/platform/audit"), ["Audit Logs"]);
    assert.deepEqual(activeLabels("/platform/health"), ["System Health"]);
  });

  it("lights the Institutions parent and directory child on the directory", () => {
    assert.deepEqual(activeLabels(PLATFORM_INSTITUTIONS_PATH), [
      "Institutions",
      "Institutions › All Institutions",
    ]);
  });

  it("lets the most specific child win on institution subroutes", () => {
    assert.deepEqual(activeLabels("/platform/institutions/new"), [
      "Institutions",
      "Institutions › Add Institution",
    ]);
    assert.deepEqual(activeLabels("/platform/institutions/pending-approvals"), [
      "Institutions",
      "Institutions › Pending Approvals",
    ]);
    // A detail page has no dedicated child, so the directory row owns it.
    assert.deepEqual(activeLabels("/platform/institutions/abc-123"), [
      "Institutions",
      "Institutions › All Institutions",
    ]);
  });

  it("keeps submenu screens filed in Institutions on their own route", () => {
    assert.deepEqual(activeLabels("/platform/subscription-plans"), [
      "Institutions › Subscription Plans",
    ]);
  });

  it("does not treat a sibling string prefix as a child route", () => {
    assert.deepEqual(activeLabels("/platform/usage-archive"), []);
    assert.deepEqual(activeLabels("/platform/institutions-archive"), []);
    assert.deepEqual(activeLabels("/platform/audit-notes"), []);
  });

  it("leaves every entry inactive on an unknown platform route", () => {
    assert.deepEqual(activeLabels("/platform/reports"), []);
  });
});

describe("default submenu expansion", () => {
  it("does not open the Institutions group for the analytics route", () => {
    assert.equal(defaultExpandedGroupLabel(PLATFORM_USAGE_PATH), null);
    assert.equal(defaultExpandedGroupLabel("/platform/institutions/abc-123/report"), "Institutions");
  });

  it("opens the Institutions group for its own routes", () => {
    for (const pathname of [
      PLATFORM_INSTITUTIONS_PATH,
      "/platform/institutions/new",
      "/platform/institutions/pending-approvals",
      "/platform/institutions/abc-123",
      "/platform/subscription-plans",
    ]) {
      assert.equal(
        defaultExpandedGroupLabel(pathname),
        "Institutions",
        `${pathname} starts with the submenu open`,
      );
    }
  });

  it("leaves every other route collapsed", () => {
    for (const pathname of ["/platform", "/platform/audit", "/platform/health", "/"]) {
      assert.equal(defaultExpandedGroupLabel(pathname), null);
    }
  });
});
