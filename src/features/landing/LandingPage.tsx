import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  ArrowDown, ArrowRight, Building2, Check, CheckCheck, ChevronRight, CircleCheck, Clipboard, ClipboardCheck, FileCheck2, FileText,
  Fingerprint, GitCompareArrows, GraduationCap, Layers3, Pause, Play, ScanSearch, ShieldCheck, Users, UsersRound,
} from 'lucide-react';
import { Mark } from '@/components/layout/Wordmark';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Stat } from '@/components/ui/Page';
import { Notice } from '@/components/ui/States';
import { Link000 } from '@/components/ui/skiper-ui/skiper40';
import { WorkflowTracker } from '@/features/applications/WorkflowTracker';
import { cn } from '@/lib/cn';
import type { StageHistory, WorkflowStage } from '@/types/domain';
import { getLandingSnapshot, type LandingCase, type LandingSnapshot } from '@/services/landing';
import './landing.css';

const JOURNEY_INTERVAL = 4000;
const PREVIEW_INTERVAL = 3000;

/** Each stage has a one-line plain-English explanation; acronyms are expanded where they first appear. */
const JOURNEY = [
  { name: 'Submission', plain: 'The institution files its documents online.', mobile: 'Submit', owner: 'Institution', title: 'One complete application. One starting point.', detail: 'Every required document comes together in a single record. The institution submits it, and the review can begin.', status: 'Submitted', tone: 'accent' as const, evidence: 'Documents attached. Reference recorded.', icon: FileCheck2 },
  { name: 'Scrutiny', plain: 'Officers check the file against the rules.', mobile: 'Review', owner: 'Scrutiny Committee', title: 'Spot the gap before it becomes a delay.', detail: 'Scrutiny means careful checking. The system compares the application with the handbook rules and flags a shortfall in computer capacity; the officer then raises a clear query, a written question to the institution.', status: 'Issue found', tone: 'warning' as const, evidence: 'Demo requirement: 120. Declared: 95.', icon: ScanSearch },
  { name: 'Correction', plain: 'Queries in 48 hours; corrections by their due date.', mobile: 'Correct', owner: 'Institution → officer', title: 'A correction, with the history intact.', detail: 'The institution answers an officer query within 48 hours, or a deficiency correction by the due date shown on it. The officer sees exactly what changed, with the earlier version still on record.', status: 'Clarification sent', tone: 'accent' as const, evidence: 'Version 2 received. Version 1 preserved.', icon: GitCompareArrows },
  { name: 'Expert visit', plain: 'An expert panel inspects the campus online.', mobile: 'Visit', owner: 'Visit coordinator', title: 'The right expertise, with conflicts checked.', detail: 'Where an Expert Visit Committee (EVC) is required, the coordinator checks each expert’s specialisation, conflicts of interest and availability before scheduling the visit.', status: 'Panel checked', tone: 'primary' as const, evidence: 'Eligibility checked before assignment.', icon: Users },
  { name: 'Decision', plain: 'An authorised officer records the outcome.', mobile: 'Decide', owner: 'Central AICTE Desk', title: 'A decision you can trace back.', detail: 'The authorised officer records the outcome and the reasons. Documents, reviews and follow-up obligations stay connected to it.', status: 'Decision recorded', tone: 'success' as const, evidence: 'Outcome, reasons and audit history retained.', icon: Fingerprint },
];

const FEATURES = [
  { icon: ScanSearch, title: 'Dynamic Deficiency Matrix', benefit: 'Applications are pre-screened against handbook rules before a human ever opens them.', example: 'Sanctioned intake requires 120 computers, only 95 declared — deficiency detected automatically.', term: 'A deficiency is a gap between what the rules require and what an application declares.' },
  { icon: UsersRound, title: 'Smart EVC Routing', abbr: ['EVC', 'Expert Visit Committee'], benefit: 'Expert panels matched by specialization, with conflicts of interest excluded automatically.', example: 'Same-district and affiliated experts are filtered out, with the reason shown.', term: 'EVC = Expert Visit Committee, the panel that inspects an institution.' },
  { icon: Layers3, title: 'Concurrent Reviews with RBAC', abbr: ['RBAC', 'role-based access control'], benefit: 'Scrutiny Committee and Central Desk review different sections of the same file in parallel.', example: 'Routing waits for every review — nothing slips through a gap.', term: 'RBAC = role-based access control: each reviewer works only in their own section.' },
  { icon: GitCompareArrows, title: 'Query & Clarification Window', benefit: 'Officer queries are answered within 48 hours; deficiency corrections are due by the date on each item (typically 7 days). Only the change is re-reviewed.', example: 'Version compare shows exactly what changed — nothing else.', term: 'A query is a written question from an officer; the clarification is the institution’s answer.' },
];

function usePrefersReducedMotion() {
  const [reduce, setReduce] = useState(() => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches));
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduce(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return reduce;
}

/** Scroll reveal (fade + 16px rise, once). Content stays visible when motion is reduced or IntersectionObserver is missing. */
function useScrollReveal(reduce: boolean) {
  useEffect(() => {
    if (reduce || !('IntersectionObserver' in window)) return;
    const elements = document.querySelectorAll<HTMLElement>('.landing-page [data-reveal]');
    const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    }), { threshold: 0.08 });
    elements.forEach((element) => { element.classList.add('will-reveal'); observer.observe(element); });
    return () => { observer.disconnect(); elements.forEach((element) => element.classList.remove('will-reveal')); };
  }, [reduce]);
}

/** True while the element is on screen and the browser tab is visible; used to pause every loop that nobody can see. */
function useActive(ref: React.RefObject<HTMLElement>) {
  const [inView, setInView] = useState(true);
  const [pageVisible, setPageVisible] = useState(true);
  useEffect(() => {
    const onVisibility = () => setPageVisible(!document.hidden);
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    if (!ref.current || !('IntersectionObserver' in window)) return () => document.removeEventListener('visibilitychange', onVisibility);
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: 0.2 });
    observer.observe(ref.current);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [ref]);
  return inView && pageVisible;
}

// ---------------------------------------------------------------------------
// Hero visual: the product's own components with synthetic data
// ---------------------------------------------------------------------------
/** A real seeded case as the stepper shows it: its route's stages, completed up to the current one. */
function caseStages(c: LandingCase): WorkflowStage[] {
  return c.stages.map((x) => ({ id: `${c.reference}-${x.code}`, version_id: c.reference, code: x.code, name: x.name, kind: x.kind, sequence: x.sequence,
    sla_days: null, responsible_capability: null, description: '' }));
}
function caseHistory(c: LandingCase): StageHistory[] {
  const order = c.stages.findIndex((x) => x.code === c.current_stage);
  const upto = order < 0 ? c.stages.length - 1 : order;
  return c.stages.slice(0, upto + 1).map((x, i) => ({ id: `${c.reference}-h${i}`, stage_code: x.code, stage_name: x.name, entered_at: '', due_at: null, // no dates on the public preview
    exited_at: i < upto ? 'done' : null, exit_transition: null }));
}

/**
 * Mini dashboard card with the same seeded figures as the signed-in dashboards (from the database, not invented), stepping through
 * real seeded demo cases. The card lifts and tilts toward the pointer. With reduced motion it stays on the first case.
 */
function ProductPreview({ reduce }: { reduce: boolean }) {
  const [snap, setSnap] = useState<LandingSnapshot | null | undefined>(undefined);
  const [step, setStep] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const active = useActive(ref);
  useEffect(() => { let live = true; getLandingSnapshot().then((x) => { if (live) setSnap(x); }); return () => { live = false; }; }, []);
  const cases = snap?.cases ?? [];
  useEffect(() => {
    if (reduce || !active || cases.length < 2) return;
    const timer = window.setInterval(() => setStep((x) => (x + 1) % cases.length), PREVIEW_INTERVAL);
    return () => window.clearInterval(timer);
  }, [reduce, active, cases.length]);
  const move = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (reduce || !card.current) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    card.current.style.setProperty('--tilt-x', `${(-y * 5).toFixed(2)}deg`);
    card.current.style.setProperty('--tilt-y', `${(x * 7).toFixed(2)}deg`);
  };
  const leave = () => { card.current?.style.setProperty('--tilt-x', '0deg'); card.current?.style.setProperty('--tilt-y', '0deg'); };
  const c = cases[step % Math.max(cases.length, 1)];
  const t = snap?.totals;
  return (
    <figure className="lp-preview" ref={ref} aria-label="Preview of the AICASA dashboard with the seeded demo figures, stepping through real demo applications">
      <figcaption className="lp-preview-label"><span className="lp-live-dot" aria-hidden />Live product preview — demo data</figcaption>
      <div className="lp-preview-stage" onMouseMove={move} onMouseLeave={leave}>
        <div className="lp-preview-card" ref={card} aria-hidden="true">
          <div className="lp-preview-bar"><div><Mark /><span>AICASA <span className="lp-bar-divider">/</span> <strong>Dashboard</strong></span></div><span className="lp-reference">{c?.reference ?? 'DEMO'}</span></div>
          <div className="lp-preview-body">
            <div className="lp-preview-stats">
              {t ? <>
                <Stat label="Applications" value={t.applications} />
                <Stat label="With institution" value={t.with_institution} tone="warning" />
                <Stat label="Past target" value={t.past_target} tone="danger" />
              </> : <><span className="lp-preview-skeleton" /><span className="lp-preview-skeleton" /><span className="lp-preview-skeleton" /></>}
            </div>
            {c ? (
              <div className="lp-preview-record">
                <div className="lp-preview-record-head"><div><strong>{c.title}</strong><small>{c.institution} · {c.reference}</small></div><StatusBadge status={c.status} /></div>
                <WorkflowTracker stages={caseStages(c)} transitions={[]} history={caseHistory(c)} current={c.current_stage} status={c.status} stageDueAt={null} />
              </div>
            ) : <div className="lp-preview-record"><p className="text-[13px] text-ink-soft">{snap === null ? 'Live demo figures are shown here when the demo database is reachable.' : 'Loading the demo figures…'}</p></div>}
            {c?.next_action && <div className="lp-preview-notice" key={step}><Notice tone="info" title="Next action">{c.next_action}</Notice></div>}
          </div>
        </div>
      </div>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// How it works: the five-stage journey
// ---------------------------------------------------------------------------
function FileRow({ title, note, revised = false }: { title: string; note: string; revised?: boolean }) {
  return <div className={cn('lp-file-row', revised && 'lp-file-row-revised')}>
    <span className="lp-file-icon"><FileText size={18} aria-hidden /></span>
    <span><strong>{title}</strong><small>{note}</small></span>
    <CircleCheck size={17} className="text-success" aria-hidden />
  </div>;
}

/** Illustrative views of the same application; all quantities are synthetic demo data. */
function CaseEvidence({ step }: { step: number }) {
  if (step === 0) return <div className="lp-paper">
    <div className="lp-paper-heading"><span className="lp-micro">Application package</span><Badge tone="success">Ready for review</Badge></div>
    <div className="lp-paper-title"><GraduationCap size={26} aria-hidden /><div><strong>Extension of approval</strong><span>Academic year 2027–28</span></div></div>
    <div className="lp-document-list">
      <FileRow title="Application form" note="Signed and submitted" />
      <FileRow title="Infrastructure evidence" note="Computer inventory" />
      <FileRow title="Faculty declaration" note="Declaration attached" />
    </div>
    <div className="lp-paper-foot"><CheckCheck size={16} aria-hidden /> One record. All the evidence.</div>
  </div>;

  if (step === 1) return <div className="lp-paper">
    <div className="lp-paper-heading"><span className="lp-micro">Automated pre-check</span><Badge tone="warning">1 issue found</Badge></div>
    <p className="lp-evidence-title">Computer capacity</p>
    <p className="lp-evidence-caption">Check against the configured demo rule</p>
    <div className="lp-capacity-row"><span>Declared</span><strong>95 <small>computers</small></strong></div>
    <div className="lp-bar-track"><span className="lp-bar-warning" style={{ width: '79.17%' }} /></div>
    <div className="lp-capacity-row"><span>Required in this demo</span><strong>120</strong></div>
    <div className="lp-bar-track"><span style={{ width: '100%' }} /></div>
    <div className="lp-evidence-note lp-note-warning"><ScanSearch size={17} aria-hidden /><span><strong>25 computers below requirement</strong><small>Flagged for the officer to review.</small></span></div>
  </div>;

  if (step === 2) return <div className="lp-paper">
    <div className="lp-paper-heading"><span className="lp-micro">Version comparison</span><Badge tone="accent">Change recorded</Badge></div>
    <p className="lp-evidence-title">Computer inventory</p>
    <div className="lp-compare">
      <div><span>Previous declaration</span><strong>95</strong><small>Version 1 · retained</small></div>
      <ArrowRight size={24} aria-hidden />
      <div className="lp-compare-new"><span>Revised declaration</span><strong>120</strong><small>Version 2 · submitted</small></div>
    </div>
    <FileRow title="Updated inventory" note="New evidence ready for officer review" revised />
    <div className="lp-paper-foot"><GitCompareArrows size={16} aria-hidden /> See the change. Keep the history.</div>
  </div>;

  if (step === 3) return <div className="lp-paper">
    <div className="lp-paper-heading"><span className="lp-micro">Expert panel checks</span><Badge tone="primary">Illustrative panel</Badge></div>
    <p className="lp-evidence-title">Expertise for this application</p>
    <div className="lp-expert-list">
      {['Computer engineering', 'Infrastructure review', 'Academic administration'].map((label, index) => <div className="lp-expert-row" key={label}><span className="lp-expert-avatar"><Users size={17} aria-hidden /></span><span><strong>{label}</strong><small>{index === 0 ? 'Specialisation matched' : 'Eligibility checked'}</small></span><Check size={16} className="text-success" aria-hidden /></div>)}
    </div>
    <div className="lp-paper-foot"><ShieldCheck size={16} aria-hidden /> Conflicts checked before assignment</div>
  </div>;

  return <div className="lp-paper lp-decision-paper">
    <div className="lp-paper-heading"><span className="lp-micro">Decision record</span><Badge tone="success">Recorded</Badge></div>
    <div className="lp-decision-mark"><Check size={34} strokeWidth={1.8} aria-hidden /></div>
    <p className="lp-decision-title">Every outcome has a record.</p>
    <p>Decision, reasons and supporting evidence stay together.</p>
    <div className="lp-decision-stamp"><Fingerprint size={18} aria-hidden /><span>RECORDED &amp; TRACEABLE</span></div>
    <div className="lp-paper-foot">Decision made by the authorised officer</div>
  </div>;
}

function Journey({ reduce }: { reduce: boolean }) {
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState<'fwd' | 'back'>('fwd');
  const [playing, setPlaying] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const visible = useActive(ref);
  const current = JOURNEY[step];
  const automatic = playing && !reduce && visible;
  useEffect(() => {
    if (!automatic) return;
    const timer = window.setInterval(() => { setDir('fwd'); setStep((value) => (value + 1) % JOURNEY.length); }, JOURNEY_INTERVAL);
    return () => window.clearInterval(timer);
  }, [automatic]);
  // any interaction hands control to the visitor: auto-play stops until they press Play
  const select = (index: number) => { setPlaying(false); setDir(index >= step ? 'fwd' : 'back'); setStep(index); };

  return <section id="how-it-works" aria-labelledby="journey-heading" className="lp-journey lp-container" ref={ref} data-reveal>
    <div className="lp-section-heading lp-section-heading-left"><p className="lp-eyebrow">How it works</p><h2 id="journey-heading">One application. The whole journey.</h2><p>Follow a single application from submission to decision. Select any stage, or let it play.</p></div>
    <div className="lp-preview-caption"><span>Interactive preview · demo data</span></div>
    <div className="lp-workspace" style={{ '--journey-duration': String(JOURNEY_INTERVAL) + 'ms' } as CSSProperties}>
      <div className="lp-workspace-bar"><div><Layers3 size={17} aria-hidden /><span>AICASA <span className="lp-bar-divider">/</span> <strong>Application record</strong></span></div><span className="lp-reference">DEMO / 2027–0042</span></div>
      <nav className="lp-stage-nav" aria-label="Application journey stages" onFocusCapture={() => setPlaying(false)}>
        {JOURNEY.map((stage, index) => <button type="button" key={stage.name} onClick={() => select(index)} aria-label={stage.name + ': ' + stage.plain} aria-pressed={step === index} aria-controls="journey-detail" className={cn('lp-stage', index === step && 'is-selected', index < step && 'is-past')}>
          <span className="lp-stage-number">{index < step ? <Check size={15} aria-hidden /> : String(index + 1).padStart(2, '0')}</span>
          <span className="lp-stage-label"><strong><span className="lp-stage-name">{stage.name}</span><span className="lp-stage-mobile">{stage.mobile}</span></strong><small>{stage.plain}</small></span>
          {index < JOURNEY.length - 1 && <ChevronRight className="lp-stage-chevron" size={15} aria-hidden />}
          {step === index && <span className={cn('lp-stage-progress', automatic && 'is-playing')} key={String(step) + String(automatic)} aria-hidden />}
        </button>)}
      </nav>
      <div className="lp-case-body" id="journey-detail" aria-live={playing && !reduce ? 'off' : 'polite'} aria-atomic="true" data-dir={dir}>
        <div className="lp-evidence-scene"><div className="lp-paper-back lp-paper-back-one" aria-hidden /><div className="lp-paper-back lp-paper-back-two" aria-hidden /><div className="lp-evidence-content" key={step}><CaseEvidence step={step} /></div></div>
        <div className="lp-case-copy">
          <div className="lp-case-copy-inner" key={step}>
            <div className="lp-case-step-label"><span className="lp-micro">Step {String(step + 1).padStart(2, '0')} / 05</span><Badge tone={current.tone}>{current.status}</Badge></div>
            <h3>{current.title}</h3>
            <p className="lp-plain-line">In plain English: {current.plain}</p>
            <p>{current.detail}</p>
            <div className="lp-owner"><span className="lp-owner-icon"><current.icon size={19} aria-hidden /></span><div><small>Responsible at this stage</small><strong>{current.owner}</strong></div></div>
          </div>
          <div className="lp-case-controls"><Button variant="link" className="lp-next" onFocus={() => setPlaying(false)} onClick={() => select((step + 1) % JOURNEY.length)}>{step === 4 ? 'Start again' : 'Next stage'}<ArrowRight size={16} aria-hidden /></Button>
            {!reduce && <button type="button" className="lp-play-toggle" onClick={() => setPlaying((value) => !value)} aria-label={playing ? 'Pause application journey' : 'Play application journey'}>{playing ? <Pause size={14} aria-hidden /> : <Play size={14} aria-hidden />}<span>{playing ? 'Pause' : 'Play'}</span></button>}
          </div>
        </div>
      </div>
      <div className="lp-workspace-foot"><span><ShieldCheck size={14} aria-hidden /> {current.evidence}</span><span>Illustrative route</span></div>
    </div>
    <p className="lp-preview-hint">Actual steps depend on the application route.</p>
  </section>;
}

// ---------------------------------------------------------------------------
// Demo access
// ---------------------------------------------------------------------------
function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1800); } catch { setCopied(false); }
  };
  return <div className="lp-copy-field"><div><small>{label}</small><code>{value}</code></div>
    <button type="button" className="lp-copy-button" onClick={copy} aria-label={`Copy ${label.toLowerCase()}`}>{copied ? <ClipboardCheck size={15} aria-hidden /> : <Clipboard size={15} aria-hidden />}<span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span></button></div>;
}

export function LandingPage() {
  const location = useLocation();
  const reduce = usePrefersReducedMotion();
  useScrollReveal(reduce);
  const openDemo = import.meta.env.VITE_OPEN_DEMO === 'true';
  // Only shown when the project deliberately publishes demo credentials through its public environment; never hard-coded.
  const demoEmail = (import.meta.env.VITE_PUBLIC_DEMO_EMAIL as string | undefined)?.trim();
  useEffect(() => { document.title = 'AICASA · AICTE approvals, without the paper chase'; }, []);
  useEffect(() => {
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ behavior: reduce ? 'instant' : 'smooth', block: 'start' });
  }, [location.key, location.hash, reduce]);

  return <div className="landing-page">
    <a href="#main-content" className="lp-skip-link">Skip to content</a>
    <header className="lp-header"><div className="lp-container lp-header-inner">
      <Link to="/" aria-label="AICASA home" className="lp-brand"><Mark /><span>AICASA<span className="lp-brand-caption">Approval workflows, connected.</span></span></Link>
      <nav aria-label="Main navigation" className="lp-main-nav"><Link000 href="#how-it-works" className="lp-nav-link">How it works</Link000><Link000 href="#features" className="lp-nav-link">Features</Link000><ButtonLink to="/sign-in" className="lp-header-signin">Sign in</ButtonLink></nav>
    </div></header>
    <main id="main-content">
      <section className="lp-hero lp-container" aria-labelledby="welcome-heading">
        <div className="lp-hero-copy">
          <p className="lp-eyebrow lp-entrance"><span className="lp-eyebrow-rule" />AICTE · All India Council for Technical Education</p>
          <h1 id="welcome-heading">AICTE approvals, <span className="lp-headline-accent">without the paper chase.</span></h1>
          <p className="lp-intro-description lp-entrance"><abbr title="AICTE Integrated Compliance and Approval System for Administration">AICASA</abbr> checks every application against the Approval Process Handbook automatically, routes expert visits without bias, and tracks each file from submission to decision — for institutions, officers and administrators.</p>
          <div className="lp-hero-actions lp-entrance"><ButtonLink to="/sign-in" className="lp-primary-cta">Open the demo workspace<ArrowRight size={18} aria-hidden /></ButtonLink><Link000 href="#how-it-works" className="lp-secondary-cta">See how it works<ArrowDown size={16} aria-hidden /></Link000></div>
          <p className="lp-audience lp-entrance" aria-label="Built for institutions, officers and administrators"><span className="lp-audience-label">For</span><span><Building2 size={15} aria-hidden />Institutions</span><i aria-hidden>·</i><span><ShieldCheck size={15} aria-hidden />Officers</span><i aria-hidden>·</i><span><Users size={15} aria-hidden />Administrators</span></p>
        </div>
        <div className="lp-hero-visual lp-entrance-visual"><ProductPreview reduce={reduce} /></div>
      </section>

      <section id="features" className="lp-features lp-container" aria-labelledby="features-heading">
        <div className="lp-section-heading" data-reveal><p className="lp-eyebrow">Why AICASA is different</p><h2 id="features-heading">Four things paper and email cannot do.</h2><p>Each one removes a delay that approvals usually run into.</p></div>
        <ul className="lp-feature-grid">
          {FEATURES.map((f, i) => <li key={f.title} className="lp-feature-card" data-reveal style={{ '--i': i } as CSSProperties}>
            <span className="lp-feature-icon"><f.icon size={22} aria-hidden /></span>
            <h3>{f.abbr ? <>{f.title.split(f.abbr[0])[0]}<abbr title={f.abbr[1]}>{f.abbr[0]}</abbr>{f.title.split(f.abbr[0])[1]}</> : f.title}</h3>
            <p className="lp-feature-benefit">{f.benefit}</p>
            <p className="lp-feature-example"><span>For example</span>{f.example}</p>
            <p className="lp-feature-term">{f.term}</p>
          </li>)}
        </ul>
        <p className="lp-demo-rule-note">Examples use synthetic data and demonstration rules. Requirements and response times need verification before real use.</p>
      </section>

      <Journey reduce={reduce} />

      <section id="demo" className="lp-demo-section lp-container" data-reveal aria-labelledby="demo-heading"><div className="lp-demo-panel">
        <div>
          <p className="lp-eyebrow">Demo access</p><h2 id="demo-heading">Here for the demo?</h2>
          <p>This is a working SIH26262 prototype with synthetic data: pick an institution, officer or administrator workspace and follow a real application through every stage.</p>
          {demoEmail && <div className="lp-copy-box"><p>Demo sign-in email:</p><CopyField label="Email" value={demoEmail} /><p>The password is shared by the project team.</p></div>}
        </div>
        <div className="lp-demo-action"><ButtonLink to="/sign-in" className="lp-demo-button">Enter the demo workspace<ArrowRight size={18} aria-hidden /></ButtonLink><span>{openDemo ? 'Choose your demo role on the next screen.' : demoEmail ? 'Use the email on the left at the sign-in screen; your workspace follows the account.' : 'Demo accounts are issued by the project team; you will see the sign-in screen.'}</span></div>
      </div></section>
    </main>
    <footer className="lp-footer lp-container">
      <div className="lp-footer-main"><div><Link to="/" className="lp-brand" aria-label="AICASA home"><Mark /><span>AICASA</span></Link><p>AICTE Integrated Compliance and Approval<br className="lp-desktop-break" /> System for Administration</p></div><nav aria-label="Footer navigation"><Link000 href="#how-it-works">How it works</Link000><Link000 href="#features">Features</Link000><Link000 href="#demo">Demo access</Link000></nav></div>
      <div className="lp-footer-meta"><p>SIH26262 student prototype · Synthetic data · Not an official AICTE service.</p><p>Link interactions by <a href="https://skiper-ui.com/v1/skiper40" target="_blank" rel="noreferrer">Skiper UI<span className="sr-only"> (opens in a new tab)</span></a></p></div>
    </footer>
  </div>;
}
