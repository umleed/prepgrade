/**
 * Session + denial routing tests.
 *
 * Covers where a denied request is sent, what the sign-in screen is allowed to
 * claim, and that a crafted query parameter can never turn into an off-site
 * redirect or a fabricated message. These are the pure halves of `guards.ts`
 * (`lib/auth/routing.ts`) and `lib/auth/redirect.ts`, which is exactly why the
 * routing table lives outside the module that imports `next/navigation`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ACCESS_NOTICES,
  DENIAL_PARAM,
  SIGN_OUT_REDIRECT_URL,
  denialFromParam,
  loginNoticeFromReason,
  statusForDenial,
  type AccessDenial,
} from "../../lib/auth/access.ts";
import {
  DASHBOARD_PATH,
  dashboardUrlForDenial,
  redirectTargetForDenial,
} from "../../lib/auth/routing.ts";
import { safeInternalRedirect } from "../../lib/auth/redirect.ts";

const ALL_DENIALS: AccessDenial[] = [
  "signedOut",
  "sessionExpired",
  "noMembership",
  "roleNotAllowed",
  "tenantMismatch",
  "permissionDenied",
  "ownerMismatch",
  "scopeMismatch",
];

describe("safeInternalRedirect", () => {
  it("keeps same-origin paths", () => {
    assert.equal(safeInternalRedirect("/dashboard"), "/dashboard");
    assert.equal(safeInternalRedirect("/exams/12?tab=results"), "/exams/12?tab=results");
  });

  it("rejects off-site and protocol-relative targets", () => {
    for (const target of [
      "//evil.example",
      "https://evil.example",
      "http://evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
    ]) {
      assert.equal(safeInternalRedirect(target), "/dashboard", target);
    }
  });

  it("honours an explicit fallback", () => {
    assert.equal(
      safeInternalRedirect("https://evil.example", "/onboarding"),
      "/onboarding",
    );
  });
});

describe("redirectTargetForDenial", () => {
  it("sends session problems to sign-in, never to a data page", () => {
    const signedOut = redirectTargetForDenial("signedOut", "/dashboard");
    const expired = redirectTargetForDenial("sessionExpired", "/dashboard");

    assert.match(signedOut, /^\/login\?next=/);
    assert.doesNotMatch(signedOut, /reason=/);
    assert.match(expired, /reason=expired$/);
  });

  it("keeps the return path, sanitised", () => {
    const target = redirectTargetForDenial(
      "signedOut",
      "https://evil.example/phishing",
    );

    // The hostile value is replaced by the dashboard fallback before it is
    // encoded into `?next=`.
    assert.equal(target, "/login?next=%2Fdashboard");
  });

  it("keeps membership, role, tenant, and resource problems inside the app", () => {
    for (const reason of [
      "noMembership",
      "roleNotAllowed",
      "tenantMismatch",
      "permissionDenied",
      "ownerMismatch",
      "scopeMismatch",
    ] as const) {
      const target = redirectTargetForDenial(reason, "/dashboard");

      assert.equal(target, `${DASHBOARD_PATH}?denied=${DENIAL_PARAM[reason]}`);
      assert.doesNotMatch(target, /^\/login/, `${reason} must not force sign-in`);
    }
  });

  it("defaults the return path to the dashboard", () => {
    assert.equal(
      redirectTargetForDenial("signedOut"),
      "/login?next=%2Fdashboard",
    );
  });
});

describe("denial param round trip", () => {
  it("maps every denial to a param and back", () => {
    for (const reason of ALL_DENIALS) {
      assert.equal(denialFromParam(DENIAL_PARAM[reason]), reason);
    }
  });

  it("returns null for unknown, empty, or injected values", () => {
    for (const value of [undefined, null, "", "sudo", "role%20NotAllowed", "ROLE"]) {
      assert.equal(denialFromParam(value), null, String(value));
    }
  });

  it("builds the dashboard denial URL from the same table", () => {
    assert.equal(
      dashboardUrlForDenial("tenantMismatch"),
      `/dashboard?denied=${DENIAL_PARAM.tenantMismatch}`,
    );
  });
});

describe("sign-in notices", () => {
  it("shows a notice only for reasons this app wrote", () => {
    assert.equal(
      loginNoticeFromReason(DENIAL_PARAM.sessionExpired)?.title,
      ACCESS_NOTICES.sessionExpired.title,
    );
    assert.equal(
      loginNoticeFromReason(DENIAL_PARAM.signedOut)?.title,
      ACCESS_NOTICES.signedOut.title,
    );
  });

  it("stays silent for unknown or absent reasons instead of inventing a story", () => {
    for (const value of [undefined, null, "", "hacked", "roleNotAllowed"]) {
      assert.equal(loginNoticeFromReason(value), null, String(value));
    }
  });

  it("lands an explicit sign-out on the sign-in screen", () => {
    assert.equal(SIGN_OUT_REDIRECT_URL, "/login?reason=signed-out");
    assert.equal(
      loginNoticeFromReason(new URL(SIGN_OUT_REDIRECT_URL, "http://localhost").searchParams.get("reason"))?.title,
      ACCESS_NOTICES.signedOut.title,
    );
  });
});

describe("access notices and API status codes", () => {
  it("gives every denial a notice, and never leaks an identifier in it", () => {
    for (const reason of ALL_DENIALS) {
      const notice = ACCESS_NOTICES[reason];
      assert.ok(notice.title.length > 0);
      assert.ok(notice.message.length > 0);
      assert.doesNotMatch(notice.message, /inst_|user_|clerk/i, reason);
    }
  });

  it("answers missing identity with 401 and failed authorization with 403", () => {
    assert.equal(statusForDenial("signedOut"), 401);
    assert.equal(statusForDenial("sessionExpired"), 401);
    assert.equal(statusForDenial("noMembership"), 403);
    assert.equal(statusForDenial("roleNotAllowed"), 403);
    assert.equal(statusForDenial("tenantMismatch"), 403);
    assert.equal(statusForDenial("permissionDenied"), 403);
    assert.equal(statusForDenial("ownerMismatch"), 403);
    assert.equal(statusForDenial("scopeMismatch"), 403);
  });
});
