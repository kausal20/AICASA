import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  ArrowDown, ArrowRight, ArrowUpRight, Building2, Check, CheckCheck,
  ChevronRight, CircleCheck, Clock3, FileCheck2, FileText, Fingerprint,
  GitCompareArrows, GraduationCap, Layers3, Pause, Play, ScanSearch,
  ShieldCheck, Users, X,
} from 'lucide-react';
import { Mark } from '@/components/layout/Wordmark';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Link000 } from '@/components/ui/skiper-ui/skiper40';
import { cn } from '@/lib/cn';
import './landing.css';

const JOURNEY_INTERVAL = 4500;
const JOURNEY = [
  { name: 'Submission', short: 'Documents in', owner: 'Institution', title: 'One complete application. One starting point.', detail: 'Required documents come together in a single record. The institution submits, and the review can begin.', status: 'Submitted', tone: 'accent' as const, evidence: 'Documents attached. Reference recorded.', icon: FileCheck2 },
  { name: 'Scrutiny', short: 'Issues spotted', owner: 'Assigned officer', title: 'Spot the gap before it becomes a delay.', detail: 'Configured checks flag a shortfall in computer capacity. The officer reviews the evidence and raises a clear query.', status: 'Issue found', tone: 'warning' as const, evidence: 'Demo requirement: 120. Declared: 95.', icon: ScanSearch },
  { name: 'Correction', short: 'Changes tracked', owner: 'Institution → officer', title: 'A correction, with the history intact.', detail: 'The institution submits revised evidence. The officer sees exactly what changed, with the earlier version still on record.', status: 'Clarification sent', tone: 'accent' as const, evidence: 'Version 2 received. Version 1 preserved.', icon: GitCompareArrows },
  { name: 'Expert visit', short: 'People matched', owner: 'Visit coordinator', title: 'The right expertise, with conflicts checked.', detail: 'Where an Expert Visit Committee is required, the coordinator checks specialisation, conflicts, and availability before scheduling.', status: 'Panel checked', tone: 'primary' as const, evidence: 'Eligibility checked before assignment.', icon: Users },
  { name: 'Decision', short: 'Outcome recorded', owner: 'Authorised officer', title: 'A decision you can trace back.', detail: 'The authorised officer records the outcome and reasons. Documents, reviews, and follow-up obligations remain connected.', status: 'Decision recorded', tone: 'success' as const, evidence: 'Outcome, reasons, and audit history retained.', icon: Fingerprint },
];

function useLandingMotion() {
  const [reduce, setReduce] = useState(() => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches));
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduce(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
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
  return reduce;
}

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
    <p>Decision, reasons, and supporting evidence stay together.</p>
    <div className="lp-decision-stamp"><Fingerprint size={18} aria-hidden /><span>RECORDED &amp; TRACEABLE</span></div>
    <div className="lp-paper-foot">Decision made by the authorised officer</div>
  </div>;
}

function Journey({ reduce }: { reduce: boolean }) {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [inView, setInView] = useState(true);
  const [pageVisible, setPageVisible] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const current = JOURNEY[step];
  const automatic = playing && !reduce && inView && pageVisible;
  useEffect(() => {
    const onVisibility = () => setPageVisible(!document.hidden);
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    if (!ref.current || !('IntersectionObserver' in window)) return () => document.removeEventListener('visibilitychange', onVisibility);
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: 0.2 });
    observer.observe(ref.current);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);
  useEffect(() => {
    if (!automatic) return;
    const timer = window.setInterval(() => setStep((value) => (value + 1) % JOURNEY.length), JOURNEY_INTERVAL);
    return () => window.clearInterval(timer);
  }, [automatic]);
  const select = (index: number) => { setPlaying(false); setStep(index); };

  return <section id="journey" aria-labelledby="journey-heading" className="lp-journey lp-container" ref={ref}>
    <div className="lp-preview-caption"><div><span className="lp-live-dot" aria-hidden /><h2 id="journey-heading">One application. The whole journey.</h2></div><span>Interactive preview · demo data</span></div>
    <div className="lp-workspace" style={{ '--journey-duration': String(JOURNEY_INTERVAL) + 'ms' } as CSSProperties}>
      <div className="lp-workspace-bar"><div><Layers3 size={17} aria-hidden /><span>AICASA <span className="lp-bar-divider">/</span> <strong>Application record</strong></span></div><span className="lp-reference">DEMO / 2027–0042</span></div>
      <nav className="lp-stage-nav" aria-label="Application journey stages" onFocusCapture={() => setPlaying(false)}>
        {JOURNEY.map((stage, index) => <button type="button" key={stage.name} onClick={() => select(index)} aria-label={stage.name + ': ' + stage.short} aria-pressed={step === index} aria-controls="journey-detail" className={cn('lp-stage', index === step && 'is-selected', index < step && 'is-past')}>
          <span className="lp-stage-number">{index < step ? <Check size={15} aria-hidden /> : String(index + 1).padStart(2, '0')}</span>
          <span className="lp-stage-label"><strong><span className="lp-stage-name">{stage.name}</span><span className="lp-stage-mobile">{['Submit', 'Review', 'Correct', 'Visit', 'Decision'][index]}</span></strong><small>{stage.short}</small></span>
          {index < JOURNEY.length - 1 && <ChevronRight className="lp-stage-chevron" size={15} aria-hidden />}
          {step === index && <span className={cn('lp-stage-progress', automatic && 'is-playing')} key={String(step) + String(automatic)} aria-hidden />}
        </button>)}
      </nav>
      <div className="lp-case-body" id="journey-detail" aria-live={playing && !reduce ? 'off' : 'polite'} aria-atomic="true">
        <div className="lp-evidence-scene"><div className="lp-paper-back lp-paper-back-one" aria-hidden /><div className="lp-paper-back lp-paper-back-two" aria-hidden /><div className="lp-evidence-content" key={step}><CaseEvidence step={step} /></div></div>
        <div className="lp-case-copy">
          <div className="lp-case-copy-inner" key={step}>
            <div className="lp-case-step-label"><span className="lp-micro">Step {String(step + 1).padStart(2, '0')} / 05</span><Badge tone={current.tone}>{current.status}</Badge></div>
            <h3>{current.title}</h3>
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
    <p className="lp-preview-hint">Select any stage to explore. Actual steps depend on the application route.</p>
  </section>;
}

function CorrectionVisual() {
  return <div className="lp-feature-visual lp-correction-visual">
    <div className="lp-mini-heading"><GitCompareArrows size={18} aria-hidden /><span>One query. A visible correction.</span><Badge tone="accent">Demo</Badge></div>
    <div className="lp-correction-flow">
      <div className="lp-change-record"><span className="lp-micro">Officer’s query</span><p>Computer capacity is below the configured requirement.</p><div className="lp-count-pair"><span><strong>95</strong>declared</span><span className="lp-count-separator">/</span><span><strong>120</strong>required</span></div></div>
      <div className="lp-response-bridge"><span /><span><Clock3 size={14} aria-hidden /> 48-hour demo response window</span><span /></div>
      <div className="lp-change-record lp-change-resolved"><div className="lp-change-heading"><span className="lp-micro">Institution’s clarification</span><CheckCheck size={18} aria-hidden /></div><p>Updated inventory submitted.</p><div className="lp-version-change"><span>95</span><ArrowRight size={18} aria-hidden /><strong>120 computers</strong><Badge tone="success">v2</Badge></div></div>
    </div>
    <p className="lp-visual-foot"><Fingerprint size={14} aria-hidden /> Previous version stays in the audit history</p>
  </div>;
}

function ReviewVisual() {
  return <div className="lp-feature-visual lp-review-visual">
    <div className="lp-mini-heading"><Users size={18} aria-hidden /><span>The right people, the right checks.</span></div>
    <div className="lp-routing-panel"><span className="lp-micro">Expert eligibility</span>
      <div className="lp-routing-row"><span className="lp-routing-symbol is-eligible"><Check size={16} aria-hidden /></span><div><strong>Specialisation matches</strong><span>No declared conflict</span></div><span className="lp-routing-label">Eligible</span></div>
      <div className="lp-routing-row"><span className="lp-routing-symbol"><X size={16} aria-hidden /></span><div><strong>Affiliated with the institution</strong><span>Reason visible to the coordinator</span></div><span className="lp-routing-label">Excluded</span></div>
    </div>
    <div className="lp-parallel-reviews"><span className="lp-micro">Required reviews, running together</span><div className="lp-review-lanes"><div><ShieldCheck size={20} aria-hidden /><strong>Scrutiny Committee</strong><span><Check size={13} aria-hidden /> Review complete</span></div><div><FileCheck2 size={20} aria-hidden /><strong>Central AICTE Desk</strong><span><Clock3 size={13} aria-hidden /> Review in progress</span></div></div></div>
    <p className="lp-visual-foot"><Layers3 size={14} aria-hidden /> The next stage waits for all required reviews</p>
  </div>;
}

export function LandingPage() {
  const location = useLocation();
  const reduce = useLandingMotion();
  const openDemo = import.meta.env.VITE_OPEN_DEMO === 'true';
  useEffect(() => { document.title = 'AICASA · AICTE approvals, clearly connected'; }, []);
  useEffect(() => {
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ behavior: reduce ? 'instant' : 'smooth', block: 'start' });
  }, [location.key, location.hash, reduce]);

  return <div className="landing-page">
    <a href="#main-content" className="lp-skip-link">Skip to content</a>
    <header className="lp-header"><div className="lp-container lp-header-inner">
      <Link to="/" aria-label="AICASA home" className="lp-brand"><Mark /><span>AICASA<span className="lp-brand-caption">Approval workflows, connected.</span></span></Link>
      <nav aria-label="Main navigation" className="lp-main-nav"><Link000 href="#journey" className="lp-nav-link">How it works</Link000><Link000 href="#features" className="lp-nav-link">Why AICASA</Link000><ButtonLink to="/sign-in" variant="secondary" className="lp-header-signin">Sign in<ArrowUpRight size={15} aria-hidden /></ButtonLink></nav>
    </div></header>
    <main id="main-content">
      <section className="lp-intro lp-container" aria-labelledby="welcome-heading">
        <p className="lp-eyebrow lp-entrance"><span className="lp-eyebrow-rule" />Built for the approval journey</p>
        <h1 id="welcome-heading"><span>AICTE approvals.</span><span className="lp-headline-accent">A clear way forward.</span></h1>
        <p className="lp-intro-description lp-entrance">From the first document to the final decision.<br className="lp-desktop-break" /> Bring applications, people, and every next step together.</p>
        <div className="lp-hero-actions lp-entrance"><ButtonLink to="/sign-in" className="lp-primary-cta">Explore the demo<ArrowUpRight size={18} aria-hidden /></ButtonLink><Link000 href="#journey" className="lp-secondary-cta">See how it works<ArrowDown size={16} aria-hidden /></Link000></div>
        <div className="lp-audience lp-entrance" aria-label="For institutions, officers, and administrators"><span><Building2 size={15} aria-hidden />Institutions</span><i aria-hidden /><span><ShieldCheck size={15} aria-hidden />Officers</span><i aria-hidden /><span><Users size={15} aria-hidden />Administrators</span></div>
      </section>

      <Journey reduce={reduce} />

      <div className="lp-value-strip lp-container" data-reveal>
        {[{ icon: Layers3, title: 'One shared record', text: 'Evidence, reviews, and decisions stay together.' }, { icon: Fingerprint, title: 'A history you can follow', text: 'Every version and recorded action has context.' }, { icon: ArrowRight, title: 'A clear next step', text: 'Know what is needed and who acts next.' }].map((item) => <div key={item.title}><item.icon size={21} aria-hidden /><div><h2>{item.title}</h2><p>{item.text}</p></div></div>)}
      </div>

      <section id="features" className="lp-features lp-container" aria-labelledby="features-heading">
        <div className="lp-section-heading" data-reveal><p className="lp-eyebrow">Less chasing. More clarity.</p><h2 id="features-heading">The details make<br />the difference.</h2><p>See how AICASA connects the work between each stage.</p></div>
        <article className="lp-feature-story" data-reveal>
          <CorrectionVisual />
          <div className="lp-feature-copy"><span className="lp-feature-category"><ScanSearch size={18} aria-hidden />Checks &amp; corrections</span><h3>Catch the gap.<br />Keep the progress.</h3><p>The dynamic deficiency matrix checks applications against configured Approval Process Handbook rules. Institutions get a clear query and a response window to put things right.</p><ul><li><Check size={16} aria-hidden /><span>Automatic checks bring missing requirements into view.</span></li><li><Check size={16} aria-hidden /><span>Version comparison shows the change for re-review.</span></li></ul><Link000 href="#journey" className="lp-story-link">Follow the correction journey<ArrowUpRight size={16} aria-hidden /></Link000></div>
        </article>
        <article className="lp-feature-story lp-feature-story-reverse" data-reveal>
          <ReviewVisual />
          <div className="lp-feature-copy"><span className="lp-feature-category"><Users size={18} aria-hidden />Experts &amp; review teams</span><h3>Move together.<br />Stay accountable.</h3><p>Expert recommendations check specialisation and conflicts. Role-based permissions let authorised teams review their sections in parallel, with ownership visible throughout.</p><ul><li><Check size={16} aria-hidden /><span>Same-district, affiliated, and declared conflicts are screened.</span></li><li><Check size={16} aria-hidden /><span>Every required review must finish before routing onward.</span></li></ul><Link000 href="#journey" className="lp-story-link">Explore the application journey<ArrowUpRight size={16} aria-hidden /></Link000></div>
        </article>
        <p className="lp-demo-rule-note">Examples use synthetic data and demonstration rules. Requirements and response times need verification before real use.</p>
      </section>

      <section className="lp-demo-section lp-container" data-reveal aria-labelledby="demo-heading"><div className="lp-demo-panel">
        <div><p className="lp-eyebrow">Your next step</p><h2 id="demo-heading">See the whole workflow.<br />Try it for yourself.</h2><p>Explore the SIH26262 prototype through an institution,<br className="lp-desktop-break" /> officer, or administrator workspace.</p></div>
        <div className="lp-demo-action"><ButtonLink to="/sign-in" className="lp-demo-button">Enter the demo workspace<ArrowUpRight size={18} aria-hidden /></ButtonLink><span>{openDemo ? 'Choose your demo role on the next screen.' : 'Sign in with your issued demo account.'}</span></div>
      </div></section>
    </main>
    <footer className="lp-footer lp-container">
      <div className="lp-footer-main"><div><Link to="/" className="lp-brand" aria-label="AICASA home"><Mark /><span>AICASA</span></Link><p>AICTE Integrated Compliance and Approval<br className="lp-desktop-break" /> System for Administration</p></div><nav aria-label="Footer navigation"><Link000 href="#journey">How it works</Link000><Link000 href="#features">Why AICASA</Link000><Link000 href="/sign-in">Sign in</Link000></nav></div>
      <div className="lp-footer-meta"><p>SIH26262 student prototype · Synthetic data · Not an official AICTE service.</p><p>Link interactions by <a href="https://skiper-ui.com/v1/skiper40" target="_blank" rel="noreferrer">Skiper UI<ArrowUpRight size={12} aria-hidden /><span className="sr-only"> (opens in a new tab)</span></a></p></div>
    </footer>
  </div>;
}
