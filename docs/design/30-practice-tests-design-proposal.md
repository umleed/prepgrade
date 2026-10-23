# Practice Tests and Weak-Topic Practice — Design Proposal (Later-Phase Feature)

> **Status: non-functional proposal. Nothing in this document is implemented.**
> Scope decision (prompt 30): a practice experience is **not part of the
> approved MVP product scope**, so this task delivers a design proposal and
> identifies the feature as a **later phase**, to be built (if approved) under
> prompt 47 — "Future Feature: Student Practice and Recommendations" — after
> the core assigned-assessment workflow has proven, reliable usage.

## 1. Why this is deferred, not built

- `AGENTS.md §4 (Not MVP by default)` excludes adaptive practice and complex
  recommendation engines from MVP unless a separate approved task changes
  scope. Document 7 prioritises core assigned assessments for the MVP.
- Prompt 30's Implementation Notes forbid fabricating recommendation history;
  the recommendation half of this feature therefore depends on real,
  accumulated attempt data that a pilot has not yet produced.
- Prompt 29 (`lib/student-performance.ts`) deliberately ships *measured*
  strong/focus areas and refuses to call them a diagnosis. Turning "focus
  areas" into "practice recommendations" is exactly the step that must wait
  for product-owner approval so the honesty boundary is not quietly crossed.
- The UI already reserves the slot: the student sidebar carries a disabled
  "Practice Tests" item (`components/student/student-sidebar.tsx`,
  `href: null`), and `app/student/layout.tsx` documents that practice will
  mount under the same shell when it ships. No route, table, or API for
  practice exists, and none is added by this proposal.

## 2. What already exists that a future build reuses

Everything needed to *browse* and *base recommendations on measured data* is
already in place; the missing pieces are the practice session model and the
separation guarantees.

| Need | Existing foundation |
| --- | --- |
| Browse facets: exam category, subject, topic, difficulty, year/source | `questions` columns `exam_category_id`, `subject_id`, `topic_id`, `difficulty ('easy','medium','hard')`, `source_label`, `source_year` (migration `0006_questions.sql`), with catalogue-consistency triggers |
| Legally usable content only | `questions.provenance IN ('teacher_created','licensed')` + `license_notes`; `status = 'active'` filter. Prompt 34 (import provenance) extends this later |
| Measured per-topic accuracy (recommendation basis) | `computeTopicPerformance()` in `lib/analytics.ts`; student-scoped wrapper and sample-size honesty bands (`sampleConfidence`, `isLowSample`, `MIN_QUESTIONS_PER_AREA_FOR_COMPARISON`) in `lib/student-performance.ts` |
| Per-question correctness facts | `exam_attempt_answers` + server-side grading (`gradeObjectiveAnswers`, `isCorrectAnswer` in `lib/grading.ts`) |
| Attempt lifecycle pattern to mirror | `exam_attempts` state machine (`in_progress → submitted / expired`), server-stamped `started_at`/`expires_at`, idempotent-start UNIQUE anchor, tenant-validation triggers (migration `0013_exam_attempts.sql`) |
| Question snapshotting discipline | `exam_question_snapshots` (migration `0011`) — the pattern for freezing what was served |
| Role routing and the mount point | `requireRole(["STUDENT"], …)` in `app/student/layout.tsx`; sidebar item waiting to be enabled |
| CBT-style answering UI conventions | the exam interface under `app/exam/[examId]` (prompt 22) as a visual/interaction reference — reuse patterns, not the graded delivery code path |

## 3. Proposed UX (informational only)

Routes mount under the existing student shell (`/student/practice…`):

1. **Practice home** — browse/filter questions and suggested sets by exam
   category, subject, topic, difficulty, and year/source where available.
   Every set shows question count, expected duration, and provenance
   ("teacher-created" / licensed source label) before start.
2. **Weak-topic suggestions** (only when real data supports them) — a card
   ranking the student's *measured* lowest-accuracy topics from released
   results, each with an explicit basis line ("Based on X questions across
   Y released results") and the existing sample-confidence caveat. Below the
   `MIN_QUESTIONS_PER_AREA_FOR_COMPARISON` threshold no suggestion fires —
   the empty state says there is not enough recorded performance yet.
3. **Practice player** — start/finish states are explicit; timing is
   advisory, not exam-strict; answers save progressively using the same
   autosave/recovery conventions as the CBT interface.
4. **Practice summary** — score and per-question review shown immediately
   (practice is formative; answer-key release rules for graded exams do not
   apply once the session is complete).
5. **Practice history** — the student's own past sessions, clearly labelled
   as practice and visually/structurally separated from My Results.

## 4. Proposed data model (sketch for a future migration; not applied)

Practice data gets its **own tables** so it can never leak into graded
metrics. The formal naming below follows the repo's migration conventions
(header rationale, `IF NOT EXISTS`, CHECK constraints, tenant-validation
triggers, updated_at trigger):

- `practice_sessions` — id, institution_id, student_id, config (filters /
  topic ids / question count), status `in_progress | completed | abandoned`,
  server-stamped `started_at`, advisory target duration, optional
  `completed_at`, `basis` (JSON describing the recommendation that produced
  the session, when suggested — never fabricated).
- `practice_session_questions` — frozen per-session question snapshot
  (question_id + snapshot of options/correct index), display order, mirroring
  the `exam_question_snapshots` discipline so history stays stable.
- `practice_session_answers` — session question id, selected option,
  server-computed `is_correct` (never client-supplied).

Deliberately **absent**: any FK or row linking practice into `exams`,
`exam_attempts`, `exam_results`, or the analytics input rows
(`AnalyticsResultRow`). Practice sessions are institution-scoped like
everything else, validated by the same "FK proves existence, not tenancy"
trigger pattern.

## 5. Separation from official assessments (hard requirement)

- Practice results are tracked separately and are **not** counted in class
  analytics, institution analytics, student performance trends, results
  lists, or any pass/statistic denominator — the data layer feeding
  `lib/analytics.ts` reads graded `exam_results` only, and practice tables
  stay outside those queries. Combining them would require explicit product-
  owner approval (prompt 30 requirement; not assumed here).
- Practice sessions consume the question bank but create no `exam_results`
  rows and no `exam_attempts` rows; the official attempt state machine and
  its idempotency/timing rules stay untouched.
- Server grading conventions carry over verbatim: never trust a client-
  supplied score or correct flag; correctness is computed server-side from
  the frozen snapshot.

## 6. Authorization and integrity

- Server-side `requireRole(["STUDENT"])` on every practice route and action;
  RLS/tenant-validation triggers as with every prior migration — the UI
  disabled-link is presentation, not protection.
- Question reads are tenant-scoped: a student sees only questions visible to
  their institution (own-bank `active` questions; a shared/platform pool is
  a future product decision, not implied).
- `institution_id` and `student_id` are always server-derived from the
  session's auth context; no client-supplied tenant ids, no answer keys in
  any student-facing payload before session completion.
- Start is idempotent using a UNIQUE anchor like `exam_attempts` does
  (one live session per student per config race), and expiry/cleanup of
  `in_progress` sessions is defined before launch — "abandoned" is only
  claimed once something can honestly produce it.

## 7. Test plan for the future implementation

Following the repo's Node built-in-test-runner convention (`tests/<area>/`):

- `tests/practice/` unit tests: pure session-state transitions, recommendation
  basis computation (including the below-threshold "no suggestion" path),
  separation invariants (practice rows never appear in analytics inputs).
- Data-layer tests: tenant isolation (institution B cannot read institution
  A's questions or sessions), idempotent start, server-side correctness.
- SQL readiness harness: constraints and triggers from the future migration.
- Boundary/security tests mirroring the existing `tests/attempts/` patterns.

## 8. Preconditions before building (entry criteria)

1. Product owner approves practice as in-scope for a named phase (this
   document does not do that; prompt 47 is the planning home).
2. The assigned-assessment MVP loop (create → deliver → grade → analyse) has
   real institutional usage with reliable data.
3. Enough genuine attempt history exists for weak-topic suggestions to pass
   the sample-confidence thresholds — otherwise launch browse-only practice
   and omit suggestions entirely rather than show fabricated ones.
4. Question-bank volume per tenant is sufficient to make filtered practice
   sets viable, and provenance/licensing review (prompt 34) is in place for
   anything non-teacher-created.

## 9. Open decisions for the product owner

- Should practice results ever feed official metrics? (Default per this
  proposal: no, separate forever, opt-in per institution if approved.)
- Per-question feedback timing during a session: immediate, or at finish?
- Are practice sets drawn only from the tenant bank, or from a licensed
  shared JAMB/WAEC/NECO pool ( contingent on prompt 34 provenance work)?
- Do teachers/institution admins see student practice activity? (Privacy
  minimisation argues default no.)
- Session sizing defaults (count, advisory duration) and whether students
  can self-configure.

## 10. Explicit non-goals

No adaptive difficulty, no AI question generation, no mastery engine
(prompts 44–45, future), no gamification, no mobile app, no changes to any
existing graded-exam flow. This feature must not silently expand PrepGrade
beyond Create → Deliver → Grade → Analyse → Improve.
