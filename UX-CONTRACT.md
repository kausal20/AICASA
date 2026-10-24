# UX Contract

## Product context
Institutions submit and correct applications; officers review assigned work; administrators monitor authorised regions. English interface, Indian approval-management context, IST dates. Accessibility target is WCAG 2.2 AA; conformance is not claimed from this focused implementation review.

## Business-context sources
| Domain / scope | Authoritative source | Source type | Reviewed date |
|---|---|---|---|
| Product and demo status | README.md | Project brief | 2026-10-24 |
| Permissions | src/features/auth/AuthProvider.tsx; supabase/migrations | Role context and database RLS | 2026-10-24 |
| Application lifecycle | src/services/applications.ts; supabase/migrations | API and workflow definitions | 2026-10-24 |
| Deadlines and review states | src/types/domain.ts; src/services/operations.ts | Domain and API | 2026-10-24 |

## Visual contract
DESIGN.md mirrors the canonical tailwind.config.js and src/index.css. Shared UI components own controls. Light theme only. Maintain the runtime and design record together; review rendered pages whenever changing shared styling.

## Canonical UI Map
| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Table Selection | ApplicationsTable | src/features/applications/ApplicationsListPage.tsx | No bulk selection; row disclosure and navigation | Desktop and mobile preview |
| Select/Listbox | Select | src/components/ui/Field.tsx | Native select | Keyboard and filter checks |
| Date | Date formatting helpers | src/lib/format.ts; src/lib/workQueue.ts | IST presentation; native existing date inputs | Calendar boundary unit tests |
| Form | Field and Button | src/components/ui/Field.tsx; src/components/ui/Button.tsx | Existing React Hook Form; local preference forms | Validation and button states |
| Scrollbar | Global CSS | src/index.css | Standard and WebKit; native forced colors | Responsive visual check |
| Toast | Sonner | src/app/App.tsx | Existing success/error notifications | Existing workflow integration |
| CRUD | Service functions | src/services | Existing authorised workflows | Existing database tests |

## Dataset navigation
Applications use server pagination with 15 records per page, URL filters and page number. Filter changes reset pagination. Saved views store up to eight named query combinations on the current browser, per user/workspace/list mode. Reusing a name replaces it. Presets reset other filters; RLS and institution/assignment scope always remain in effect. EVC this week is Monday through Sunday IST and includes scheduled or completed visits. Column visibility preferences are browser-local per user and role. Essential columns remain visible. Mobile cards expose the same record detail through native disclosure.

## Action queue
The queue is role-scoped and respects administrator region selection. Act now includes immediately actionable or overdue work; Due this week covers upcoming deadlines through Sunday IST; Waiting shows applications/evidence with another owner; Recently completed covers applications and officer tasks from the last seven days. Categories may overlap when work is both actionable and due this week. Preview queries fetch up to eight records per source and initially show five; exact source counts are labelled. Application and task entries are separate work items. No permission is granted by inclusion in a queue; record actions retain existing capability checks.

## Interaction and accessibility
Glossary search is immediate, supports clearing, and reports results or no matches. Application search uses explicit Search/Enter submission and a clear control. Dense text separates primary records from supporting context. Density changes do not shrink type. Controls have focus-visible treatment. Dialogs and drawers use Radix focus management. Native details can be toggled by keyboard. MotionConfig and CSS respect reduced motion. No automatic workflow progression or decorative looping motion is introduced.

## Scope and verification limits
This change updates presentation, local preferences and read-only queue/filter queries. It does not alter approval rules, decisions, access grants or database records. Real regulatory applicability still depends on authorised handbook configuration. Existing specialist tables outside application queues retain their current behavior. Automated static guidance is advisory and is supplemented by targeted browser inspection; it is not an accessibility certification.
