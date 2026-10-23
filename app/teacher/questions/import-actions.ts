"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/guards";
import { getActiveQuestionKeys, getQuestionFormOptions, importQuestions } from "@/lib/data/questions";
import {
  analyseImport,
  readyRowPayloads,
  utf8ByteLength,
  IMPORT_MAX_FILE_BYTES,
  type ImportCatalogue,
} from "@/lib/question-import";

/**
 * Result returned to the import form. `ok:false` carries a single form-level
 * message (bad file, catalogue unavailable). `ok:true` reports how many rows
 * were written and which were skipped at write time, each with a plain reason.
 */
export type ImportCommitResult =
  | { ok: true; imported: number; skipped: { line: number; reason: string }[] }
  | { ok: false; message: string };

/**
 * Commit a question import (prompt 34). THE BROWSER SENDS ONLY THE RAW FILE TEXT —
 * nothing it resolved. This handler re-resolves the trusted tenant and manager
 * from the session, re-reads the tenant's OWN catalogue, re-parses and
 * re-validates every row authoritatively, and writes via the shared
 * `createQuestion` path. A crafted payload therefore cannot smuggle another
 * tenant's subject/topic ids, fake provenance, or a spoofed author
 * (AGENTS.md §5, §6, §7).
 */
export async function importQuestionsAction(
  text: string,
): Promise<ImportCommitResult> {
  // Institution admins and teachers both hold `question.manage`; the data
  // layer scopes every write to the caller's trusted tenant.
  const principal = await requireRole(["TEACHER", "INSTITUTION_ADMIN"], {
    next: "/teacher/questions",
  });
  const institutionId = principal.institutionId as string;
  const userId = principal.userId;

  if (typeof text !== "string" || text.trim() === "") {
    return { ok: false, message: "Choose a file to import first." };
  }
  if (utf8ByteLength(text) > IMPORT_MAX_FILE_BYTES) {
    return {
      ok: false,
      message: `The file is too large — keep it under ${Math.round(IMPORT_MAX_FILE_BYTES / 1000)} KB and split a big bank into several imports.`,
    };
  }

  let catalogue: ImportCatalogue;
  let existingKeys: Set<string>;
  try {
    [catalogue, existingKeys] = await Promise.all([
      getQuestionFormOptions(institutionId),
      getActiveQuestionKeys(institutionId),
    ]);
  } catch {
    return {
      ok: false,
      message:
        "Your subject/topic catalogue could not be loaded, so the import cannot be checked. Please try again shortly.",
    };
  }

  const analysis = analyseImport(text, catalogue, existingKeys);
  if (!analysis.ok) {
    return { ok: false, message: analysis.fileError ?? "The file could not be read." };
  }

  const payloads = readyRowPayloads(analysis);
  if (payloads.length === 0) {
    return { ok: false, message: "There were no valid rows to import. Fix the highlighted rows and try again." };
  }

  const result = await importQuestions(institutionId, userId, payloads, existingKeys);

  revalidatePath("/teacher/questions");
  revalidatePath("/institution/question-bank");

  return { ok: true, imported: result.imported, skipped: result.skipped };
}
