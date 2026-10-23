/**
 * Question import contract — pure, dependency-free, unit-testable.
 *
 * WHAT THIS IS FOR (prompt 34)
 * Institutions sometimes hold a bank of questions in a spreadsheet and want to
 * load it in instead of re-typing every row. Import is the ONLY place a bulk
 * payload enters the question bank, so it is where the same rules the authoring
 * form enforces get applied to every row — plus the file-level rules a
 * spreadsheet needs (type, size, encoding, headers, references, duplicates).
 *
 * ONE SOURCE OF TRUTH FOR VALIDATION
 * Every parsed row is converted to the SAME `QuestionInput` the form uses and
 * run through `validateQuestion()`. This module adds only the rules that are
 * specific to import (a spreadsheet column that is missing, an answer that does
 * not map to a real option, a subject/topic/category name that is not in the
 * tenant's catalogue, a repeated question). It never weakens a structural rule.
 *
 * TENANCY IS NOT DECIDED HERE (AGENTS.md §5)
 * `analyseImport` resolves subject/topic/category NAMES against a catalogue that
 * the CALLER supplies — and the caller is always server code that read that
 * catalogue through the trusted tenant (lib/data/questions.ts). On its own this
 * module has no database access and trusts nothing: it turns a name into an id
 * only because the caller already proved that id is visible to the tenant. The
 * authoritative re-check still happens on every write in the data layer.
 *
 * ANSWER-KEY INTEGRITY (AGENTS.md §6)
 * A spreadsheet names the correct answer by letter (A, B, C…) or by its text,
 * never by a hidden index. Mapping to the 0-based `correctOptionIndex` happens
 * here and is validated to always point at a real option, exactly like the form.
 *
 * CONTENT RIGHTS (AGENTS.md §7)
 * Import defaults provenance to `teacher_created` and records source/licensing
 * columns when present. It carries the legal-basis fields through so an import
 * is never more anonymous than a hand-authored question.
 */

import {
  OPTION_MAX_COUNT,
  QUESTION_DIFFICULTIES,
  validateQuestion,
  type QuestionErrors,
  type QuestionInput,
  type QuestionProvenance,
} from "./questions.ts";

// --- File-level limits ---------------------------------------------------------

/** Reject uploads larger than ~2 MB before parsing — a bank import is text. */
export const IMPORT_MAX_FILE_BYTES = 2_000_000;
/** Hard cap on rows per import so one file can never flood the bank. */
export const IMPORT_MAX_ROWS = 1000;

/** File names/extensions the picker accepts (CSV or TSV, plain text). */
const ALLOWED_EXTENSIONS = [".csv", ".tsv", ".txt"] as const;
const ALLOWED_MIME_PREFIXES = ["text/", "application/vnd.ms-excel"] as const;

/**
 * Validate a file SELECTION (name / MIME type / byte size) before reading it.
 * Returns a human message, or `null` when the selection is acceptable. This is
 * convenience for the picker; the server re-checks size after reading text.
 */
export function validateFileSelection(
  fileName: string,
  mimeType: string,
  byteSize: number,
): string | null {
  const lower = fileName.trim().toLowerCase();
  if (!ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return "Choose a .csv or .tsv file exported from your spreadsheet.";
  }
  if (mimeType && !ALLOWED_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix))) {
    return "That file type is not supported — export it as CSV or TSV (plain text).";
  }
  if (byteSize <= 0) {
    return "The file appears to be empty.";
  }
  if (byteSize > IMPORT_MAX_FILE_BYTES) {
    return `Keep the file under ${Math.round(IMPORT_MAX_FILE_BYTES / 1000)} KB — split a very large bank into several imports.`;
  }
  return null;
}

/** UTF-8 byte length, using the global TextEncoder available on client & server. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Encoding guard for text already read as UTF-8. A replacement character means
 * the bytes were not valid UTF-8 (commonly a Windows-1251/ANSI export), so we
 * refuse rather than import mojibake. A NUL byte means a binary file.
 */
export function detectEncodingProblem(text: string): string | null {
  if (text.includes("\uFFFD")) {
    return "The file is not valid UTF-8 text. Re-export it from your spreadsheet as CSV (UTF-8).";
  }
  if (text.includes("\u0000")) {
    return "That does not look like a text file. Export your questions as CSV or TSV.";
  }
  return null;
}

// --- Column vocabulary ---------------------------------------------------------

/** Logical field → accepted (canonicalised) header names. */
const COLUMN_ALIASES: Record<string, readonly string[]> = {
  questionText: ["question", "questiontext", "text", "q"],
  correct: ["correct", "correctanswer", "answer", "correctoption", "key"],
  subject: ["subject", "subjectname"],
  topic: ["topic", "topicname", "subtopic"],
  category: ["category", "examcategory", "categorycode", "exam"],
  difficulty: ["difficulty", "level"],
  marks: ["marks", "mark", "points", "score"],
  explanation: ["explanation", "rationale"],
  learningObjective: ["learningobjective", "objective", "outcome"],
  provenance: ["provenance", "sourcetype", "origin"],
  sourceLabel: ["sourcelabel", "source", "sourcequestion", "sourcename"],
  sourceYear: ["sourceyear", "year"],
  licenseNotes: ["licensenotes", "license", "licence", "rights", "permissions"],
};

const OPTION_LETTERS = "ABCDEFGH";
function optionLetterFor(index: number): string {
  return OPTION_LETTERS[index] ?? "";
}

/** Option columns, in A..H order; each accepts `option_a`/`optiona`/`a`. */
const OPTION_ALIASES: readonly string[][] = Array.from(
  { length: OPTION_MAX_COUNT },
  (_, index) => {
    const lower = optionLetterFor(index).toLowerCase();
    return [`option${lower}`, `option${index + 1}`, lower];
  },
);

/** Lowercase, strip everything non-alphanumeric so headers can be written freely. */
function canonicalHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

// --- Parsing -------------------------------------------------------------------

type ParsedRecord = { cells: string[]; line: number };

/**
 * Detect the delimiter from the first line by counting candidates outside
 * quotes, preferring tab then semicolon then comma.
 */
export function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const counts: Record<string, number> = { "\t": 0, ";": 0, ",": 0 };
  let inQuotes = false;
  for (let i = 0; i < firstLine.length; i += 1) {
    const char = firstLine[i];
    if (inQuotes) {
      if (char === '"' && firstLine[i + 1] === '"') i += 1;
      else if (char === '"') inQuotes = false;
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char in counts) counts[char] += 1;
  }
  if (counts["\t"] > 0 && counts["\t"] >= counts[";"] && counts["\t"] >= counts[","]) return "\t";
  if (counts[";"] > 0 && counts[";"] >= counts[","]) return ";";
  return ",";
}

/**
 * A small RFC-4180 parser: quoted fields, escaped double-quotes, delimiters and
 * newlines inside quotes, and CRLF/CR/LF endings. Each record remembers the
 * physical line it started on, so the report can point a user at the right row.
 */
export function parseDelimited(text: string, delimiter: string): ParsedRecord[] {
  // Strip a leading UTF-8 BOM so the first header canonicalises correctly.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const records: ParsedRecord[] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let line = 1;
  let rowStartLine = 1;
  let touched = false; // current record has received any character

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else if (char === "\n") {
        line += 1;
        field += "\n";
      } else if (char !== "\r") {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      touched = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
      touched = true;
    } else if (char === "\n") {
      row.push(field);
      records.push({ cells: row, line: rowStartLine });
      row = [];
      field = "";
      touched = false;
      line += 1;
      rowStartLine = line;
    } else if (char === "\r") {
      // Ignore lone CR / the CR of CRLF; the LF handler closes the record.
      touched = true;
    } else {
      field += char;
      touched = true;
    }
  }

  // Flush a final record that had no trailing newline.
  if (touched || field !== "" || row.length > 0) {
    row.push(field);
    records.push({ cells: row, line: rowStartLine });
  }

  // Drop fully blank rows (blank lines, trailing newline artefacts).
  return records.filter((record) => record.cells.some((cell) => cell.trim() !== ""));
}

/**
 * Map a header row onto logical column indices. Each non-option field takes the
 * FIRST column whose canonical header matches one of its aliases. Option columns
 * are assigned positionally (A, then B, …) so their order in the array matches
 * the A..H letters the answer key refers to.
 */
function mapColumns(header: string[]): {
  logical: Map<string, number>;
  options: number[];
} {
  const canonical = header.map(canonicalHeader);
  const logical = new Map<string, number>();
  const claimed = new Set<number>();

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const index = canonical.findIndex(
      (name, col) => !claimed.has(col) && (aliases as readonly string[]).includes(name),
    );
    if (index !== -1) {
      logical.set(field, index);
      claimed.add(index);
    }
  }

  const options: number[] = [];
  for (let optionIndex = 0; optionIndex < OPTION_MAX_COUNT; optionIndex += 1) {
    const aliases = OPTION_ALIASES[optionIndex];
    const chosen = canonical.findIndex(
      (name, col) => !claimed.has(col) && aliases.includes(name),
    );
    if (chosen !== -1) {
      options.push(chosen);
      claimed.add(chosen);
    }
  }

  return { logical, options };
}

// --- Row shapes ----------------------------------------------------------------

/** One spreadsheet row keyed by the raw cell values (before resolution). */
export type RawImportRow = {
  line: number;
  questionText: string;
  options: string[];
  /** Raw correct-answer cell (letter A..H or exact option text). */
  correct: string;
  subject: string;
  topic: string;
  category: string;
  difficulty: string;
  marks: string;
  explanation: string;
  learningObjective: string;
  provenance: string;
  sourceLabel: string;
  sourceYear: string;
  licenseNotes: string;
};

/** Catalogue the caller resolved for the trusted tenant (names → ids). */
export type ImportCatalogue = {
  subjects: { id: string; name: string }[];
  topics: { id: string; name: string; subjectId: string }[];
  categories: { id: string; name: string }[];
};

export type ImportRowStatus = "ready" | "error" | "duplicate";

export type ImportRowReport = {
  line: number;
  questionText: string;
  status: ImportRowStatus;
  errors: QuestionErrors;
  /** Present when `status === "ready"` — the resolved payload for the write. */
  input?: QuestionInput;
};

export type ImportAnalysis = {
  /** `false` when a file-level problem means there is nothing to preview. */
  ok: boolean;
  fileError?: string;
  delimiter: string;
  columns: string[];
  missingColumns: string[];
  totalRows: number;
  readyCount: number;
  errorCount: number;
  duplicateCount: number;
  truncated: boolean;
  rows: ImportRowReport[];
};

/** Case/space-insensitive key used for duplicate detection. */
export function questionDedupeKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function findLogical(cells: string[], logical: Map<string, number>, field: string): string {
  const index = logical.get(field);
  if (index === undefined) return "";
  return (cells[index] ?? "").trim();
}

/** Parse the provenance cell into a known value, or flag it. */
function parseProvenance(
  raw: string,
  errors: QuestionErrors,
): QuestionProvenance {
  const value = raw.trim().toLowerCase();
  if (!value) return "teacher_created";
  if (value === "teacher_created" || value === "licensed") return value;
  if (value.includes("licen")) return "licensed";
  if (value.includes("teacher") || value.includes("creat") || value.includes("own") || value.includes("institution")) {
    return "teacher_created";
  }
  errors.provenance = "Provenance must be “teacher_created” or “licensed” (leave blank for your own questions).";
  return "teacher_created";
}

function parseDifficulty(
  raw: string,
  errors: QuestionErrors,
): QuestionInput["difficulty"] {
  const value = raw.trim().toLowerCase();
  if (!value) return "medium";
  if ((QUESTION_DIFFICULTIES as readonly string[]).includes(value)) {
    return value as QuestionInput["difficulty"];
  }
  errors.difficulty = "Difficulty must be easy, medium, or hard.";
  return "medium";
}

function parseMarks(raw: string, errors: QuestionErrors): number {
  const value = raw.trim();
  if (!value) return 1;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== value) {
    errors.marks = "Marks must be a whole number.";
    return 1;
  }
  return parsed;
}

/** Map "A"–"H" or an exact option text to a 0-based option index. */
function resolveCorrectIndex(
  correctRaw: string,
  options: string[],
  errors: QuestionErrors,
): number {
  const value = correctRaw.trim();
  if (!value) {
    errors.correctOptionIndex = "Mark which option is the correct answer.";
    return 0;
  }

  // A single letter A..H (case-insensitive).
  if (/^[a-h]$/i.test(value)) {
    const index = value.toUpperCase().charCodeAt(0) - 65;
    if (index >= options.length) {
      errors.correctOptionIndex = `Option ${value.toUpperCase()} does not exist — this row has ${options.length} option(s).`;
      return 0;
    }
    return index;
  }

  // Otherwise match the option text (trimmed, case-insensitive).
  const target = value.toLowerCase();
  const byText = options.findIndex((option) => option.trim().toLowerCase() === target);
  if (byText === -1) {
    errors.correctOptionIndex = "The correct answer must be an option letter (A, B, C…) or the exact text of one option.";
    return 0;
  }
  return byText;
}

/** Resolve a subject/topic/category name to an id, flagging unknowns. */
function resolveReferences(
  row: RawImportRow,
  catalogue: ImportCatalogue,
  errors: QuestionErrors,
): { subjectId: string; topicId: string; categoryId: string } {
  const subjectName = row.subject.trim().toLowerCase();
  const subject = catalogue.subjects.find((entry) => entry.name.trim().toLowerCase() === subjectName);
  let subjectId = "";
  if (!row.subject.trim()) {
    errors.subjectId = "Every row needs a subject.";
  } else if (!subject) {
    errors.subjectId = `No subject “${row.subject.trim()}” in your catalogue.`;
  } else {
    subjectId = subject.id;
  }

  let topicId = "";
  if (row.topic.trim()) {
    if (!subjectId) {
      errors.topicId = "Resolve the subject before setting a topic.";
    } else {
      const topic = catalogue.topics.find(
        (entry) =>
          entry.subjectId === subjectId &&
          entry.name.trim().toLowerCase() === row.topic.trim().toLowerCase(),
      );
      if (!topic) {
        errors.topicId = `No topic “${row.topic.trim()}” under that subject.`;
      } else {
        topicId = topic.id;
      }
    }
  }

  let categoryId = "";
  if (row.category.trim()) {
    const category = catalogue.categories.find(
      (entry) => entry.name.trim().toLowerCase() === row.category.trim().toLowerCase(),
    );
    if (!category) {
      errors.categoryId = `No exam category “${row.category.trim()}”.`;
    } else {
      categoryId = category.id;
    }
  }

  return { subjectId, topicId, categoryId };
}

/** Convert one raw row into a QuestionInput plus structural import errors. */
export function buildRowInput(
  row: RawImportRow,
  catalogue: ImportCatalogue,
): { input: QuestionInput; errors: QuestionErrors } {
  const errors: QuestionErrors = {};

  // Options must be contiguous from A: no filled option after a blank one.
  const options: string[] = [];
  for (const cell of row.options) {
    const value = cell.trim();
    if (value === "") break;
    options.push(value);
  }
  const trailingFilled = row.options.slice(options.length).some((cell) => cell.trim() !== "");
  if (trailingFilled) {
    errors.options = "Options must be filled in order (A, then B, …) with no gaps.";
  }

  const correctOptionIndex = resolveCorrectIndex(row.correct, options, errors);
  const references = resolveReferences(row, catalogue, errors);

  const input: QuestionInput = {
    questionText: row.questionText,
    subjectId: references.subjectId,
    topicId: references.topicId,
    categoryId: references.categoryId,
    questionType: "mcq_single",
    difficulty: parseDifficulty(row.difficulty, errors),
    options: options.length > 0 ? options : ["", ""],
    correctOptionIndex,
    explanation: row.explanation,
    marks: parseMarks(row.marks, errors),
    learningObjective: row.learningObjective,
    provenance: parseProvenance(row.provenance, errors),
    sourceLabel: row.sourceLabel,
    sourceYear: row.sourceYear,
    licenseNotes: row.licenseNotes,
  };

  // The shared structural validator is authoritative for the question itself.
  const structural = validateQuestion(input);
  const merged: QuestionErrors = { ...structural, ...errors };
  // Subject reference errors replaced validateQuestion's generic "choose a
  // subject" only when we actually set one; keep whichever message is present.
  return { input, errors: merged };
}

/** Map a parsed record's cells onto a RawImportRow using the column map. */
function recordToRow(
  record: ParsedRecord,
  logical: Map<string, number>,
  optionColumns: number[],
): RawImportRow {
  const options = optionColumns
    .map((index) => (record.cells[index] ?? "").trim())
    .slice(0, OPTION_MAX_COUNT);
  // Pad to keep contiguous-order detection meaningful even when trailing
  // option columns are absent from the header entirely.
  while (options.length < OPTION_MAX_COUNT) options.push("");

  return {
    line: record.line,
    questionText: findLogical(record.cells, logical, "questionText"),
    options,
    correct: findLogical(record.cells, logical, "correct"),
    subject: findLogical(record.cells, logical, "subject"),
    topic: findLogical(record.cells, logical, "topic"),
    category: findLogical(record.cells, logical, "category"),
    difficulty: findLogical(record.cells, logical, "difficulty"),
    marks: findLogical(record.cells, logical, "marks"),
    explanation: findLogical(record.cells, logical, "explanation"),
    learningObjective: findLogical(record.cells, logical, "learningObjective"),
    provenance: findLogical(record.cells, logical, "provenance"),
    sourceLabel: findLogical(record.cells, logical, "sourceLabel"),
    sourceYear: findLogical(record.cells, logical, "sourceYear"),
    licenseNotes: findLogical(record.cells, logical, "licenseNotes"),
  };
}

/**
 * Parse + preview a whole file. Runs the same rules client-side (instant
 * report) and server-side (authoritative commit) — the caller supplies the
 * tenant's catalogue and, at commit time, the set of question texts already in
 * the bank so against-bank duplicates are skipped, not re-imported.
 */
export function analyseImport(
  text: string,
  catalogue: ImportCatalogue,
  existingQuestionKeys?: Set<string>,
): ImportAnalysis {
  const base: ImportAnalysis = {
    ok: false,
    delimiter: ",",
    columns: [],
    missingColumns: [],
    totalRows: 0,
    readyCount: 0,
    errorCount: 0,
    duplicateCount: 0,
    truncated: false,
    rows: [],
  };

  if (!text || text.trim() === "") {
    return { ...base, fileError: "The file is empty." };
  }
  const encoding = detectEncodingProblem(text);
  if (encoding) return { ...base, fileError: encoding };

  const delimiter = detectDelimiter(text);
  const records = parseDelimited(text, delimiter);
  if (records.length === 0) {
    return { ...base, delimiter, fileError: "No data rows were found — check the file has a header line and at least one question." };
  }

  const header = records[0].cells;
  const { logical, options: optionColumns } = mapColumns(header);

  const missingColumns: string[] = [];
  if (!logical.has("questionText")) missingColumns.push("question");
  if (optionColumns.length < 2) missingColumns.push("at least two options (A, B, …)");
  if (!logical.has("correct")) missingColumns.push("correct");
  if (!logical.has("subject")) missingColumns.push("subject");
  if (missingColumns.length > 0) {
    return {
      ...base,
      delimiter,
      missingColumns,
      fileError: `The file is missing required column(s): ${missingColumns.join(", ")}.`,
    };
  }

  const dataRecords = records.slice(1);
  if (dataRecords.length === 0) {
    return {
      ...base,
      delimiter,
      columns: [...logical.keys()],
      fileError: "No data rows were found — the file has a header but no questions yet.",
    };
  }

  const truncated = dataRecords.length > IMPORT_MAX_ROWS;
  const considered = truncated ? dataRecords.slice(0, IMPORT_MAX_ROWS) : dataRecords;

  const seenInFile = new Set<string>();
  const rows: ImportRowReport[] = considered.map((record) => {
    const raw = recordToRow(record, logical, optionColumns);
    const { input, errors } = buildRowInput(raw, catalogue);
    const key = questionDedupeKey(raw.questionText);

    let status: ImportRowStatus = "error";
    if (Object.keys(errors).length > 0) {
      status = "error";
    } else if (key && (existingQuestionKeys?.has(key) || seenInFile.has(key))) {
      status = "duplicate";
    } else {
      status = "ready";
    }
    if (key) seenInFile.add(key);

    return {
      line: record.line,
      questionText: raw.questionText || "(no question text)",
      status,
      errors,
      input: status === "ready" ? input : undefined,
    };
  });

  const readyCount = rows.filter((row) => row.status === "ready").length;
  const errorCount = rows.filter((row) => row.status === "error").length;
  const duplicateCount = rows.filter((row) => row.status === "duplicate").length;

  return {
    ok: true,
    delimiter: delimiter === "\t" ? "tab" : delimiter,
    columns: [...logical.keys()],
    missingColumns,
    totalRows: dataRecords.length,
    readyCount,
    errorCount,
    duplicateCount,
    truncated,
    rows,
  };
}

/**
 * The ready rows of an analysis, as the payloads the data layer writes. The
 * server calls this after re-analysing the raw text against its own catalogue,
 * so the ids it trusts were resolved server-side (never from the browser).
 */
export function readyRowPayloads(analysis: ImportAnalysis): { line: number; input: QuestionInput }[] {
  return analysis.rows
    .filter((row): row is ImportRowReport & { input: QuestionInput } => row.status === "ready" && !!row.input)
    .map((row) => ({ line: row.line, input: row.input }));
}

/**
 * A small template the import screen offers for download, so users match the
 * expected header exactly rather than guessing. Pure string building only.
 */
export const IMPORT_TEMPLATE_CSV = [
  "question,option_a,option_b,option_c,option_d,correct,subject,topic,category,difficulty,marks,explanation,learning_objective,provenance,source_label,source_year,license_notes",
  "What is the capital of France?,London,Paris,Berlin,Madrid,B,Mathematics,,WAEC,medium,1,Paris is the capital and largest city of France.,Identify world capitals,teacher_created,,",
].join("\n");
