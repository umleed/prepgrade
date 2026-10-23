// ---------------------------------------------------------------------------
// recover-institute-access.mjs — idempotent RECOVERY for institutes registered
// BEFORE the approval workflow granted workspace access (prompt 05/08 change).
//
// WHY THIS EXISTS
// Earlier builds of `decideInstitutionApplication` only created the tenant row
// on approval — no `profiles` mirror, no `institution_memberships`, no Clerk
// `privateMetadata` role. Those legacy-approved applicants are stuck: the
// application says `approved` but the auth resolver sees no role, so
// /dashboard renders the no-membership state forever. The in-app recovery is
// the SUPER_ADMIN "Retry provisioning" action
// (app/platform/institutions/pending-approvals/actions.ts →
// retryApplicationProvisioning). This script is the SAME procedure run
// server-side by an operator holding the service-role + Clerk secret keys —
// for reconciling rows nobody can click through a session for (e.g. before a
// super admin is available, or in bulk).
//
// IT MIRRORS provisionApplicantAccess() STEP FOR STEP:
//   refuse unless the application row is exactly status='approved';
//   tenant_missing / applicant_missing / role_conflict guards BEFORE writes;
//   profiles + institution_memberships UPSERT FIRST (merge-duplicates, so a
//   re-run updates in place and never duplicates), THEN the Clerk
//   privateMetadata replace (role constant INSTITUTION_ADMIN — this path can
//   never mint SUPER_ADMIN, and it refuses to overwrite a different role or a
//   binding to a different institution);
//   finally provisioning_status='provisioned' is written CONDITIONAL on
//   status='approved'; an audit row records the outcome.
// It creates NO institutions, NO applications, and grants NOTHING to any
// account that is not the row's own trusted applicant id.
//
// USAGE (from the app directory, reads .env for NEXT_PUBLIC_SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, CLERK_SECRET_KEY — nothing is printed ever):
//   node scripts/recover-institute-access.mjs                 # dry-run scan
//   node scripts/recover-institute-access.mjs --apply         # reconcile all
//   node scripts/recover-institute-access.mjs --application <uuid> [--apply]
// Default is DRY RUN: nothing is written without --apply.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const onlyApplication = (() => {
  const i = args.indexOf("--application");
  return i >= 0 ? (args[i + 1] ?? "").trim() : "";
})();

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim().replace(/^"|"$/g, "")]),
);

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const CLERK_KEY = env.CLERK_SECRET_KEY;
if (!SUPABASE_URL || !SERVICE_KEY || !CLERK_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / CLERK_SECRET_KEY in .env.");
  process.exit(1);
}

const restHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

/** Same column set as lib/data/institution-applications.ts APPLICATION_SELECT —
 *  the recovery must see exactly what the app sees. */
const APPLICATION_SELECT =
  "id, applicant_user_id, institution_name, institution_type, contact_person, contact_email, country, state, city, status, approved_institution_id, provisioning_status, provisioning_error, provisioned_at, created_at, updated_at";

async function rest(table, params, init) {
  const qs = params ? `?${new URLSearchParams(params)}` : "";
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${qs}`, {
    ...init,
    headers: { ...restHeaders, ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`REST ${init?.method ?? "GET"} ${table} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function clerk(path, init) {
  const res = await fetch(`https://api.clerk.com/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${CLERK_KEY}`, "Content-Type": "application/json" },
  });
  return res;
}

// --- One reconciliation (mirrors provisionApplicantAccess + record) ---------
// Returns a controlled outcome: { action, reason } where action ∈
// noop | repaired | refused, reason ∈ (provisioning error codes | ok).

async function reconcile(app) {
  const label = `app ${app.id} (${app.institution_name ?? "unnamed"} → ${app.applicant_user_id ?? "no applicant"})`;

  // 0. Only fully-approved rows are ever touched. Pending / rejected /
  //    needs_information / on_hold / draft rows are REFUSED here — their
  //    access comes through the normal review workflow, never a fallback.
  if (app.status !== "approved") {
    return { action: "refused", reason: "notApproved", label };
  }

  // 1. Already fully provisioned and consistent → idempotent no-op.
  if (app.provisioning_status === "provisioned" && app.provisioned_at) {
    const membership = await rest("institution_memberships", {
      select: "role,status",
      institution_id: `eq.${app.approved_institution_id}`,
      user_id: `eq.${app.applicant_user_id}`,
      limit: "1",
    });
    if (membership?.[0]?.role === "INSTITUTION_ADMIN" && membership[0].status === "active") {
      return { action: "noop", reason: "ok", label };
    }
    // Row claims provisioned but the membership is gone — fall through and
    // re-run the same idempotent upserts (never duplicate, repair in place).
  }

  // 2. tenant_missing: approved with no linked institution → nothing to
  //    attach; recovery REFUSES (a super admin must repair the tenant link,
  //    this script never creates one).
  if (!app.approved_institution_id) {
    return { action: "refused", reason: "tenant_missing", label };
  }
  const institutions = await rest("institutions", {
    select: "id,status",
    id: `eq.${app.approved_institution_id}`,
    limit: "1",
  });
  if (!institutions?.length) {
    return { action: "refused", reason: "tenant_missing", label };
  }

  // 3. applicant_missing: the trusted Clerk id captured at submission is the
  //    ONLY identity this path can grant to.
  const applicantUserId = app.applicant_user_id?.trim();
  if (!applicantUserId) {
    return { action: "refused", reason: "applicant_missing", label };
  }
  const userRes = await clerk(`/users/${encodeURIComponent(applicantUserId)}`);
  if (!userRes.ok) {
    return { action: "refused", reason: "applicant_missing", label };
  }
  const user = await userRes.json();
  const priv = user.private_metadata ?? {};
  const currentRole = typeof priv.role === "string" ? priv.role.trim() : null;
  const currentInstitution =
    typeof priv.institutionId === "string" ? priv.institutionId.trim() : null;

  // 4. role_conflict — identical guard to provisionApplicantAccess step 3:
  //    never re-tag an account that already holds another role, and never
  //    move an INSTITUTION_ADMIN to a different tenant through this path.
  if (currentRole !== null && currentRole !== "INSTITUTION_ADMIN") {
    return { action: "refused", reason: "role_conflict", label };
  }
  if (currentRole === "INSTITUTION_ADMIN" && currentInstitution !== app.approved_institution_id) {
    return { action: "refused", reason: "role_conflict", label };
  }

  const emailValue =
    (Array.isArray(user.email_addresses) && user.email_addresses[0]?.email_address) ||
    app.contact_email;
  if (!emailValue) {
    return { action: "refused", reason: "applicant_missing", label };
  }
  const fullName = (user.full_name ?? "").trim() || app.contact_person || emailValue;

  if (!APPLY) {
    return { action: "would-repair", reason: "ok", label };
  }

  // 5. DB mirror rows FIRST (upsert = merge-duplicates on the unique keys),
  //    exactly like upsertApplicantAdminMembership.
  await rest(
    "profiles",
    { on_conflict: "id" },
    {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        id: applicantUserId,
        email: emailValue,
        full_name: fullName,
        account_type: "school",
      }),
    },
  );
  await rest(
    "institution_memberships",
    { on_conflict: "institution_id,user_id" },
    {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        institution_id: app.approved_institution_id,
        user_id: applicantUserId,
        role: "INSTITUTION_ADMIN",
        status: "active",
      }),
    },
  );

  // 6. THEN the trusted Clerk privateMetadata (replaceUserMetadata mirror:
  //    all other metadata keys preserved, role constant — never a caller-
  //    supplied role).
  const metadataRes = await clerk(`/users/${encodeURIComponent(applicantUserId)}/metadata`, {
    method: "PUT",
    body: JSON.stringify({
      public_metadata: user.public_metadata ?? {},
      unsafe_metadata: user.unsafe_metadata ?? {},
      private_metadata: { ...priv, role: "INSTITUTION_ADMIN", institutionId: app.approved_institution_id },
    }),
  });
  if (!metadataRes.ok) {
    // Partial state (membership landed, Clerk failed) — the same recoverable
    // clerk_metadata_failed the in-app retry records. Re-run this script.
    return { action: "refused", reason: "clerk_metadata_failed", label };
  }

  // 7. Record the outcome ON the approved row (conditional, like
  //    writeProvisioningState's .eq('status','approved')).
  await rest(
    "institution_applications",
    { id: `eq.${app.id}`, status: "eq.approved" },
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        provisioning_status: "provisioned",
        provisioning_error: null,
        provisioned_at: new Date().toISOString(),
      }),
    },
  );

  // 8. Audit the recovery (append-only; summary only, no personal data).
  try {
    await rest(
      "platform_audit_log",
      null,
      {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          actor_id: "unknown",
          actor_role: "unknown",
          action: "institution_application.access_provisioned",
          target_type: "institution_application",
          target_id: app.id,
          outcome: "success",
          detail: { summary: "workspace access ready (INSTITUTION_ADMIN) — legacy recovery script" },
        }),
      },
    );
  } catch {
    // Best-effort bookkeeping like the in-app path: the grant itself stands.
  }

  return { action: "repaired", reason: "ok", label };
}

// --- Scan + run --------------------------------------------------------------

const params = {
  select: APPLICATION_SELECT,
  order: "created_at.desc",
  limit: "100",
};
if (onlyApplication) {
  params.id = `eq.${onlyApplication}`;
} else {
  // Only unprovisioned approved rows need reconciliation; decided rows and
  // every open status are never touched.
  params.status = "eq.approved";
  params.provisioning_status = "neq.provisioned";
}

const apps = await rest("institution_applications", params);
if (!Array.isArray(apps) || apps.length === 0) {
  console.log("No applications matched the recovery scan (nothing to do).");
  process.exit(0);
}

console.log(`${APPLY ? "APPLYING" : "DRY RUN"} — ${apps.length} candidate row(s):`);
let repaired = 0;
for (const app of apps) {
  const outcome = await reconcile(app);
  console.log(`  ${outcome.action.padEnd(11)} ${outcome.reason.padEnd(20)} ${outcome.label}`);
  if (outcome.action === "repaired") repaired += 1;
}
console.log(APPLY ? `Done. Repaired ${repaired} application(s).` : "Dry run only — pass --apply to reconcile.");
