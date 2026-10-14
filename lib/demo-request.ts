/**
 * Demo-request contract and validation.
 *
 * Kept as a pure, dependency-free module so the exact same rules run in the
 * browser (instant feedback) and on the server (authoritative validation).
 * The server ALWAYS re-validates — client validation is a convenience, never a
 * security boundary (AGENTS.md §7). No new packages are introduced.
 */

export type DemoRequestInput = {
  institutionName: string;
  contactPerson: string;
  role: string;
  email: string;
  phone: string;
  institutionType: string;
  studentCount: string;
  message: string;
  /** Hidden honeypot field. Must stay empty for a human submission. */
  website: string;
};

export type DemoRequestField = keyof DemoRequestInput;

export type DemoRequestErrors = Partial<Record<DemoRequestField, string>>;

/** Option lists — single source of truth for the selects and validation. */
export const DEMO_ROLES = [
  "School Administrator",
  "Principal / Owner",
  "Teacher",
  "Tutorial Centre Coordinator",
  "Student",
  "Parent / Guardian",
  "Other",
] as const;

export const INSTITUTION_TYPES = [
  "Public School",
  "Private School",
  "Tutorial / Coaching Centre",
  "Online School",
  "Education Non-profit",
  "Other",
] as const;

/** Approximate buckets — avoids demanding an exact head-count up front. */
export const STUDENT_COUNT_RANGES = [
  "Under 50",
  "50 – 150",
  "151 – 500",
  "501 – 1,000",
  "1,000 – 3,000",
  "Over 3,000",
] as const;

export const DEMO_REQUEST_EMPTY: DemoRequestInput = {
  institutionName: "",
  contactPerson: "",
  role: "",
  email: "",
  phone: "",
  institutionType: "",
  studentCount: "",
  message: "",
  website: "",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Allows digits, spaces and common phone punctuation; requires 7–15 digits.
const PHONE_RE = /^[+()\-\s.\d]+$/;

function digits(value: string): number {
  return value.replace(/\D/g, "").length;
}

/**
 * Validate a demo-request payload. Returns a map of field → message; an empty
 * map means the submission is valid. `phone` is optional but, when provided,
 * must look like a phone number; at least one of email/phone must be present so
 * we can always reach the requester.
 */
export function validateDemoRequest(
  input: DemoRequestInput,
): DemoRequestErrors {
  const errors: DemoRequestErrors = {};

  const institutionName = input.institutionName.trim();
  if (!institutionName) {
    errors.institutionName = "Enter your institution or centre name.";
  } else if (institutionName.length > 160) {
    errors.institutionName = "Keep this under 160 characters.";
  }

  const contactPerson = input.contactPerson.trim();
  if (!contactPerson) {
    errors.contactPerson = "Enter the name of the main contact.";
  } else if (contactPerson.length > 120) {
    errors.contactPerson = "Keep this under 120 characters.";
  }

  if (!input.role.trim()) {
    errors.role = "Select the option that best describes you.";
  } else if (!DEMO_ROLES.includes(input.role as (typeof DEMO_ROLES)[number])) {
    errors.role = "Select a valid role.";
  }

  const email = input.email.trim();
  const phone = input.phone.trim();
  if (!email && !phone) {
    errors.email = "Provide an email address, a phone number, or both.";
  }
  if (email) {
    if (email.length > 160) {
      errors.email = "Keep the email under 160 characters.";
    } else if (!EMAIL_RE.test(email)) {
      errors.email = "Enter a valid email address.";
    }
  }
  if (phone) {
    const count = digits(phone);
    if (!PHONE_RE.test(phone) || count < 7 || count > 15) {
      errors.phone = "Enter a valid phone number.";
    }
  }

  if (!input.institutionType.trim()) {
    errors.institutionType = "Select your institution type.";
  } else if (
    !INSTITUTION_TYPES.includes(
      input.institutionType as (typeof INSTITUTION_TYPES)[number],
    )
  ) {
    errors.institutionType = "Select a valid institution type.";
  }

  if (!input.studentCount.trim()) {
    errors.studentCount = "Select an approximate student count.";
  } else if (
    !STUDENT_COUNT_RANGES.includes(
      input.studentCount as (typeof STUDENT_COUNT_RANGES)[number],
    )
  ) {
    errors.studentCount = "Select a valid range.";
  }

  if (input.message.trim().length > 1000) {
    errors.message = "Keep your message under 1,000 characters.";
  }

  return errors;
}
