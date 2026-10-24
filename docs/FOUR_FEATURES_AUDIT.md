# Four-feature audit (Deficiency Matrix, concurrent reviews, EVC checks, version-controlled corrections)

AICASA is a student prototype with synthetic data and no live AICTE connection. Nothing here claims otherwise.
Date of audit: 24 Oct 2026. Evidence levels used throughout: **executed** (I ran it and saw the result), **inspected** (read only),
**not verified**.

## A. Executive summary

| Feature | Verdict | Why |
|---|---|---|
| 1. Deficiency Matrix | **PASS (local)** after fixes | 4 confirmed defects reproduced and fixed; boundary, malformed, bypass and isolation tests executed. Fixes are **not yet on hosted Supabase**. |
| 2. Concurrent review tasks | **PARTIAL** | Gating, RBAC, republish, reassignment, return/recovery executed and passing. **Race safety is NOT proven**: the local engine is single-connection. |
| 3. EVC checks and scheduling | **PARTIAL** | RBAC, overrides, region scoping, rollback executed. A real race (two cases booking one officer) was found and a lock added, but it cannot be demonstrated locally. Availability is "unknown" by default (shown, not hidden). |
| 4. Version-controlled corrections | **PASS (local)** after fixes, with one **documented limitation** | Same-content re-upload, wrong document, checklist validation, deadline change, unproven links fixed/tested. File hash is browser-supplied (see D-6). |

Overall: not ready to call "verified in production". Fixes live in migration `20261025000200_audit_fixes.sql`, **not applied to hosted
Supabase and not deployed** (needs your authorisation).

## E. Test evidence (all executed on this machine)

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npx vitest run` (before changes, baseline) | 6 files, **80 passed** (matches the earlier report) |
| `npx vitest run` (after changes) | 7 files, **115 passed** (103 database + 12 unit) |
| `npm run build` | exit 0 (tsc + vite build) |
| Pre-fix reproduction: `tests/db/audit.test.ts` with the fix migration moved aside | **17 of 35 failed**, 18 passed (this is how each defect below was reproduced) |

Hosted Supabase checks (read-only SQL through the project connector): migration list, RLS flags, table grants, function grants,
`search_path` settings, storage policies, backfill rows, function-definition hashes. Vercel: `vercel ls` (read-only).
Not executed: any browser run in this audit (browser flows were exercised in the previous session, not re-run here), any concurrent-session test, any
write to hosted data, any deploy.

## B. Requirements traceability (condensed)

### Feature 1 – Deficiency Matrix
| Requirement | Implementation | Test | Result |
|---|---|---|---|
| Server-side evaluation; client cannot fabricate | `deficiency_matrix()`; no write grants on `compliance_rules`; `complete_document_check` service-role only | audit: "browser roles cannot write rules or fabricate…" | pass |
| Min/max/ratio/consistency boundaries | matrix section 5 | audit: boundary, ratio, consistency tests | pass after D-1,D-2 |
| NaN/negative/malformed/zero denominator | `app.try_numeric`, matrix rule branches | audit: "NaN, Infinity, malformed…" | pass after D-1,D-2 |
| Unsupported rule → manual review | `else` branch | differentiation test | pass |
| Input, requirement, rule version, source shown; synthetic labelled | row columns, `is_synthetic` | audit: "every rule row names…" | pass |
| Publish/retire permissions, history | `publish_compliance_rule`, `retire_compliance_rule` | audit publication tests | pass after D-3 |
| Rule change on existing cases | evaluated live against the *active* rule version; old versions kept | audit: "a rule change changes later evaluations…" | pass (behaviour: results are recomputed, not frozen) |
| Isolation across institution/region | `can_read_application` | audit: "invisible across institutions and regions" | pass |
| Extraction failure never a pass | precheck section | audit: "a failed pre-check…" | pass |

### Feature 2 – Concurrent reviews
| Requirement | Evidence | Result |
|---|---|---|
| Created only when the route version configures them | audit: only CHANGE_SITE cases have tasks | pass |
| One complete + one pending stays blocked; returned stays blocked | differentiation + audit | pass |
| Unauthorised/other-region/impersonation refused | audit + differentiation | pass |
| Duplicate rows / direct table writes | audit: unique index, no write grants | pass |
| Republish while in progress | audit: case keeps its version, tasks and gate; new case has no tasks | pass |
| Stale page, unavailable reviewer, recovery | audit (deactivated assignee, reassign, stale version) | pass |
| Returned task has a path | audit: returned → resume → complete | pass |
| History with actor and reason | audit: 8-step history, all actors set | pass |
| Concurrent completion/conflicting sessions | **not proven** (sequential tests only) | UNVERIFIED |
| "Override" of a task | no override action exists; only reassignment | gap, noted |

### Feature 3 – EVC
| Requirement | Evidence | Result |
|---|---|---|
| Scheduling re-checks server-side | `schedule_evc` calls `app.evc_check` itself; UI result is not trusted | pass |
| Conflict not overridable; overlap/unavailable overridable with reason, audited | differentiation + audit | pass |
| Other region / institution / non-EVC staff refused | audit | pass |
| Failed attempt leaves nothing behind | audit: history count and row_version unchanged | pass |
| Back-to-back slots allowed, real overlap blocked | audit | pass |
| Availability/conflict changes affect later checks | audit | pass |
| Simultaneous double booking | advisory locks added (D-4); **only a static check** exists | UNVERIFIED |
| Unknown availability not hidden | shown as a "Note" and "Some checks could not be made automatically" next to "Eligible" | by design, see risks |
| EVC report upload | **does not exist**; only a typed completion summary | accurately described |

### Feature 4 – Corrections
| Requirement | Evidence | Result |
|---|---|---|
| Memo links the version on file when raised | trigger + basis column; audit test | pass for new memos |
| Historical backfill | **not provable** (D-5) | marked `inferred_unverified` |
| Newer version required; same content under another name refused | audit | pass after D-6 |
| Wrong/unrelated document refused | audit | pass |
| Old versions immutable | trigger, no grants, storage has no update/delete policy (hosted verified) | pass |
| No "resolved" on upload; only officer review resolves | audit | pass |
| Deadline from configuration; authorised change; expiry | audit | pass after D-7; expiry is **advisory** (late answers accepted, characterised) |
| Direct status/reference writes refused | audit | pass |
| Extraction failure → no content comparison | audit | pass |
| Concurrent submissions | sequential only | UNVERIFIED |

## C. Defect register

Severity reflects a prototype context. All were reproduced before fixing (17 audit tests failed against the unfixed migration).

| ID | Sev. | Where | Behaviour found | Fix | Regression test |
|---|---|---|---|---|---|
| D-1 | **High** | `app.try_numeric`, `deficiency_matrix` min/max | A declared value of `NaN` **passed** a minimum rule (Postgres orders NaN above every number). Negative and non-numeric values were not flagged (non-numeric showed "not declared"). | `try_numeric` rejects NaN/Infinity; matrix reports non-numeric and negative as `failed_validation` | audit "NaN, Infinity, malformed…" |
| D-2 | Medium | matrix ratio / consistency | Zero or malformed denominators were reported "not declared"; a negative numerator passed the ratio. | explicit `failed_validation` with an explanation | audit ratio + consistency tests |
| D-3 | Medium | `publish_compliance_rule` | Negative and zero ratio thresholds, `NaN` thresholds accepted. | validation added | audit "rejects negative, zero-ratio…" |
| D-4 | High (latent) | `schedule_evc` | Validation and save were not serialised per officer: two cases booking the same officer in the same moment could both pass the overlap check. | per-officer `pg_advisory_xact_lock` in a fixed order | static test only; race **not reproduced** (no concurrent engine) |
| D-5 | Medium | hosted backfill of `affected_document_version_id` | Linked by timestamp comparison. For `DEMO-WR-2026-01005` both versions share an identical timestamp, so the link to version 1 is **unproven**. | new `affected_version_basis` column; existing links marked `inferred_unverified`; such memos force "attach the latest version"; UI says the earlier version is inferred | audit "an unproven link is reported…" |
| D-6 | Medium | `submit_deficiency_correction` | Same content under a different filename satisfied a "new version" rule. | refuse when the new version's SHA-256 equals an earlier version | audit "same content re-uploaded…" |
| D-7 | Medium | missing capability | No way to change a memo deadline; default deadline used the UTC date. | `change_deficiency_deadline` (officer, reason, version check, audited, notifies institution); date uses display timezone. **API/service only, no UI button.** | audit deadlines test |
| D-8 | Low | `raise_deficiency` | Accepted a document type not on the checklist (the live demo memo on `DEMO-WR-2026-01010` uses `land_lease_deed`, which is not on the EOA checklist). | checklist validation for new memos. **The existing hosted memo was not changed.** | audit "checklist" test |
| D-9 | Medium | `record/withdraw_evc_availability`, `declare/withdraw_evc_conflict` | The assignment responsibility was not region-scoped: a regional administrator could manage another region's officers. | `app.can_manage_officer` | audit "region-scoped…" |
| D-10 | Low | Edge function `document-precheck` | Used the browser-supplied hash without checking it against the stored bytes. | recomputes from the file and adds a "fingerprint mismatch" finding. **Edge function not redeployed.** | none (Deno function, not covered by the test runner) |

**Confirmed limitation, not fixed (D-6b, Medium):** `sha256` is computed in the browser and sent to `register_document_version`. A hostile client can omit
or falsify it, which defeats duplicate detection and the same-content rule. Only 4 of 31 hosted versions have a hash at all (seeded versions have none).
A real fix is server-side hashing at registration (Edge Function or storage metadata). D-10 detects mismatches only after a pre-check run.

**Suspected risks, not confirmed**
- Unknown availability yields an "eligible" status with a note when the policy does not require availability windows.
- Matrix results are recomputed live, so a rule change alters what older cases display; no historical snapshot is stored.
- `perform_transition`-style rejections write audit rows, but review-task rejections (e.g. wrong region) raise errors without an audit row.
- Notification side effects for the new functions were not tested.
- A hosted memo (`DEMO-WR-2026-01010`) has a document type with no document; its correction path works but is unusual.

## D. Security report

Executed (local engine, real migrations): signed-in roles have SELECT only on the six new tables and RLS is on (all six);
internal helpers are not executable by signed-in users; no public function is executable by `anon`; every SECURITY DEFINER function
in `public` and `app` has a pinned `search_path`; direct inserts/updates/deletes on rules, review tasks and history, memos, submissions and
document versions are refused; the append-only triggers fire; cross-institution and cross-region matrix reads are refused; wrong-role and
wrong-region officers are refused on review, EVC, deadline and review-of-correction actions.

Executed (hosted, read-only): RLS enabled and SELECT-only grants on the new tables and on `deficiencies`, `document_versions`, `audit_logs`;
the new internal helpers are not executable by `anon`/`authenticated`; the new functions have `search_path=public, app`; storage has only
read and upload policies (no update/delete), so stored versions cannot be removed through the API.

Advisor note: Supabase lists the public RPCs as "executable by signed-in users". That is how this app works by design; I investigated the
specific functions listed for the four features and each checks role, region, ownership and state itself (tests above). Leaked-password
protection is off in the hosted auth settings (not changed).

Not tested: signed-URL behaviour end to end, SQL injection beyond reading the new functions (no dynamic SQL is used), cross-tenant storage reads
through the storage API, rate limiting, and secrets handling in the deployed environment (only inspected that the service-role key is not in `src`
and `.env.local` is git-ignored).

## F. Deployment comparison

- **Local:** all items above.
- **Hosted Supabase:** migration `20261025000100` applied (history name `differentiation`, version 20261024092617). The earlier handbook migration
  `20261024000100` was never in the hosted history (applied as plain SQL, later superseded). 23 of 25 new/changed function definitions have **identical
  hashes** to a fresh build of the repository; the two that differ (`deficiency_matrix`, `withdraw_evc_conflict`) differ only because I sent them
  without SQL comments (inferred from the text I sent; not separately diffed). Rules (5 active), the two settings and the demo route are present.
  The hosted copy has the backfill but **lacks** every fix in `20261025000200`.
- **Vercel:** latest production deployments are about 2 hours old and were built from the working directory, not from a git commit, so I cannot
  name the commit. They predate the new UI work. The repository itself has **no commit** for any of this work (all untracked/modified).
- **Compatibility risk:** the old Vercel frontend calls `schedule_evc` with 8 arguments; the hosted function now has 9 with defaults, so it still works.
  The new frontend against the hosted database works but shows the "inferred" note on all comparisons until the fix migration is applied.
- Other working-tree changes not made by me were present (`package.json`, `package-lock.json`, `Button.tsx`, `LandingPage.tsx`, a Skiper UI component):
  I did not touch or review them.

## G. SIH26262 readiness

The four features work together in the code paths I tested individually and the earlier session ran one live case through the UI, but **I did not run a single
case through all four features end to end in this audit**. Routing, deficiency correction with preserved versions, EVC scheduling with recorded overrides,
and an append-only audit trail are implemented and tested locally. Post-approval compliance tracking pre-dates these features and was only regression-tested
(existing 80 tests). Not implemented: EVC report document upload, live AICTE integration, statutory thresholds (all numeric rules are synthetic),
server-side file hashing, UI for changing deadlines.

## H. Recommendation (priority order)

Essential
1. Authorise applying `20261025000200_audit_fixes.sql` to hosted Supabase and redeploying the `document-precheck` Edge Function (D-1 to D-10).
2. Commit the work and deploy the current frontend to Vercel so the live site matches the database; then re-run the browser flows against it.
3. Run the concurrency tests on a real Postgres (or a Supabase branch) with two connections: double scheduling, double task completion, double correction.
4. Decide on server-side hashing for uploads (closes D-6b).
5. Fix or replace the hosted demo memo on `DEMO-WR-2026-01010` and re-link or mark the two backfilled memos.

Optional: add a UI for deadline changes; snapshot matrix results at submission; audit-log rejected review actions; make unknown availability a manual-review status.
