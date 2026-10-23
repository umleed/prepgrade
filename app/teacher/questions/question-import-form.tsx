"use client";

import { useCallback, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Alert, Badge, Button, Card, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  analyseImport,
  detectEncodingProblem,
  validateFileSelection,
  IMPORT_MAX_ROWS,
  IMPORT_TEMPLATE_CSV,
  type ImportAnalysis,
  type ImportCatalogue,
  type ImportRowStatus,
} from "@/lib/question-import";
import { importQuestionsAction, type ImportCommitResult } from "./import-actions";

/**
 * Shared question-import form (prompt 34). A teacher/institution admin drops a
 * CSV or TSV exported from their spreadsheet, sees a row-level preview and
 * validation report BEFORE anything is saved, then imports the valid rows.
 *
 * The SAME pure contract (`analyseImport`) runs here in the browser for an
 * instant report and again on the server on commit — the client only ever sends
 * the raw file text, never resolved ids, so the preview is advisory and the
 * server stays authoritative about tenancy, references, and structure
 * (AGENTS.md §5, §6, §7).
 *
 * Against-bank duplicates are shown as "skipped on import" here rather than
 * pre-flagged, because the browser does not hold the bank's contents; the
 * server skips them at write time and reports the outcome.
 */
export function QuestionImportForm({
  subjects,
  topics,
  categories,
  afterImportHref,
  cancelHref,
}: {
  subjects: { id: string; name: string }[];
  topics: { id: string; name: string; subjectId: string }[];
  categories: { id: string; name: string }[];
  afterImportHref: string;
  cancelHref: string;
}) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState<string>("");
  const [text, setText] = useState<string>("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [commitResult, setCommitResult] = useState<ImportCommitResult | null>(null);

  const catalogue: ImportCatalogue = useMemo(
    () => ({ subjects, topics, categories }),
    [subjects, topics, categories],
  );

  // Client preview never knows the bank's contents, so no existingKeys here.
  const analysis: ImportAnalysis | null = useMemo(
    () => (text.trim() ? analyseImport(text, catalogue) : null),
    [text, catalogue],
  );

  const resetFile = useCallback(() => {
    setFileName("");
    setText("");
    setFileError(null);
    setCommitResult(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  function loadText(nextText: string, label: string) {
    const encoding = detectEncodingProblem(nextText);
    if (encoding) {
      setFileError(encoding);
      setText("");
      return;
    }
    setFileError(null);
    setText(nextText);
    setFileName(label);
    setCommitResult(null);
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      resetFile();
      return;
    }
    const selectionError = validateFileSelection(file.name, file.type, file.size);
    if (selectionError) {
      setFileError(selectionError);
      setText("");
      setFileName(file.name);
      setCommitResult(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => loadText(String(reader.result ?? ""), file.name);
    reader.onerror = () => setFileError("The file could not be read. Try re-exporting it as CSV (UTF-8).");
    reader.readAsText(file);
  }

  function downloadTemplate() {
    const blob = new Blob([IMPORT_TEMPLATE_CSV], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "prepgrade-question-template.csv";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  async function handleImport() {
    if (submitting || !analysis || analysis.readyCount === 0) return;
    setSubmitting(true);
    setCommitResult(null);
    try {
      const result = await importQuestionsAction(text);
      setCommitResult(result);
      if (result.ok) {
        router.refresh();
      }
    } catch {
      setCommitResult({ ok: false, message: "Something went wrong while importing. Please try again." });
    } finally {
      setSubmitting(false);
    }
  }

  const readyCount = analysis?.readyCount ?? 0;

  return (
    <div className="flex flex-col gap-5">
      {/* Commit outcome — the terminal, authoritative report after a save. */}
      {commitResult ? (
        commitResult.ok ? (
          <Alert variant="success" title="Import finished">
            <p>
              {commitResult.imported} question{commitResult.imported === 1 ? "" : "s"} imported
              {commitResult.skipped.length > 0
                ? `, ${commitResult.skipped.length} row${commitResult.skipped.length === 1 ? "" : "s"} skipped.`
                : "."}
            </p>
            {commitResult.skipped.length > 0 ? (
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-ink-muted">
                {commitResult.skipped.slice(0, 10).map((row) => (
                  <li key={row.line}>
                    <span className="font-medium text-ink">Line {row.line}:</span> {row.reason}
                  </li>
                ))}
              </ul>
            ) : null}
            <Link href={afterImportHref} className="mt-3 inline-block font-medium underline">
              Back to the question bank
            </Link>
          </Alert>
        ) : (
          <Alert variant="danger" title="Import could not be completed">
            {commitResult.message}
          </Alert>
        )
      ) : null}

      {/* 1. Choose a file */}
      <Card>
        <div className="flex flex-col gap-4 p-6">
          <div>
            <h2 className="text-base font-semibold text-ink">1. Choose a file</h2>
            <p className="mt-0.5 text-sm text-ink-muted">
              Export your questions from a spreadsheet as CSV (UTF-8) or TSV, then
              select it here. Nothing is saved until you preview and confirm.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileInputRef}
              id="import-file"
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
              onChange={handleFile}
              className="block w-full max-w-sm cursor-pointer rounded-field border border-border bg-surface p-2 text-sm text-ink file:mr-3 file:rounded-field file:border-0 file:bg-brand-50 file:px-3 file:py-1.5 file:text-brand-700"
            />
            <Button type="button" variant="secondary" size="sm" onClick={downloadTemplate}>
              Download template
            </Button>
            {fileName ? (
              <Button type="button" variant="ghost" size="sm" onClick={resetFile}>
                Clear
              </Button>
            ) : null}
          </div>

          {fileError ? (
            <p className="text-sm text-danger-strong" role="alert">
              {fileError}
            </p>
          ) : null}

          <details className="rounded-field border border-border bg-surface-muted p-3">
            <summary className="cursor-pointer text-sm font-medium text-ink">
              Or paste rows directly
            </summary>
            <textarea
              aria-label="Paste CSV or TSV content"
              value={text}
              onChange={(e) => loadText(e.target.value, "Pasted text")}
              rows={5}
              spellCheck={false}
              className="mt-3 w-full rounded-field border border-border bg-surface p-3 font-mono text-xs text-ink focus-visible:outline-none"
              placeholder={"question,option_a,option_b,correct,subject\nWhat is 2 + 2?,3,4,B,Mathematics"}
            />
          </details>

          <FormatHelp />
        </div>
      </Card>

      {/* 2. Preview & validation report */}
      {analysis ? (
        analysis.ok ? (
          <PreviewReport
            analysis={analysis}
            readyCount={readyCount}
            submitting={submitting}
            onImport={handleImport}
          />
        ) : (
          <Card>
            <div className="p-6">
              <Alert variant="warning" title="This file could not be previewed">
                {analysis.fileError}
              </Alert>
            </div>
          </Card>
        )
      ) : (
        <Card>
          <div className="p-6">
            <p className="text-sm text-ink-muted">
              {fileName
                ? "Select a file above to see a preview and row-by-row checks."
                : "Your preview and validation report will appear here once you choose a file."}
            </p>
          </div>
        </Card>
      )}

      <div className="flex">
        <Link href={cancelHref}>
          <Button type="button" variant="ghost" size="sm">
            Cancel
          </Button>
        </Link>
      </div>
    </div>
  );
}

/** Column vocabulary + example, shown until the user has a file in hand. */
function FormatHelp() {
  return (
    <div className="rounded-field border border-border bg-surface-muted p-4 text-sm text-ink-muted">
      <p className="font-medium text-ink">Expected columns</p>
      <p className="mt-1">
        Required: <span className="font-mono text-2xs">question</span>,{" "}
        <span className="font-mono text-2xs">option_a</span>,{" "}
        <span className="font-mono text-2xs">option_b</span> (up to{" "}
        <span className="font-mono text-2xs">option_h</span>),{" "}
        <span className="font-mono text-2xs">correct</span> (an option letter like{" "}
        <span className="font-mono text-2xs">B</span>, or the exact option text),{" "}
        <span className="font-mono text-2xs">subject</span> (must match a subject in your catalogue).
      </p>
      <p className="mt-1">
        Optional: <span className="font-mono text-2xs">topic</span>,{" "}
        <span className="font-mono text-2xs">category</span>,{" "}
        <span className="font-mono text-2xs">difficulty</span>,{" "}
        <span className="font-mono text-2xs">marks</span>,{" "}
        <span className="font-mono text-2xs">explanation</span>,{" "}
        <span className="font-mono text-2xs">learning_objective</span>, and the source &amp;
        licensing columns <span className="font-mono text-2xs">provenance</span>,{" "}
        <span className="font-mono text-2xs">source_label</span>,{" "}
        <span className="font-mono text-2xs">source_year</span>,{" "}
        <span className="font-mono text-2xs">license_notes</span>.
      </p>
    </div>
  );
}

const STATUS_TONE: Record<ImportRowStatus, "success" | "danger" | "warning"> = {
  ready: "success",
  error: "danger",
  duplicate: "warning",
};

const STATUS_LABEL: Record<ImportRowStatus, string> = {
  ready: "Ready",
  error: "Needs fixing",
  duplicate: "Duplicate",
};

/** Preview counts + the row table with per-row messages. */
function PreviewReport({
  analysis,
  readyCount,
  submitting,
  onImport,
}: {
  analysis: ImportAnalysis;
  readyCount: number;
  submitting: boolean;
  onImport: () => void;
}) {
  // Keep the DOM light for very large files; counts still cover every row.
  const shownRows = analysis.rows.slice(0, 200);

  return (
    <Card>
      <div className="flex flex-col gap-4 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-ink">2. Preview &amp; check</h2>
            <p className="mt-0.5 text-sm text-ink-muted">
              {analysis.totalRows.toLocaleString()} row{analysis.totalRows === 1 ? "" : "s"} read
              {analysis.delimiter !== "," ? ` (delimited by ${analysis.delimiter})` : ""}.
              Fix any highlighted rows before importing.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge tone="success">{readyCount} ready</Badge>
            {analysis.errorCount > 0 ? <Badge tone="danger">{analysis.errorCount} with issues</Badge> : null}
            {analysis.duplicateCount > 0 ? (
              <Badge tone="warning">{analysis.duplicateCount} duplicate in file</Badge>
            ) : null}
          </div>
        </div>

        {analysis.truncated ? (
          <Alert variant="warning" title="File larger than one import">
            Only the first {IMPORT_MAX_ROWS.toLocaleString()} rows were read. Import the rest in a
            second file.
          </Alert>
        ) : null}

        <div className="overflow-x-auto rounded-field border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">Line</TableHead>
                <TableHead>Question</TableHead>
                <TableHead className="w-32">Status</TableHead>
                <TableHead>Issues</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shownRows.map((row) => {
                const messages = Object.values(row.errors).filter(Boolean) as string[];
                return (
                  <TableRow key={row.line}>
                    <TableCell className="align-top text-ink-muted">{row.line}</TableCell>
                    <TableCell className="align-top">
                      <span className="line-clamp-2 max-w-md font-medium text-ink">
                        {row.questionText}
                      </span>
                    </TableCell>
                    <TableCell className="align-top">
                      <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>
                    </TableCell>
                    <TableCell className="align-top">
                      {messages.length > 0 ? (
                        <ul className="list-disc space-y-0.5 pl-4 text-sm text-danger-strong">
                          {messages.map((message) => (
                            <li key={message}>{message}</li>
                          ))}
                        </ul>
                      ) : row.status === "duplicate" ? (
                        <p className="text-sm text-warning-strong">
                          Repeats a question earlier in this file — later copies are skipped.
                        </p>
                      ) : (
                        <p className="text-sm text-ink-subtle">Looks good.</p>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        {analysis.rows.length > shownRows.length ? (
          <p className={cn("text-2xs text-ink-subtle")}>
            Showing the first {shownRows.length} of {analysis.rows.length} rows.
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="primary" size="md" onClick={onImport} disabled={readyCount === 0 || submitting}>
            {submitting
              ? "Importing…"
              : `Import ${readyCount} question${readyCount === 1 ? "" : "s"}`}
          </Button>
          {readyCount === 0 ? (
            <span className="text-sm text-ink-muted">Fix the highlighted rows to enable import.</span>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
