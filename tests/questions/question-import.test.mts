/**
 * Question import tests — prompt 34.
 *
 * All coverage here is on the PURE contract (lib/question-import.ts) that both
 * the browser preview and the server commit run: the delimiter/CSV parser, the
 * file-selection + encoding guards, header/column mapping, per-row validation
 * (reusing validateQuestion), reference resolution against a SUPPLIED catalogue,
 * answer-key mapping, duplicate + truncation handling, and the ready payloads
 * the data layer writes.
 *
 * WHAT IS NOT TESTED HERE: the Supabase data layer itself (no live DB in
 * `npm test`). The tenant-isolation guarantee — that only the caller's trusted
 * institution's catalogue and rows are consulted — is enforced in
 * lib/data/questions.ts + importQuestionsAction, both of which scope by a
 * session-derived institution id and re-validate every subject/topic id. The
 * closest pure analogue is asserted below: a subject id that is NOT in the
 * supplied catalogue can never be produced, so a foreign/smuggled id is
 * impossible to emit from this layer.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyseImport,
  detectDelimiter,
  detectEncodingProblem,
  parseDelimited,
  questionDedupeKey,
  readyRowPayloads,
  utf8ByteLength,
  validateFileSelection,
  IMPORT_MAX_FILE_BYTES,
  type ImportCatalogue,
} from "../../lib/question-import.ts";

const CATALOGUE: ImportCatalogue = {
  subjects: [
    { id: "subj-math", name: "Mathematics" },
    { id: "subj-bio", name: "Biology" },
  ],
  topics: [
    { id: "topic-algebra", name: "Algebra", subjectId: "subj-math" },
    { id: "topic-cells", name: "Cells", subjectId: "subj-bio" },
  ],
  categories: [
    { id: "cat-waec", name: "WAEC" },
    { id: "cat-jamb", name: "JAMB" },
  ],
};

const VALID_HEADER = "question,option_a,option_b,option_c,option_d,correct,subject";

function row(cells: Partial<Record<number, string>>): string {
  // Build a comma row from the valid header's 7 columns by index.
  const base = ["", "", "", "", "", "", ""];
  for (const [index, value] of Object.entries(cells)) base[Number(index)] = value ?? "";
  return base.join(",");
}

function csv(rows: string[]): string {
  return [VALID_HEADER, ...rows].join("\n");
}

// --- Delimiter detection -------------------------------------------------------

describe("detectDelimiter", () => {
  it("prefers tab, then semicolon, then comma", () => {
    assert.equal(detectDelimiter("a\tb\tc"), "\t");
    assert.equal(detectDelimiter("a;b;c"), ";");
    assert.equal(detectDelimiter("a,b,c"), ",");
  });

  it("ignores delimiters inside quoted fields", () => {
    assert.equal(detectDelimiter('"a,b",c,"d,e"'), ",");
  });
});

// --- CSV parsing ---------------------------------------------------------------

describe("parseDelimited", () => {
  it("parses quoted fields with embedded delimiters and newlines", () => {
    const records = parseDelimited('question,options\n"What, exactly?",a\nb,"line1\nline2"', ",");
    assert.equal(records.length, 3); // header + 2 data rows
    assert.deepEqual(records[1].cells, ["What, exactly?", "a"]);
    assert.deepEqual(records[2].cells, ["b", "line1\nline2"]);
  });

  it("unescapes doubled quotes", () => {
    const records = parseDelimited('a\n"He said ""hi"""', ",");
    assert.deepEqual(records[1].cells, ['He said "hi"']);
  });

  it("handles CRLF and strips a leading BOM", () => {
    const records = parseDelimited('\uFEFFa,b\r\nc,d\r\n', ",");
    assert.deepEqual(records[0].cells, ["a", "b"]);
    assert.deepEqual(records[1].cells, ["c", "d"]);
  });

  it("records the physical line a row started on", () => {
    const records = parseDelimited('h1,h2\n"multi\nline",x\nlast,y', ",");
    assert.equal(records[1].line, 2); // starts on line 2, spans into line 3
    assert.equal(records[2].line, 4);
  });

  it("drops fully blank rows", () => {
    const records = parseDelimited("a,b\n\n,\nc,d", ",");
    assert.equal(records.length, 2);
  });
});

// --- File selection + encoding guards -----------------------------------------

describe("validateFileSelection", () => {
  it("accepts a csv/tsv/txt file of reasonable size", () => {
    assert.equal(validateFileSelection("q.csv", "text/csv", 512), null);
    assert.equal(validateFileSelection("q.tsv", "", 512), null);
  });

  it("rejects the wrong extension, MIME, empty, and oversized files", () => {
    assert.match(validateFileSelection("q.xlsx", "", 512) ?? "", /\.csv or \.tsv/i);
    assert.match(validateFileSelection("q.csv", "application/pdf", 512) ?? "", /not supported/i);
    assert.match(validateFileSelection("q.csv", "text/csv", 0) ?? "", /empty/i);
    assert.match(
      validateFileSelection("q.csv", "text/csv", IMPORT_MAX_FILE_BYTES + 1) ?? "",
      /under/i,
    );
  });
});

describe("detectEncodingProblem", () => {
  it("flags invalid UTF-8 and binary content", () => {
    assert.match(detectEncodingProblem("bad \uFFFD byte") ?? "", /UTF-8/i);
    assert.match(detectEncodingProblem("nul \u0000 byte") ?? "", /text file/i);
    assert.equal(detectEncodingProblem("clean text"), null);
  });
});

describe("utf8ByteLength", () => {
  it("counts bytes, not characters", () => {
    assert.equal(utf8ByteLength("a\u00e9\u20ac"), 6); // 1 + 2 + 3
    assert.equal(utf8ByteLength("abc"), 3);
  });
});

// --- Whole-file analysis -------------------------------------------------------

describe("analyseImport", () => {
  it("produces ready rows with server-resolved ids for a valid file", () => {
    const analysis = analyseImport(
      csv([
        row({ 0: "What is 2 + 2?", 1: "2", 2: "3", 3: "4", 4: "5", 5: "C", 6: "Mathematics" }),
      ]),
      CATALOGUE,
    );
    assert.equal(analysis.ok, true);
    assert.equal(analysis.readyCount, 1);
    assert.equal(analysis.errorCount, 0);

    const [payload] = readyRowPayloads(analysis);
    assert.equal(payload.input.subjectId, "subj-math");
    assert.equal(payload.input.options.join("|"), "2|3|4|5");
    assert.equal(payload.input.correctOptionIndex, 2); // "C" → index 2
    assert.equal(payload.input.questionType, "mcq_single");
    assert.equal(payload.input.provenance, "teacher_created"); // default
  });

  it("maps the correct answer by exact option text", () => {
    const analysis = analyseImport(
      csv([row({ 0: "Capital of France?", 1: "London", 2: "Paris", 5: "Paris", 6: "Mathematics" })]),
      CATALOGUE,
    );
    const [payload] = readyRowPayloads(analysis);
    assert.equal(payload.input.correctOptionIndex, 1);
  });

  it("refuses a subject that is not in the supplied catalogue", () => {
    // The data layer would reject it too; the pure layer must never emit a
    // resolved id for an unknown name, which is how foreign ids are blocked.
    const analysis = analyseImport(
      csv([row({ 0: "Q?", 1: "a", 2: "b", 5: "A", 6: "Astronomy" })]),
      CATALOGUE,
    );
    assert.equal(analysis.readyCount, 0);
    assert.equal(analysis.errorCount, 1);
    assert.match(analysis.rows[0].errors.subjectId ?? "", /Astronomy/);
    assert.equal(readyRowPayloads(analysis).length, 0);
  });

  it("rejects a topic that is not under the row's subject", () => {
    const analysis = analyseImport(
      ["question,option_a,option_b,correct,subject,topic", "Q?,a,b,A,Mathematics,Cells"].join("\n"),
      CATALOGUE,
    );
    assert.equal(analysis.readyCount, 0);
    assert.match(analysis.rows[0].errors.topicId ?? "", /Cells/);
  });

  it("rejects an unknown exam category", () => {
    const analysis = analyseImport(
      ["question,option_a,option_b,correct,subject,category", "Q?,a,b,A,Mathematics,WASSCE"].join("\n"),
      CATALOGUE,
    );
    assert.match(analysis.rows[0].errors.categoryId ?? "", /WASSCE/);
  });

  it("flags an answer letter beyond the number of options", () => {
    const analysis = analyseImport(
      csv([row({ 0: "Q?", 1: "a", 2: "b", 5: "D", 6: "Mathematics" })]),
      CATALOGUE,
    );
    assert.equal(analysis.readyCount, 0);
    assert.match(analysis.rows[0].errors.correctOptionIndex ?? "", /does not exist/i);
  });

  it("flags option gaps (a filled option after a blank one)", () => {
    const analysis = analyseImport(
      ["question,option_a,option_b,option_c,correct,subject", "Q?,a,,c,A,Mathematics"].join("\n"),
      CATALOGUE,
    );
    assert.match(analysis.rows[0].errors.options ?? "", /in order/i);
  });

  it("reports a missing required column as a file-level error", () => {
    const analysis = analyseImport("question,subject\nQ?,Mathematics", CATALOGUE);
    assert.equal(analysis.ok, false);
    assert.match(analysis.fileError ?? "", /missing required column/i);
    assert.ok(analysis.missingColumns.includes("correct"));
  });

  it("treats a second occurrence of the same question as a duplicate", () => {
    const analysis = analyseImport(
      csv([
        row({ 0: "Same question?", 1: "a", 2: "b", 5: "A", 6: "Mathematics" }),
        row({ 0: "  same   question? ", 1: "a", 2: "b", 5: "A", 6: "Mathematics" }),
      ]),
      CATALOGUE,
    );
    assert.equal(analysis.readyCount, 1);
    assert.equal(analysis.duplicateCount, 1);
    assert.equal(analysis.rows[1].status, "duplicate");
  });

  it("skips rows that already exist in the supplied existing-key set", () => {
    const analysis = analyseImport(
      csv([row({ 0: "Already in bank?", 1: "a", 2: "b", 5: "A", 6: "Mathematics" })]),
      CATALOGUE,
      new Set([questionDedupeKey("already in bank?")]),
    );
    assert.equal(analysis.readyCount, 0);
    assert.equal(analysis.duplicateCount, 1);
  });

  it("parses friendly provenance and licensing values", () => {
    const analysis = analyseImport(
      ["question,option_a,option_b,correct,subject,provenance,source_label,difficulty,marks",
        "Q?,a,b,A,Mathematics,Licensed,WAEC 2019,hard,3"].join("\n"),
      CATALOGUE,
    );
    const [payload] = readyRowPayloads(analysis);
    assert.equal(payload.input.provenance, "licensed");
    assert.equal(payload.input.sourceLabel, "WAEC 2019");
    assert.equal(payload.input.difficulty, "hard");
    assert.equal(payload.input.marks, 3);
  });

  it("flags an unrecognised provenance value", () => {
    const analysis = analyseImport(
      ["question,option_a,option_b,correct,subject,provenance", "Q?,a,b,A,Mathematics,scraped"].join("\n"),
      CATALOGUE,
    );
    assert.match(analysis.rows[0].errors.provenance ?? "", /teacher_created|licensed/i);
  });

  it("rejects an empty file and a header-only file distinctly", () => {
    assert.match(analyseImport("   ", CATALOGUE).fileError ?? "", /empty/i);
    assert.match(analyseImport(VALID_HEADER, CATALOGUE).fileError ?? "", /no data rows/i);
  });

  it("truncates a file larger than the row cap and flags it", () => {
    const many = Array.from({ length: 1001 }, (_, i) =>
      row({ 0: `Q ${i}?`, 1: "a", 2: "b", 5: "A", 6: "Mathematics" }),
    );
    const analysis = analyseImport(csv(many), CATALOGUE);
    assert.equal(analysis.truncated, true);
    assert.equal(analysis.rows.length, 1000);
    assert.equal(analysis.totalRows, 1001);
  });

  it("preserves every structural validateQuestion rule", () => {
    // A duplicate option is a structural problem the shared validator owns.
    const analysis = analyseImport(
      csv([row({ 0: "Q?", 1: "same", 2: "same", 5: "A", 6: "Mathematics" })]),
      CATALOGUE,
    );
    assert.match(analysis.rows[0].errors.options ?? "", /different/i);
  });
});
