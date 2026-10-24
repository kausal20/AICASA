# Product Requirements Document (PRD)

## AICTE Approval Workflow Automation, Compliance Monitoring & Alert Management Portal

**Version:** 1.0 · **Status:** Prototype specification · **Date:** 22 October 2026

## 1. Product summary

Build a secure, role-based web portal prototype that helps institutions and authorised AICTE personnel manage approval-related workflows, scrutiny deficiencies, EVC scheduling, time-bound undertakings, compliance evidence, prescribed-document validity, reminders, escalation and audit history in one connected system.

The product is a workflow and monitoring aid. It does **not** replace statutory scrutiny, physical/online inspections, regulatory interpretation or decisions reserved for competent authorities.

## 2. Problem statement

Approval-related work can involve multiple stages, institutions, regional teams, committees, deadlines and follow-ups. Without a unified view, it can be difficult to see the current stage, next responsible party, outstanding deficiency, EVC readiness, upcoming compliance date, expired document or escalation history.

The portal should make the state of each case visible, route work according to configured authorised rules, and ensure pending actions are assigned, reminded, escalated and recorded.

## 3. Product goals

1.  Demonstrate configurable routing across applicable approval stages.
2.  Give every case a clear status, owner/next actor, next action and applicable due date.
3.  Support deficiency return, correction and re-review loops.
4.  Track EVC readiness, scheduling and completion where required.
5.  Track applicable undertakings, compliance evidence, lease/document validity and renewal.
6.  Provide role-appropriate dashboards, alerts, reports and audit trails.
7.  Offer an AI-assisted pre-submission document checker that flags potential issues without guaranteeing approval.
8.  Use a coherent, accessible, professional interface suitable for frequent administrative work.

## 4. Out of scope

-   Automatically approving/rejecting applications or replacing competent officials.
-   Claiming direct integration with live AICTE systems without authorised access.
-   Claiming an uploaded document is authentic without an authorised verification source.
-   Continuous surveillance of campuses, daily attendance monitoring or general-purpose fraud detection.
-   Inventing regulatory requirements, universal timelines or application routes not configured from an authorised source.
-   Production handling of real sensitive institutional data in a student demo.

## 5. Users and permissions

### A. Institution user (shared College/University dashboard)

Institution-scoped account for an authorised representative. Can create and submit permitted applications, upload documents, run pre-checks, view deficiencies and case status, submit corrections, and manage obligations assigned to that institution. University-level access is only enabled when a legitimate authorised relationship and permission are configured. A university must not automatically see all affiliated institutions.

### B. AICTE officer

Works on assigned cases according to their role: scrutiny, deficiencies, EVC coordination, compliance verification or another configured responsibility. Can record observations, request corrections, verify evidence and perform permitted stage actions. Officers only see cases and actions they are authorised to access.

### C. AICTE administrator

Views authorised cross-region or national operational summaries, pendency, workload, overdue cases and reports. Manages approved workflow configuration, role assignment and escalation policy where permitted. This role does not bypass statutory decision authority.

## 6. Core capabilities

1.  **Rule-driven workflow routing:** configurable application type and stage path; enforce valid transitions and authorised actions.
2.  **Deficiency-to-resolution loop:** record issue, requirement/source, requested correction, responsible party, due date, submitted replacement and review outcome.
3.  **EVC scheduling and monitoring:** identify EVC-required cases after prerequisites; track readiness, scheduling, completion and delays.
4.  **Compliance and document lifecycle:** record undertakings, conditions, evidence, due dates, lease/other prescribed document expiry, renewal submission and verification.
5.  **Next-action and escalation engine:** identify next actor/action, calculate configured deadlines, notify and escalate overdue tasks according to rules.
6.  **Pendency analytics and audit trail:** stage ageing, regional/team workload, bottlenecks, alerts, submissions, verification, escalations and closure.
7.  **AI-assisted pre-submission document checker:** extract readable content; check configured fields, completeness, dates, consistency and legibility; explain possible defects and allow recheck after correction.

## 7. Main user journeys

### Institution journey

Sign in → view institution dashboard → create or open application → upload required documents → run pre-submission check → review warnings and correct issues → submit through the configured process → respond to formal deficiencies → track status and next action → submit compliance evidence/renewals when required.

### Officer journey

Sign in → view assigned queue → open case → review application and evidence → record observation or deficiency → return case if authorised → review correction → complete permitted stage action → route to next configured stage → manage EVC/compliance tasks → see deadlines and audit history.

### Administrator journey

Sign in → view operational dashboard → filter by region, stage, age, responsible team and status → identify bottlenecks/overdue work → inspect audit history → adjust authorised workflow or escalation configuration → generate reports.

## 8. Pre-submission checker requirements

-   Accept configured file types; validate file size/type and reject unsafe files.
-   Extract text via OCR where necessary and report extraction confidence or unreadable pages.
-   Run deterministic checks first (required fields, dates, identifiers, page presence where detectable).
-   Use AI only where it adds value, such as document classification or plain-language explanation of flagged issues.
-   Every flag must include the evidence or field that triggered it, the rule/check applied, and a recommended correction or manual-review instruction.
-   Statuses: `Passed checks`, `Potential issue`, `Unreadable / extraction failed`, `Manual review needed`, `Not checked`.
-   Never state "AICTE will not question this document" or guarantee approval.
-   A passed pre-check does not prove authenticity, legal sufficiency or compliance.
-   Formal submission and official review remain separate steps.

## 9. Required dashboards

### Institution

Applications summary; create application; application tracker; pre-submission checker; deficiencies and corrections; compliance calendar; document expiry/renewal; notifications; submission history.

### AICTE officer

Assigned cases; scrutiny queue; case review workspace; deficiency actions; EVC queue/schedule where authorised; compliance verification; upcoming/overdue actions; case timeline.

### AICTE administrator

National/region view as authorised; stage-wise pendency and ageing; workload; EVC status; undertaking/compliance summary; expiring/expired documents; escalations; reports; authorised workflow and user configuration; audit review.

## 10. Non-functional requirements

-   Role-based access control and institution/region scoping.
-   Secure authentication, private document storage and server-side permission checks.
-   Audit logs for important reads/actions where required, changes, submissions, verification, escalations and configuration changes.
-   Responsive layouts, keyboard accessibility, visible focus, contrast and reduced-motion support.
-   Reliable date/time handling with a documented timezone policy.
-   Clear loading, empty, error, success and partial-failure states.
-   Configurable rules and deadlines; version changes must be attributable and auditable.
-   Prototype data must be clearly labelled as synthetic/demo data.

## 11. Success criteria for the prototype

-   Demonstrate at least two configured application routes.
-   Demonstrate a return → correction → re-review loop.
-   Demonstrate EVC queueing and an approaching/overdue alert.
-   Demonstrate an undertaking or lease-document expiry and renewal workflow.
-   Demonstrate role-specific access and rejected unauthorised actions.
-   Show a complete case timeline from creation to closure.
-   Demonstrate document pre-check on sample documents with explainable flags.
-   Test that configured due dates and escalations are reproducible and not hardcoded to one demo case.

## 12. Assumptions and open questions

-   Exact APH rules, application categories, stages, role names and deadlines must be verified against authorised current guidance before production use.
-   The prototype will use synthetic or approved anonymised data.
-   Live AICTE integrations are not assumed; provide adapters/interfaces and clearly mark demo integrations.
-   A university dashboard is enabled only for explicitly authorised institutional relationships.
