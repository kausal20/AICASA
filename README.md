# AICASA

**AICTE Integrated Compliance and Approval System for Administration** — a full-stack prototype for
SIH26262 (*Integrated AICTE Approval Workflow Automation, Compliance Monitoring and Alert Management System*).

> **Prototype with synthetic data.** AICASA is a student prototype. It is not an official AICTE service, is not
> connected to any AICTE system, and nothing in it is an official decision or record. Every institution, person,
> case, document, route, deadline and rule shipped here is synthetic demonstration configuration and must be
> verified against the current Approval Process Handbook (APH) before any real use. The system never approves
> or rejects anything: scrutiny, expert visits and decisions stay with named officers.

The authoritative scope is the five specification files in this folder:
[PRD.md](PRD.md), [architecture.pdf](architecture.pdf), [design.pdf](design.pdf), [functions.pdf](functions.pdf),
[TECHNICAL_REQUIREMENTS.pdf](TECHNICAL_REQUIREMENTS.pdf).

---

## What is in the box

| Area | Implementation |
| --- | --- |
| Frontend | React 18 + TypeScript (strict), Vite, Tailwind, Radix primitives, Lucide, `motion/react`, React Router, TanStack Query, React Hook Form + Zod, Recharts, Sonner |
| Backend | Supabase: PostgreSQL, Auth, Row Level Security, private Storage, one Edge Function, `pg_cron` |
| Business logic | PostgreSQL functions (`SECURITY DEFINER`, each re-checks caller, role, region, state and configured rules) |
| Pre-check engine | Provider-independent TypeScript module shared by the Edge Function, the provisioning script and unit tests |
| Tests | Vitest: 48 database tests running the **real migrations** in PGlite (embedded Postgres) with RLS, plus 12 engine unit tests |

### Three dashboards, one app
* **Institution** (college / university): applications, wizard, documents & versions, pre-submission check,
  deficiencies & corrections, compliance obligations, document validity, notifications, profile.
* **AICTE officer**: assigned queue, scope-wide cases, scrutiny workspace (observations, deficiencies,
  return, configured transitions with reasons), correction reviews, EVC scheduling, compliance verification, tasks, escalations.
* **AICTE administrator**: scoped analytics (pendency, ageing, workload, EVC, compliance, validity, escalations),
  workflow route versions, alert rules, users & access, audit log, reports/CSV export, system & integration status.

The workspace is chosen from roles the database returns (`get_my_context`); a user with several roles can switch.

---

## Architecture and key decisions

```
Browser (React)  ──HTTPS──▶  PostgREST /rpc/*  ──▶  public.* SECURITY DEFINER functions ──▶ tables (RLS on)
                 ──────────▶  PostgREST views (security_invoker) — reads are filtered by RLS
                 ──────────▶  Storage (private bucket, RLS on storage.objects)
                 ──────────▶  Edge Function document-precheck ──service role──▶ complete_document_check()
pg_cron (every 30 min) ──▶ app.run_deadline_scan()  (idempotent reminders, escalations, renewal obligations)
```

* **No browser writes to tables.** `authenticated` has `SELECT` only (through RLS). Every mutation is an RPC
  that verifies identity, role, region scope, current state, optimistic `row_version` and configured
  prerequisites, then writes the change, the timeline event and the audit record **in one transaction**.
* **Rule-driven routing.** Routes are data: `workflow_definitions → workflow_definition_versions → stages / transitions`.
  Each transition declares source/destination, allowed role, required responsibility, whether a reason is
  mandatory, whether it records a decision, and prerequisites (`no_open_deficiencies`, `evc_completed`,
  `evc_satisfactory`, `required_documents`, `form_flag:<key>`, …). Unknown prerequisites fail closed.
  Automatic transitions fire only when their prerequisites hold. Each application stores the route version it
  started with; publishing a new version never changes existing cases.
* **Demo routes:** Scrutiny only · Scrutiny + EVC (EVC only when an intake increase is declared) ·
  EVC + SAC/SHC · EVC only.
* **Rejected transitions are recorded.** `perform_transition` returns `{ok:false, code, message}` instead of
  raising, so the attempt and its reason land in `audit_logs`.
* **Correction loop:** officer records deficiencies → returns case → institution uploads a new document
  version and responds → review task → officer marks *resolved / still deficient / needs clarification*.
  Uploading alone never resolves anything; every attempt and review stays on file.
* **Append-only history:** triggers block `UPDATE/DELETE` on `audit_logs`, `application_events`, EVC history,
  submissions, reviews, verifications and decisions; document versions are immutable.
* **Compliance:** obligation status is stored (awaiting → submitted → verified / correction required → closed);
  *upcoming / due soon / overdue* are computed from dates in `v_obligations`, so they never depend on a job
  having run. Verifying a recurring obligation creates exactly one next occurrence; verifying a renewal
  supersedes the old validity record.
* **Deadline scanner** (`app.run_deadline_scan`): evaluates every active, versioned rule against stage targets,
  deficiencies, EVC scheduling/sessions, obligations and document validity. Idempotency keys
  (`rule:entity:due:repeat`) make re-runs safe. Email is attempted only if an email integration is marked
  configured; otherwise each attempt is logged `skipped_unconfigured`.
* **Time:** all timestamps are `timestamptz` (UTC). Display is IST (`Asia/Kolkata`); date-only deadlines mean
  23:59:59 IST of that date.
* **University access** to an affiliated college is an explicit row in `institution_access_grants`, read-only,
  and can be switched off globally with the `feature.university_access` setting.
* **Pre-check honesty:** deterministic checks (type, size, duplicates by SHA-256, readability, configured
  fields, dates, academic-year consistency). Text is extracted from plain text and text-based PDFs; images
  are reported as *extraction failed* and their field checks as *not checked* because no OCR provider is
  configured. The readable-text ratio shown is a heuristic, labelled as such. No AI is called.
* Tables listed in the brief but merged deliberately: task assignment/history live in `tasks` + `audit_logs`;
  workflow configuration history is `workflow_definition_versions` + audit; reminder and escalation rules are one
  versioned `escalation_rules` table with `rule_kind`.

### Repository layout
```
src/app            providers + router            src/features/*   pages by domain
src/components     ui primitives, app shell       src/services     typed data access (RPC + views)
src/lib            supabase client, formatting, errors, CSV
supabase/migrations   schema, security/RLS, workflow engine, operations, admin/analytics, storage, hardening
supabase/seed.sql     demo configuration + demo provisioning functions
supabase/functions    document-precheck Edge Function + _shared/precheck.ts engine
scripts/              demo provisioning
tests/db              PGlite database tests (real migrations)   tests/unit  engine tests
```

---

## Setup

### 1. Install and configure
```bash
npm install
```
Copy `.env.example` to `.env.local` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (public values).
Never put the service-role key in a `VITE_` variable.

### 2. Database
Apply `supabase/migrations/*.sql` in order, then `supabase/seed.sql`
(`supabase db push` + `supabase db reset`/seed with the CLI, or the SQL editor). Deploy the Edge Function:
```bash
supabase functions deploy document-precheck
```
`pg_cron` is scheduled automatically when the extension is available; otherwise an administrator can use
**Escalations → Run deadline scan now**.

### 3. Demo accounts (controlled provisioning — there is no public sign-up)
With `SUPABASE_SERVICE_ROLE_KEY` and `DEMO_ACCOUNT_PASSWORD` (≥ 12 chars) in `.env.local`:
```bash
npm run provision:demo
```
This creates the auth users via the Admin API, grants their synthetic roles (`provision_demo_access`),
uploads synthetic PDFs to private storage, builds the demo cases through the **real workflow functions**
(`seed_demo_cases`), and runs genuine pre-checks. Without a service-role key, the same result is reached with
`scripts/demo-upload-as-users.mjs` (uploads as each institution user) plus running `seed_demo_cases(<uploads json>)`
in SQL — this is how the hosted demo below was provisioned.

| Email | Role and scope |
| --- | --- |
| `inst.nirmala@aicasa-demo.test` | Institution — Nirmala Institute of Technology (WR) |
| `inst.sahyadri@aicasa-demo.test` | Institution — Sahyadri College of Engineering (WR) |
| `univ.deccan@aicasa-demo.test` | Institution — Deccan Technical University (WR), read grant to Sahyadri |
| `inst.coromandel@aicasa-demo.test` | Institution — Coromandel Institute of Management (SR) |
| `officer.wr.scrutiny@aicasa-demo.test` | Officer WR — scrutiny |
| `officer.wr.evc@aicasa-demo.test` | Officer WR — EVC |
| `officer.wr.compliance@aicasa-demo.test` | Officer WR — compliance, decision, committee |
| `officer.sr@aicasa-demo.test` | Officer SR — all officer responsibilities |
| `admin.national@aicasa-demo.test` | National administrator |
| `admin.wr@aicasa-demo.test` | Regional administrator WR |

All demo accounts share `DEMO_ACCOUNT_PASSWORD` from your local `.env.local` (never committed).

The seeded scenario includes: a draft; a case returned for correction; a correction awaiting review (with the
earlier file version kept); an EVC awaiting scheduling and overdue; a scheduled EVC; an EVC held yesterday
awaiting its outcome; a case with the SAC/SHC committee after a satisfactory EVC; a case closed with a
recorded decision; an overdue undertaking; a verified recurring return; a lease expiring in 45 days with an
auto-created renewal obligation; an expired certificate with an escalation; and cases in two regions.
Case timelines are back-dated for ageing; audit rows keep their real time.

### 4. Run
```bash
npm run dev
```

---

## Verification

```bash
npm run typecheck   # tsc --noEmit (strict)
npm run lint        # eslint
npm test            # 60 tests: PGlite DB suite (migrations + seed + RLS) and engine unit tests
npm run build       # production build
```
The DB suite covers: route configuration and versioning; only-valid transitions; automatic progression;
route conditions; the full deficiency loop with version history; competent-officer decisions; optimistic
concurrency (second identical transition rejected); EVC queueing, scheduling, conflicts, completion rules and
cancellation; institution isolation; university grants (and the feature flag); officer/admin region scope;
no direct table writes; no self-promotion; regional admin limits; inactive accounts; append-only audit;
internal functions not callable; service-only check results; storage folder policies; obligations, evidence
never auto-verifying, due/overdue calculation, recurrence, renewal supersession, scanner idempotency,
configurable lead time, skipped-email logging and manual-scan permission.

---

## Integrations and limitations

| Integration | State |
| --- | --- |
| Email / SMS | **Unconfigured.** In-app notifications are real; email attempts are logged as skipped. A dispatcher for `pending` attempts is not implemented. |
| OCR / AI | **Unconfigured.** Images go to manual review; no document content leaves the platform. |
| AICTE portal | **Mock.** No live connection; synthetic data only. |
| Document authenticity verification | **Unconfigured.** Pre-check never implies authenticity. |
| Malware scanning | Not available on this stack; versions are stored with `scan_status = scanner_unavailable`. |

Known limitations: PDF text extraction handles simple text PDFs (uncompressed or Flate) and not CID-font or
scanned PDFs; reports export up to 5,000 rows client-side from RLS-filtered views (server-side generation for
larger sets is not implemented); login rate limiting relies on Supabase Auth defaults; Supabase advisor
"SECURITY DEFINER function executable by authenticated" warnings are intentional — those functions *are* the
API and enforce their own checks; enabling leaked-password protection is a project setting left to the owner.

## Statutory-terminology upgrade (Oct 2026)

- Wording follows the statutory vocabulary: EoA Dossiers, Regional Office (RO) Scrutiny Portal, Apex Bureau Monitoring Console, Institution Statutory Profile; status labels such as "Awaiting RO Scrutiny", "Deficiencies Flagged". "EoA Issued" appears only for an Extension of Approval dossier with a recorded approving decision.
- The earlier settings-based handbook check is replaced by the server-side **Deficiency Matrix** described below.
- **Correction cycle** (institution view): split-screen memo / amendment upload with a live countdown to the deadline recorded on the memo.
- **Immutability Event Stream** (admin dashboard): live tail of the append-only `audit_logs`; hashes shown are the stored SHA-256 of the document.

## Differentiation upgrade (migration `20261025000100_differentiation.sql`)

**Deficiency Matrix.** `deficiency_matrix(application_id)` evaluates, on the server and within the caller's RLS scope:
required form fields and their types, checklist documents, duplicate files (same SHA-256 among current versions), the latest
pre-check of each current version, and the active rules in `compliance_rules` that apply to the application type.
Results are `passed`, `potential_issue`, `failed_validation`, `extraction_failed`, `not_checked` or `manual_review`, each with the
input value, requirement, rule reference, source and explanation. A rule kind the engine does not support is reported as
`manual_review`; a figure the institution did not declare is `not_checked`. Numeric rules are evaluated only when the rule states
where it applies and its source. **The shipped numeric rules are synthetic demonstration values, not AICTE thresholds**, and are
labelled so in the UI. The matrix never changes a case and never rejects one. National administrators with `workflow_config`
publish or retire rules (versioned, audited) from *Alert rules → Deficiency Matrix rules*.

**Concurrent review tasks.** A route version may configure independent reviews on a scrutiny or committee stage
(`workflow_stage_reviews`, carried through `publish_workflow_version`). Entering the stage creates one `review_tasks` row per review,
assigned to the least-loaded officer holding that responsibility in the region. `start_review_task`, `complete_review_task`
(completed or returned, with a reason) and `reassign_review_task` (assignment responsibility) lock the case row and then the task,
check responsibility, region, assignee and `row_version`, and write append-only `review_task_history`, case events and audit rows.
The prerequisite `review_tasks_complete` blocks routing until every review of the current stage entry is completed. Only the demo
route `ROUTE_PARALLEL_SCRUTINY` (type `CHANGE_SITE`) uses it; the other routes are unchanged.

**EVC assignment checks.** `evc_assignment_check` explains, per panel member, why an assignment is eligible, blocked or needs manual
review: authorisation, declared conflicts of interest (`evc_conflict_declarations`), overlapping EVCs, recorded unavailability and
availability windows (`evc_availability`), and a workload guide from `system_settings.evc.assignment_policy` (demo policy).
`schedule_evc` enforces the same checks: declared conflicts (when the policy blocks them) and missing authorisation cannot be overridden;
overlaps and recorded unavailability need an override reason, stored in `evc_history` and the audit log. No external calendar, expert
registry or affiliation register is connected, so undeclared relationships cannot be detected.

**Version-controlled corrections.** Each memo records the document version on file when it was raised
(`deficiencies.affected_document_version_id`). A response to a memo about a document must attach a newer version of that document;
earlier versions stay preserved. `compare_document_versions` shows metadata changes and, only when both versions were read by the
pre-check with `extraction_status = succeeded`, the extracted fields side by side; otherwise it says why no content comparison is made.
An officer review resolves the memo; *still deficient* and *needs clarification* keep it open. A deadline left empty uses
`system_settings.deficiency.correction_period` (demo: 7 days); with no setting the server asks for a date.

**Existing projects.** After applying the migration, add the demo configuration from the end of `supabase/seed.sql`
(route E, `CHANGE_SITE`, `compliance_rules`, the two settings), then create the concurrent-review demo case with
`node scripts/demo-parallel-case.mjs` (signs in as the synthetic Sahyadri representative; no service-role key needed).
