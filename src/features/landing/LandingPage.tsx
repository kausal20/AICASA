import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ArrowRight, Check, FileCheck2, Fingerprint, GraduationCap, ShieldCheck, Users } from 'lucide-react';
import { Mark } from '@/components/layout/Wordmark';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Link000, Link003 } from '@/components/ui/skiper-ui/skiper40';

const JOURNEY = [
  { name: 'Submission', owner: 'Institution', title: 'A complete application. One clear starting point.', detail: 'Upload the required documents, review pre-check findings, and submit through the configured route.', evidence: 'Application submitted · reference recorded', icon: FileCheck2 },
  { name: 'Scrutiny', owner: 'Assigned officer', title: 'Every review has an owner.', detail: 'Officers review the application and evidence. Independent reviews can run together when the route requires them.', evidence: 'Review assigned · stage target visible', icon: ShieldCheck },
  { name: 'Correction', owner: 'Institution → officer', title: 'Resolve the issue without losing the history.', detail: 'Respond to a deficiency, attach a newer document version, and send it back for officer review.', evidence: 'Version 2 submitted · version 1 preserved', icon: FileCheck2 },
  { name: 'Expert visit', owner: 'EVC coordinator', title: 'The right people. A clear schedule.', detail: 'Where an Expert Visit Committee is required, check availability and declared conflicts before scheduling.', evidence: 'Panel checked · visit scheduled', icon: Users },
  { name: 'Decision', owner: 'Authorised officer', title: 'A recorded decision, with a traceable path.', detail: 'The competent officer records the decision and reasons. Applicable compliance obligations continue afterward.', evidence: 'Decision recorded · audit history retained', icon: Fingerprint },
];

export function LandingPage() {
  const [step, setStep] = useState(0);
  const reduce = useReducedMotion();
  const current = JOURNEY[step];
  useEffect(() => { document.title = 'AICASA · Approval workflows, clearly connected'; }, []);
  return (
    <div className="min-h-screen bg-surface text-ink">
      <header className="border-b border-line"><div className="mx-auto flex min-h-20 max-w-7xl items-center justify-between gap-3 px-5 sm:px-8">
        <Link to="/" aria-label="AICASA home" className="flex items-center gap-3"><Mark /><span className="text-lg font-semibold tracking-tight">AICASA</span></Link>
        <div className="flex items-center gap-5"><Link003 className="hidden text-sm font-medium text-ink-soft hover:text-primary sm:flex" href="#journey">How it works</Link003><ButtonLink to="/sign-in">Sign in <ArrowRight className="h-4 w-4" aria-hidden /></ButtonLink></div>
      </div></header>
      <main>
        <section className="mx-auto grid max-w-7xl items-center gap-12 px-5 py-16 sm:px-8 lg:grid-cols-[1.15fr_0.85fr] lg:py-24">
          <motion.div initial={reduce ? false : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
            <p className="mb-6 flex items-center gap-2 text-sm font-medium text-accent"><span className="h-2 w-2 rounded-full bg-accent" />Connected approval management</p>
            <h1 className="max-w-[20ch] text-4xl font-semibold leading-[1.1] tracking-[-0.035em] sm:text-5xl xl:text-6xl">Manage AICTE approval workflows <span className="text-primary">from submission to decision.</span></h1>
            <p className="mt-7 max-w-xl text-lg leading-relaxed text-ink-soft">Track scrutiny, deficiencies, expert visits, compliance deadlines, and audit history in one secure workspace.</p>
            <div className="mt-8 flex flex-wrap gap-3"><ButtonLink to="/sign-in" className="h-12 px-6">Open your workspace <ArrowRight className="h-4 w-4" aria-hidden /></ButtonLink><Link000 href="#journey" className="inline-flex min-h-12 items-center rounded-lg px-4 font-medium text-accent hover:bg-accent-soft">Explore the workflow ↓</Link000></div>
            <p className="mt-6 max-w-lg text-sm leading-relaxed text-ink-soft">SIH26262 student prototype · synthetic data.<br />Not an official AICTE service. Decisions remain with authorised officers.</p>
          </motion.div>
          <motion.div initial={reduce ? false : { opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, delay: reduce ? 0 : 0.1 }} className="rounded-2xl border border-line bg-page p-5 shadow-lift sm:p-7">
            <div className="flex items-center justify-between gap-3 border-b border-line pb-5"><span className="text-sm font-semibold">One application. A connected record.</span><GraduationCap className="h-6 w-6 shrink-0 text-primary" aria-hidden /></div>
            <div className="my-6 rounded-xl border border-line bg-surface p-5"><p className="font-mono text-xs tracking-wide text-accent">ILLUSTRATIVE APPLICATION</p><h2 className="mt-2 text-xl font-semibold">Extension of approval</h2><p className="mt-2 text-sm text-ink-soft">Documents, reviews, decisions, and follow-up — together.</p></div>
            <ol>{JOURNEY.map((s, i) => <li key={s.name} className="relative flex items-center gap-4 py-3">{i < 4 && <span className="absolute bottom-[-12px] left-[17px] top-10 w-px bg-line-strong" aria-hidden />}<span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-soft text-sm font-semibold text-primary">{i + 1}</span><span className="flex-1 text-sm font-semibold">{s.name}</span><span className="text-xs text-ink-soft">{s.owner}</span></li>)}</ol>
          </motion.div>
        </section>
        <section id="journey" className="scroll-mt-6 border-y border-line bg-page px-5 py-16 sm:px-8"><div className="mx-auto max-w-7xl">
          <p className="text-sm font-medium text-accent">Follow the work</p><h2 className="mt-2 text-3xl font-semibold tracking-tight">Know what happens next.</h2><p className="mt-3 max-w-2xl leading-relaxed text-ink-soft">Explore an illustrative journey. Actual stages, corrections, and expert visits depend on the configured application route.</p>
          <div className="mt-8 grid overflow-hidden rounded-2xl border border-line bg-surface shadow-card lg:grid-cols-[280px_1fr]">
            <nav aria-label="Illustrative workflow stages" className="grid grid-cols-2 gap-2 border-b border-line bg-surface-muted/50 p-4 sm:grid-cols-5 lg:grid-cols-1 lg:border-b-0 lg:border-r">{JOURNEY.map((s, i) => <button key={s.name} onClick={() => setStep(i)} aria-pressed={step === i} className={`flex min-h-12 items-center gap-3 rounded-lg px-3 text-left text-sm font-medium transition-colors ${step === i ? 'bg-primary text-white shadow-card' : 'text-ink-soft hover:bg-primary-soft'}`}><span className="font-mono text-xs opacity-70">0{i + 1}</span>{s.name}{step === i && <ArrowRight className="ml-auto hidden h-4 w-4 lg:block" aria-hidden />}</button>)}</nav>
            <div className="min-h-[360px] p-6 sm:p-10" aria-live="polite"><AnimatePresence mode="wait" initial={false}><motion.div key={step} initial={{ opacity: 0, y: reduce ? 0 : 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: reduce ? 0 : 0.2 }}><current.icon className="mb-5 h-8 w-8 text-primary" aria-hidden /><p className="text-sm font-medium text-accent">{current.owner}</p><h3 className="mt-3 max-w-xl text-2xl font-semibold leading-snug sm:text-3xl">{current.title}</h3><p className="mt-4 max-w-2xl leading-relaxed text-ink-soft">{current.detail}</p><p className="mt-6 flex items-center gap-2 rounded-lg bg-success-soft px-4 py-3 text-sm text-success"><Check className="h-4 w-4 shrink-0" aria-hidden />{current.evidence}</p></motion.div></AnimatePresence><Button variant="link" className="mt-5" onClick={() => setStep((step + 1) % JOURNEY.length)}>{step === 4 ? 'Start again' : 'Next stage'} <ArrowRight className="h-4 w-4" aria-hidden /></Button></div>
          </div>
        </div></section>
        <section className="mx-auto grid max-w-7xl gap-8 px-5 py-16 sm:px-8 md:grid-cols-3">{[
          ['Institution workspace', 'Submit with clarity', 'Prepare applications, respond to deficiencies, and keep evidence and renewals on track.'],
          ['Officer workspace', 'Review with context', 'See assigned work, compare document versions, and take the next permitted action.'],
          ['Administrator workspace', 'See where work needs attention', 'Monitor deadlines, workload, and escalations across your permitted regions.'],
        ].map(([role, title, detail]) => <div key={role} className="border-t-2 border-primary pt-6"><p className="text-sm font-medium text-accent">{role}</p><h2 className="mt-3 text-xl font-semibold">{title}</h2><p className="mt-3 leading-relaxed text-ink-soft">{detail}</p></div>)}</section>
      </main>
      <footer className="border-t border-line px-5 py-8 text-sm leading-relaxed text-ink-soft sm:px-8"><div className="mx-auto flex max-w-7xl flex-wrap justify-between gap-4"><p><strong className="font-semibold text-ink">AICASA</strong><br />AICTE Integrated Compliance and Approval System for Administration</p><p>SIH26262 · Demonstration build<br />Synthetic data. No live AICTE connection.</p></div></footer>
    </div>
  );
}
