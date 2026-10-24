import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion, useInView, useReducedMotion } from 'motion/react';
import { Check, CornerDownLeft, FileText, RotateCcw, Send } from 'lucide-react';
import { Mark } from '@/components/layout/Wordmark';
import { cn } from '@/lib/cn';

// Landing page. Everything pictured is AICASA's own interface rebuilt at true size (data-ui fragments)
// with a single synthetic demo case. No official seals, no statistics, no testimonials.

const ease = [0.2, 0.8, 0.2, 1] as const;

function Rise({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.div className={className} initial={reduce ? false : { opacity: 0, y: 22 }} whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }} transition={{ duration: 0.55, delay, ease }}>
      {children}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// The case file: the fixed half. Entries appear as the reader reaches each part of the page.
// ---------------------------------------------------------------------------
const FILE_ENTRIES = [
  { at: '02 Sep 2026, 10:14', who: 'Priya Natarajan, institution', what: 'Application submitted', note: 'Extension of approval with intake increase, 2027-28', tone: 'ink' },
  { at: '02 Sep 2026, 10:14', who: 'Automatic, configured rule', what: 'Routed to scrutiny', note: 'Route: Scrutiny + EVC (conditional), version 1', tone: 'soft' },
  { at: '11 Sep 2026, 16:02', who: 'Anita Deshpande, scrutiny officer', what: 'Deficiency recorded', note: 'Fire safety certificate does not state its validity period', tone: 'warn' },
  { at: '11 Sep 2026, 16:05', who: 'Anita Deshpande, scrutiny officer', what: 'Returned for correction', note: 'Correction due 17 Sep 2026, 23:59 IST', tone: 'warn' },
  { at: '15 Sep 2026, 12:40', who: 'Priya Natarajan, institution', what: 'Correction submitted', note: 'Certificate replaced; version 1 kept on file', tone: 'ink' },
  { at: '16 Sep 2026, 09:18', who: 'Anita Deshpande, scrutiny officer', what: 'Deficiency resolved', note: 'Validity until 31 Mar 2029 confirmed', tone: 'ok' },
  { at: '16 Sep 2026, 09:20', who: 'Anita Deshpande, scrutiny officer', what: 'Routed to EVC', note: 'Intake increase declared, so the expert visit applies', tone: 'soft' },
  { at: '03 Oct 2026, 11:00', who: 'Rahul Kulkarni, EVC coordinator', what: 'EVC completed, satisfactory', note: 'Online visit, panel of two', tone: 'ok' },
  { at: '10 Oct 2026, 15:31', who: 'Meera Joshi, decision officer', what: 'Decision recorded: approved with conditions', note: 'Recorded by the competent officer, not by the system', tone: 'ink' },
  { at: '10 Oct 2026, 15:33', who: 'Meera Joshi, compliance officer', what: 'Undertaking opened', note: 'Occupancy certificate for library block, due 25 Nov 2026', tone: 'soft' },
] as const;
const STEP_ENTRIES = [2, 7, 10];
const NEXT = [
  [['Next action', 'Scrutiny review'], ['With', 'Anita Deshpande'], ['Target', '23 Sep 2026']],
  [['Next action', 'Schedule the EVC'], ['With', 'Rahul Kulkarni'], ['Target', '16 Oct 2026']],
  [['Next action', 'Submit evidence'], ['With', 'Institution'], ['Due', '25 Nov 2026']],
] as const;

function CaseFile({ step }: { step: number }) {
  const count = STEP_ENTRIES[Math.min(step, STEP_ENTRIES.length - 1)];
  const stages = ['Intake', 'Scrutiny', 'EVC', 'Decision', 'Closed'];
  const stageIdx = count <= 2 ? 1 : count <= 7 ? 2 : 4;
  return (
    <div data-ui className="flex h-full flex-col overflow-hidden rounded-[14px] border border-[#DDE4DF] bg-white text-[#17211D]">
      <div className={'border-b border-[#DDE4DF] px-6 py-5' /* taste-skill-ignore: data-ui fragment */}>
        <div className="flex items-center justify-between gap-4">
          <span className="text-[13px] font-medium text-[#236B9A]">DEMO-WR-2026-01002</span>
          <span className="rounded-md border border-[#eedcb1] bg-[#FBF1DC] px-2 py-0.5 text-[13px] font-medium text-[#7a5100]">Synthetic demo case</span>
        </div>
        <p className="mt-2 text-[20px] font-semibold leading-snug">Nirmala Institute of Technology (Demo)</p>
        <p className="text-[14px] text-[#5D6963]">Extension of approval with intake increase · 2027-28</p>
        <ol className="mt-4 flex gap-1.5" aria-label="Stages">
          {stages.map((s, i) => (
            <li key={s} className="flex-1">
              <motion.span className="block h-1.5 rounded-full" animate={{ backgroundColor: i < stageIdx ? '#176B5B' : i === stageIdx ? '#7FB7A9' : '#E2E8E4' }} transition={{ duration: 0.5 }} />
              <span className={cn('mt-1.5 block text-[13px]', i === stageIdx ? 'font-semibold text-[#17211D]' : 'text-[#5D6963]')}>{s}</span>
            </li>
          ))}
        </ol>
      </div>
      <ol className="flex-1 space-y-0 overflow-hidden px-6 py-4">
        <AnimatePresence initial={false}>
          {FILE_ENTRIES.slice(0, count).map((e, i) => (
            <motion.li key={i} layout initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.45, delay: Math.max(0, (i - (count - 4)) * 0.08), ease }} className="relative flex gap-3 pb-4">
              <span className={cn('relative mt-1.5 h-3 w-3 shrink-0 rounded-full border-2 bg-white',
                e.tone === 'warn' ? 'border-[#946200]' : e.tone === 'ok' ? 'border-[#168568] bg-[#168568]' : e.tone === 'soft' ? 'border-[#9AA8A1]' : 'border-[#176B5B]')} />
              <span className="min-w-0">
                <span className="block text-[15px] font-medium leading-snug">{e.what}</span>
                <span className="block text-[13px] text-[#5D6963]">{e.at} · {e.who}</span>
                <span className="mt-0.5 block text-[14px] text-[#3c4843]">{e.note}</span>
              </span>
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>
      <div className="mx-6 mb-3 hidden rounded-[10px] bg-[#F6F8F5] px-4 py-3.5 [@media(min-height:760px)]:block">
        <p className="text-[13px] text-[#5D6963]">Documents on file</p>
        <ul className="mt-1.5 space-y-1.5 text-[14px]">
          <li className="flex items-center justify-between gap-3"><span className="flex items-center gap-2"><FileText className="h-4 w-4 text-[#5D6963]" />Affidavit · v1</span><span className="text-[13px] font-medium text-[#168568]">Pre-check passed</span></li>
          <li className="flex items-center justify-between gap-3"><span className="flex items-center gap-2"><FileText className="h-4 w-4 text-[#5D6963]" />Fire safety certificate · {step === 0 ? 'v1' : 'v2, v1 kept'}</span>
            <span className={cn('text-[13px] font-medium', step === 0 ? 'text-[#946200]' : 'text-[#168568]')}>{step === 0 ? 'Pre-check: 1 to review' : 'Pre-check passed'}</span></li>
        </ul>
      </div>
      <AnimatePresence mode="wait">
        <motion.div key={step} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}
          className="mx-6 mb-4 grid grid-cols-3 gap-4 rounded-[10px] bg-[#F6F8F5] px-4 py-3.5">
          {NEXT[Math.min(step, NEXT.length - 1)].map(([label, value]) => (
            <div key={label} className="min-w-0"><p className="text-[13px] text-[#5D6963]">{label}</p><p className="mt-0.5 truncate text-[14px] font-medium">{value}</p></div>
          ))}
        </motion.div>
      </AnimatePresence>
      <div className="flex items-center justify-between bg-[#F0F3F0] px-6 py-3 text-[13px] text-[#5D6963]">
        <span>{count} entries · append-only</span><span>All times IST</span>
      </div>
    </div>
  );
}

function TransitionFragment() {
  return (
    <div data-ui className={'mt-5 rounded-[12px] border border-[#DDE4DF] bg-white text-[#17211D]' /* taste-skill-ignore: data-ui fragment */}>
      <div className={'border-b border-[#DDE4DF] px-4 py-3' /* taste-skill-ignore: data-ui fragment */}>
        <p className="text-[15px] font-semibold">Officer actions</p>
        <p className="text-[13px] text-[#5D6963]">DEMO-WR-2026-01005 · Scrutiny · 1 deficiency open</p>
      </div>
      <div className="space-y-3 px-4 py-4">
        <div>
          <span className="flex h-10 w-full items-center justify-between rounded-lg bg-[#F0F3F0] px-4 text-[14px] font-medium text-[#5D6963]" aria-disabled>Forward for decision <span aria-hidden>→</span></span>
          <p className="mt-1.5 text-[13px] text-[#5D6963]">All deficiencies must be resolved before this action.</p>
        </div>
        <div>
          <span className="flex h-10 w-full items-center justify-between rounded-lg bg-[#F0F3F0] px-4 text-[14px] font-medium text-[#5D6963]" aria-disabled>Route to EVC <span aria-hidden>→</span></span>
          <p className="mt-1.5 text-[13px] text-[#5D6963]">Route condition not met: intake_increase is not declared for this application.</p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live thing: drag a deficiency through the correction loop.
// ---------------------------------------------------------------------------
const LOOP = [
  { name: 'Recorded', clause: 'First, name the gap', status: 'Open', statusTone: 'warn', body: 'The fire safety certificate does not state a validity period, so its currency cannot be established.', foot: 'Visible to the officer · not yet sent' },
  { name: 'Returned', clause: 'Then return it, dated', status: 'Returned for correction', statusTone: 'warn', body: 'Upload a certificate that states its validity period, issued by the competent authority. Due 17 Sep 2026, 23:59 IST.', foot: 'Institution notified · reminder 72 hours before due' },
  { name: 'Corrected', clause: 'Next, a new version', status: 'Correction submitted', statusTone: 'info', body: 'fire_certificate_renewed.pdf uploaded as version 2. Version 1 stays on file with the reason for replacement.', foot: 'Upload alone does not resolve it · officer review task created' },
  { name: 'Resolved', clause: 'Last, an officer decides', status: 'Resolved', statusTone: 'ok', body: 'Validity until 31 Mar 2029 confirmed against the replacement copy. The route continues to the expert visit.', foot: 'Anita Deshpande · 16 Sep 2026, 09:18 IST' },
] as const;

function LoopFragment({ i }: { i: number }) {
  const s = LOOP[i];
  const tone = s.statusTone === 'warn' ? 'border-[#eedcb1] bg-[#FBF1DC] text-[#7a5100]' : s.statusTone === 'ok' ? 'border-[#c3e5d8] bg-[#E5F4EE] text-[#0f6b53]' : 'border-[#cfe0ee] bg-[#E7F0F7] text-[#236B9A]';
  return (
    <div data-ui className="w-full max-w-[440px] rounded-[12px] border border-[#DDE4DF] bg-white text-[#17211D] shadow-[0_12px_32px_rgba(23,33,29,0.12)]">
      <div className={'flex items-start justify-between gap-3 border-b border-[#DDE4DF] px-5 py-4' /* taste-skill-ignore: data-ui fragment */}>
        <div>
          <p className="text-[13px] font-medium text-[#236B9A]">DEMO-WR-2026-01002</p>
          <p className="mt-0.5 text-[16px] font-semibold">Fire safety certificate validity not stated</p>
        </div>
        <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-[13px] font-medium', tone)}>
          {s.statusTone === 'ok' ? <Check className="h-3.5 w-3.5" /> : s.statusTone === 'info' ? <Send className="h-3.5 w-3.5" /> : <RotateCcw className="h-3.5 w-3.5" />}{s.status}
        </span>
      </div>
      <AnimatePresence mode="wait">
        <motion.div key={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
          <p className="px-5 pt-4 text-[15px] leading-relaxed">{s.body}</p>
          {i >= 2 && (
            <div className="mx-5 mt-3 flex items-center gap-2 rounded-lg bg-[#F0F3F0] px-3 py-2 text-[13px] text-[#3c4843]">
              <FileText className="h-4 w-4 text-[#5D6963]" /> v2 · fire_certificate_renewed.pdf · 412 KB <span className="ml-auto text-[#5D6963]">v1 kept</span>
            </div>
          )}
          <p className="px-5 pb-4 pt-3 text-[13px] text-[#5D6963]">{s.foot}</p>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function LoopSection() {
  const [i, setI] = useState(0);
  const pct = (i / (LOOP.length - 1)) * 100;
  return (
    <section id="how" aria-labelledby="how-title" className="grid min-h-[88svh] grid-rows-[auto_auto] bg-[#EAEFEB] lg:grid-cols-2 lg:grid-rows-1">
      <div className="order-2 flex flex-col justify-between gap-10 px-5 pb-10 pt-10 sm:px-10 lg:order-1 lg:px-14 lg:pb-14 lg:pt-20">
        <AnimatePresence mode="wait">
          <motion.h2 id="how-title" key={i} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }}
            className="text-[11vw] font-semibold leading-[1.02] tracking-[-0.03em] text-[#17211D] sm:text-[clamp(40px,3.9vw,56px)]">
            {LOOP[i].clause}
          </motion.h2>
        </AnimatePresence>
        <div>
          <label htmlFor="loop" className="sr-only">Deficiency stage</label>
          <div className="relative h-10">
            <span aria-hidden className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-[#C9D3CD]" />
            <motion.span aria-hidden className="absolute left-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-[#17211D]" animate={{ width: `${pct}%` }} transition={{ duration: 0.2 }} />
            <input id="loop" type="range" min={0} max={LOOP.length - 1} step={1} value={i} onChange={(e) => setI(Number(e.target.value))}
              aria-valuetext={LOOP[i].name} className="loop-range absolute inset-0 h-10 w-full cursor-pointer appearance-none bg-transparent" />
          </div>
          <ol className="mt-3 grid grid-cols-2 gap-y-1 text-[17px] sm:grid-cols-4">
            {LOOP.map((s, k) => (
              <li key={s.name}><button onClick={() => setI(k)} className={cn('transition-colors', k === i ? 'font-semibold text-[#17211D]' : 'text-[#5D6963] hover:text-[#17211D]')}>{s.name}</button></li>
            ))}
          </ol>
        </div>
      </div>
      <div className="order-1 flex min-h-[46svh] items-center justify-center bg-[#DFE6E1] px-4 py-10 lg:order-2"><LoopFragment i={i} /></div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Outputs: what the system actually produces, each a sheet at true size.
// ---------------------------------------------------------------------------
const OUTPUTS = ['Pre-check report', 'Deficiency notice', 'EVC schedule', 'Renewal reminder'] as const;

function OutputSheet({ k }: { k: (typeof OUTPUTS)[number] }) {
  const row = (a: ReactNode, b: ReactNode, tone?: string) => (
    <div className={'flex items-start justify-between gap-4 border-b border-[#E7ECE8] py-2.5 text-[14px] last:border-0' /* taste-skill-ignore: data-ui fragment */}>
      <span>{a}</span><span className={cn('shrink-0 text-right font-medium', tone)}>{b}</span>
    </div>
  );
  const head = (title: string, sub: string) => (
    <div className="mb-5"><p className="text-[13px] font-medium text-[#236B9A]">AICASA · DEMO-WR-2026-01002</p><p className="mt-1 text-[20px] font-semibold">{title}</p><p className="text-[14px] text-[#5D6963]">{sub}</p></div>
  );
  if (k === 'Pre-check report') return (
    <div data-ui className="w-[min(560px,calc(100vw-48px))] rounded-[6px] bg-white px-7 py-7 text-[#17211D]">
      {head('Pre-submission check', 'fire_safety_certificate.pdf · version 1 · checklist v1')}
      {row('Accepted file type', 'Passed', 'text-[#168568]')}
      {row('File size within 5 MB', 'Passed', 'text-[#168568]')}
      {row('Readable text, 1 page', 'Passed', 'text-[#168568]')}
      {row('Institution name on record', 'Passed', 'text-[#168568]')}
      {row('Issue date: 05 Jan 2026', 'Passed', 'text-[#168568]')}
      {row(<>Validity / expiry date<span className="block text-[13px] text-[#5D6963]">Upload a version that states its validity period.</span></>, 'Missing information', 'text-[#B42318]')}
      <p className="mt-5 rounded-md bg-[#F0F3F0] px-3 py-2.5 text-[13px] text-[#3c4843]">Advisory only. Does not verify authenticity or legal sufficiency, and passing does not guarantee acceptance.</p>
    </div>
  );
  if (k === 'Deficiency notice') return (
    <div data-ui className="w-[min(560px,calc(100vw-48px))] rounded-[6px] bg-white px-7 py-7 text-[#17211D]">
      {head('Correction required', 'Returned 11 Sep 2026, 16:05 IST · 1 deficiency')}
      {row('Deficiency', 'Validity not stated')}
      {row('Requirement / source', 'Checklist EOA / fire safety (demo)')}
      {row('Requested correction', 'Certificate stating validity')}
      {row('Responsible party', 'Institution')}
      {row('Due', '17 Sep 2026, 23:59 IST', 'text-[#946200]')}
      {row('Recorded by', 'Anita Deshpande, WR')}
    </div>
  );
  if (k === 'EVC schedule') return (
    <div data-ui className="w-[min(440px,calc(100vw-48px))] rounded-[6px] bg-white px-7 py-7 text-[#17211D]">
      {head('Expert visit scheduled', 'Online EVC · cycle 1')}
      {row('Date', '03 Oct 2026')}
      {row('Time', '11:00 – 14:00 IST')}
      {row('Coordinator', 'Rahul Kulkarni')}
      {row('Panel', '2 officers')}
      {row('Panel conflicts', 'None found', 'text-[#168568]')}
      {row('Outcome due', '05 Oct 2026')}
    </div>
  );
  return (
    <div data-ui className="w-[min(300px,calc(100vw-48px))] rounded-[6px] bg-white px-6 py-6 text-[#17211D]">
      <p className="text-[13px] font-medium text-[#946200]">Reminder · 90 days ahead</p>
      <p className="mt-1 text-[18px] font-semibold leading-snug">Renew: campus land lease deed</p>
      <p className="mt-2 text-[14px] text-[#3c4843]">Recorded validity ends 07 Dec 2026. Submit the renewed deed for verification.</p>
      {row('Rule', 'Validity renewal v1')}
      {row('Sent', 'In-app')}
      {row('Email', 'Not configured', 'text-[#5D6963]')}
    </div>
  );
}

function OutputsSection() {
  const [k, setK] = useState<(typeof OUTPUTS)[number]>('Pre-check report');
  return (
    <section id="outputs" aria-label="What AICASA produces" className="grid gap-8 px-5 py-24 sm:px-10 lg:grid-cols-12 lg:gap-6 lg:px-14 lg:py-40">
      <Rise className="lg:col-span-5">
        <ul className="flex flex-wrap gap-x-6 gap-y-2 lg:flex-col lg:gap-1" role="tablist" aria-label="Outputs">
          {OUTPUTS.map((o) => (
            <li key={o} className="shrink-0">
              <button role="tab" aria-selected={k === o} onClick={() => setK(o)}
                className={cn('text-left text-[28px] font-semibold leading-[1.1] tracking-[-0.02em] transition-colors duration-150 sm:text-[clamp(36px,3.9vw,56px)]',
                  k === o ? 'text-[#17211D]' : 'text-[#5D6963] hover:text-[#17211D]')}>{o}</button>
            </li>
          ))}
        </ul>
        <p className="mt-8 max-w-[40ch] text-[17px] leading-relaxed text-[#3c4843]">Each record is generated from the case itself, under the configured checklist or rule, and keeps its version and source.</p>
      </Rise>
      <div className="relative h-[70svh] overflow-hidden rounded-[6px] bg-[#EAEFEB] lg:col-span-7 lg:h-[88svh]">
        <AnimatePresence mode="wait">
          <motion.div key={k} className="absolute left-4 top-6 sm:left-16 sm:top-[72px]" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
            <OutputSheet k={k} />
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Capabilities as a printed sheet
// ---------------------------------------------------------------------------
const MENU = [
  { group: 'Routing', items: [
    ['Configured routes', 'versioned', 'Scrutiny only, scrutiny with conditional EVC, EVC with SAC/SHC, EVC only.'],
    ['Transition checks', 'server-side', 'Role, region, prerequisites and reasons checked before any stage changes.'],
    ['Correction loops', 'unlimited', 'Return, correct, re-review; every attempt stays on file.'],
  ] },
  { group: 'Compliance', items: [
    ['Undertakings and conditions', 'tracked', 'Due, submitted, verified or needing correction, as separate states.'],
    ['Document validity', '90-day lead', 'Renewal obligations open automatically from the configured lead time.'],
    ['Pre-submission check', 'advisory', 'Deterministic checks with evidence; unreadable files go to manual review.'],
  ] },
  { group: 'Oversight', items: [
    ['Reminders and escalation', 'idempotent', 'A repeated scan never sends the same alert twice.'],
    ['Audit log', 'append-only', 'Actor, time, reason and state change for every significant action.'],
    ['Reports', 'scoped', 'Exports contain only the records your role may see.'],
  ] },
] as const;

function MenuSection() {
  return (
    <section aria-labelledby="menu-title" className="bg-[#176B5B] px-3 py-24 sm:px-10 lg:py-36">
      <Rise className="mx-auto w-full max-w-[600px]">
        <div className="menu-sheet bg-[#F6F8F5] px-5 pb-14 pt-14 text-[#17211D] sm:px-12">
          <h2 id="menu-title" className="text-center text-[40px] font-semibold leading-none tracking-[-0.03em] sm:text-[56px]">What it does</h2>
          <div className="mt-10 space-y-11">
            {MENU.map((g, gi) => (
              <div key={g.group}>
                <p className="text-[17px] font-bold">{g.group}</p>
                <ul className="mt-3 space-y-[18px]">
                  {g.items.map(([name, value, desc], ii) => (
                    <motion.li key={name} initial={{ opacity: 0, x: -8 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true }} transition={{ duration: 0.4, delay: gi * 0.06 + ii * 0.07 }}>
                      <div className="flex items-baseline gap-2">
                        <span className="text-[17px] font-medium">{name}</span>
                        <span aria-hidden className={'mb-1 flex-1 border-b-4 border-dotted border-[#C5D0C9]' /* taste-skill-ignore: dot leader of the printed sheet */} />
                        <span className="text-[14px] font-medium text-[#176B5B]">{value}</span>
                      </div>
                      <p className="mt-0.5 max-w-[34ch] text-[14px] text-[#5D6963]">{desc}</p>
                    </motion.li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </Rise>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
function useStep(refs: React.RefObject<HTMLElement>[]) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) setStep(Number((e.target as HTMLElement).dataset.step));
    }, { rootMargin: '-45% 0px -45% 0px' });
    refs.forEach((r) => r.current && io.observe(r.current));
    return () => io.disconnect();
  }, [refs]);
  return step;
}

export function LandingPage() {
  const nav = useNavigate();
  const hero = useRef<HTMLElement>(null);
  const roles = useRef<HTMLElement>(null);
  const letter = useRef<HTMLElement>(null);
  const refsRef = useRef([hero, roles, letter] as React.RefObject<HTMLElement>[]);
  const step = useStep(refsRef.current);
  const [who, setWho] = useState<'institution' | 'staff'>('institution');
  const [email, setEmail] = useState('inst.nirmala@aicasa-demo.test');
  const ctaRef = useRef<HTMLDivElement>(null);
  const ctaIn = useInView(ctaRef, { once: true, margin: '-80px' });
  const reduce = useReducedMotion();
  useEffect(() => { document.title = 'AICASA · Approval workflow and compliance prototype'; }, []);

  return (
    <div className="bg-[#F6F8F5] text-[#17211D]">
      <style>{`
        .menu-sheet { clip-path: polygon(${Array.from({ length: 31 }, (_, i) => `${(i / 30) * 100}% ${i % 2 ? 10 : 0}px`).join(',')}, 100% calc(100% - 10px), ${Array.from({ length: 31 }, (_, i) => `${100 - (i / 30) * 100}% calc(100% - ${i % 2 ? 0 : 10}px)`).join(',')}); }
        .loop-range::-webkit-slider-thumb { appearance: none; width: 32px; height: 32px; background: #176B5B; border-radius: 4px; cursor: grab; transition: transform .12s ease; }
        .loop-range::-webkit-slider-thumb:active { transform: scale(1.08); cursor: grabbing; }
        .loop-range::-moz-range-thumb { width: 32px; height: 32px; background: #176B5B; border: 0; border-radius: 4px; }
        .loop-range:focus-visible { outline: 2px solid #236B9A; outline-offset: 4px; }
        @media (max-width: 1023px) { .loop-range::-webkit-slider-thumb { width: 40px; height: 40px; } }
      `}</style>

      {/* Split stage: reading column left, the case file fixed right */}
      <div className="grid gap-3 p-3 lg:grid-cols-2">
        <div className="space-y-3">
          <section ref={hero} data-step={0} aria-labelledby="hero-title" className="overflow-hidden rounded-[14px] bg-white lg:min-h-[calc(100svh-24px)]">
            <div className="flex h-10 sm:h-14" aria-hidden>
              {Array.from({ length: 24 }).map((_, i) => (
                <motion.span key={i} className={cn('h-full flex-1', i % 2 ? 'bg-white' : 'bg-[#176B5B]')}
                  initial={reduce ? false : { scaleY: 0 }} animate={{ scaleY: 1 }} transition={{ duration: 0.5, delay: 0.02 * i, ease }} style={{ transformOrigin: 'top' }} />
              ))}
            </div>
            <div className="flex flex-col items-center px-6 pb-10 pt-12 text-center sm:px-12 lg:min-h-[calc(100svh-80px)] lg:justify-center lg:pt-0">
              <Rise><span className="inline-flex items-center gap-3"><Mark className="h-10 w-10" /><span className="text-[28px] font-semibold tracking-[-0.03em]">AICASA</span></span></Rise>
              <Rise delay={0.08}><p className="mt-3 text-[14px] text-[#5D6963]">AICTE Integrated Compliance and Approval System for Administration</p></Rise>
              <Rise delay={0.16}>
                <h1 id="hero-title" className="mt-10 max-w-[16ch] text-[10vw] font-semibold leading-[1.04] tracking-[-0.035em] sm:text-[clamp(40px,3.9vw,56px)]">Every approval case, one file</h1>
              </Rise>
              <Rise delay={0.24}>
                <p className="mx-auto mt-6 max-w-[42ch] text-[17px] leading-relaxed text-[#3c4843]">
                  A working prototype that routes approval applications through configured stages and keeps deficiencies, expert visits, compliance and document expiry on one dated record.
                </p>
              </Rise>
              <Rise delay={0.32}>
                <motion.div whileHover={{ y: -1 }} whileTap={{ y: 1 }} className="mt-8">
                  <Link to="/sign-in" className="inline-flex h-12 items-center rounded-[6px] bg-[#176B5B] px-7 text-[17px] font-semibold text-white transition-colors duration-150 hover:bg-[#125548]">Sign in</Link>
                </motion.div>
              </Rise>
              <Rise delay={0.4}>
                <nav aria-label="On this page" className="mt-14 flex flex-wrap justify-center gap-x-7 gap-y-2 text-[14px]">
                  <a href="#roles" className="text-[#17211D] underline-offset-4 hover:underline">Routes and roles</a>
                  <a href="#how" className="text-[#17211D] underline-offset-4 hover:underline">How a correction works</a>
                  <a href="#outputs" className="text-[#17211D] underline-offset-4 hover:underline">What it produces</a>
                </nav>
              </Rise>
              <p className="mt-10 max-w-[48ch] text-[14px] text-[#5D6963]">SIH26262 student prototype with synthetic data. Not an official AICTE service and not connected to any AICTE system.</p>
            </div>
          </section>

          <div className="h-[70svh] lg:hidden" aria-label="Example case file (synthetic)"><CaseFile step={step} /></div>

          <section ref={roles} id="roles" data-step={1} aria-labelledby="roles-title" className="rounded-[14px] bg-[#F6F8F5] px-6 py-24 sm:px-12 lg:py-32">
            <div className="mx-auto max-w-[520px]">
              <Rise><h2 id="roles-title" className="text-[28px] font-semibold tracking-[-0.02em]">Routes and the people on them</h2></Rise>
              <Rise delay={0.08}>
                <p className="mt-8 text-[14px] text-[#5D6963]">Routes</p>
                <ul className="mt-2">
                  {[['#176B5B', 'Scrutiny only', '4 stages'], ['#236B9A', 'Scrutiny, then EVC if intake rises', '5 stages'], ['#946200', 'EVC, then SAC/SHC committee', '5 stages'], ['#5D6963', 'EVC only', '4 stages']].map(([c, n, v]) => (
                    <li key={n} className="flex min-h-[38px] items-center justify-between gap-4 text-[17px]">
                      <span className="flex items-center gap-2"><span className="h-4 w-4 shrink-0 rounded-full" style={{ background: c }} aria-hidden />{n}</span>
                      <span className="tabular text-[14px] text-[#5D6963]">{v}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-[14px] text-[#5D6963]">The route comes from the application type. Institutions cannot pick one to skip a stage, and an officer cannot move a case past a stage whose conditions are unmet:</p>
                <TransitionFragment />
              </Rise>
              <Rise delay={0.16}>
                <p className="mt-12 text-[14px] text-[#5D6963]">Workspaces</p>
                <ul className="mt-2">
                  {[['#17211D', 'College or university', 'own records only'], ['#176B5B', 'AICTE officer', 'region and responsibility'], ['#236B9A', 'AICTE administrator', 'scoped oversight, no decisions']].map(([c, n, v]) => (
                    <li key={n} className="flex min-h-[38px] items-center justify-between gap-4 text-[17px]">
                      <span className="flex items-center gap-2"><span className="h-4 w-4 shrink-0 rounded-full" style={{ background: c }} aria-hidden />{n}</span>
                      <span className="text-right text-[14px] text-[#5D6963]">{v}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-[14px] text-[#5D6963]">A university sees an affiliated college only through an explicit, revocable grant.</p>
              </Rise>
            </div>
          </section>

          <section ref={letter} data-step={2} aria-label="A note on this prototype" className="rounded-[14px] bg-white px-6 py-24 sm:px-12 lg:py-40">
            <Rise className="mx-auto max-w-[520px] space-y-5 text-[17px] leading-[1.6] text-[#17211D]">
              <Mark className="h-10 w-10" />
              <p className="pt-2">We built AICASA to answer one question for any approval case: where is it, who has it, and what is due next.</p>
              <p>The system routes, reminds and records. <span className="bg-[#E6F1EE] px-1">It never approves or rejects anything.</span> Scrutiny, expert visits and decisions stay with the officers responsible, and every one of their actions carries a name, a time and a reason.</p>
              <p>Every case, document, deadline and rule you will see inside is synthetic demonstration data. The routes and timelines are illustrative and must be checked against the current Approval Process Handbook before any real use.</p>
              <p>Access is assigned, not chosen. There is no public sign-up, and permissions are enforced by the database itself, not by the screen.</p>
              <div className="pt-3"><p className="text-[17px] font-semibold">The SIH26262 prototype team</p><p className="text-[14px] text-[#5D6963]">Smart India Hackathon submission</p></div>
            </Rise>
          </section>
        </div>

        <aside className="hidden lg:block" aria-label="Example case file (synthetic)">
          <div className="lg:sticky lg:top-3 lg:h-[calc(100svh-24px)]">
            <AnimatePresence mode="wait">
              <motion.div key={step} className="h-full" initial={reduce ? false : { opacity: 0.6 }} animate={{ opacity: 1 }} transition={{ duration: 1.2, ease }}>
                <CaseFile step={step} />
              </motion.div>
            </AnimatePresence>
          </div>
        </aside>
      </div>

      <LoopSection />
      <OutputsSection />
      <MenuSection />

      {/* First step, already open */}
      <section aria-labelledby="cta-title" className="grid min-h-[90svh] gap-10 bg-[#17211D] px-5 py-16 sm:px-10 lg:grid-cols-12 lg:px-14">
        <div className="flex flex-col justify-end lg:col-span-5 lg:pb-10">
          <Rise><h2 id="cta-title" className="text-[13vw] font-semibold leading-[0.92] tracking-[-0.04em] text-white sm:text-[clamp(56px,7.2vw,104px)]">Open the file</h2></Rise>
          <Rise delay={0.1}><p className="mt-6 max-w-[36ch] text-[17px] leading-relaxed text-white/80">Sign in with an account your administrator issued. Demo accounts are created by the provisioning script described in the README.</p></Rise>
        </div>
        <div ref={ctaRef} className="flex items-end lg:col-span-6 lg:col-start-7 lg:items-center">
          <motion.form data-ui initial={reduce ? false : { opacity: 0, y: 24 }} animate={ctaIn ? { opacity: 1, y: 0 } : {}} transition={{ duration: 0.5, ease }}
            onSubmit={(e) => { e.preventDefault(); nav(`/sign-in?email=${encodeURIComponent(email)}`); }}
            className={'w-full max-w-[440px] rounded-[12px] border border-[#DDE4DF] bg-white p-6 text-[#17211D] shadow-[0_12px_32px_rgba(0,0,0,0.28)]' /* taste-skill-ignore: data-ui dialog */}>
            <p className="text-[18px] font-semibold">Sign in to AICASA</p>
            <p className="mt-1 text-[14px] text-[#5D6963]">Accounts are issued by an administrator.</p>
            <div className="mt-5 grid grid-cols-2 rounded-lg bg-[#F0F3F0] p-1 text-[14px] font-medium" role="radiogroup" aria-label="Example account">
              {(['institution', 'staff'] as const).map((w) => (
                <button key={w} type="button" role="radio" aria-checked={who === w}
                  onClick={() => { setWho(w); setEmail(w === 'institution' ? 'inst.nirmala@aicasa-demo.test' : 'officer.wr.scrutiny@aicasa-demo.test'); }}
                  className={cn('relative rounded-md py-2 transition-colors', who === w ? 'text-[#17211D]' : 'text-[#5D6963] hover:text-[#17211D]')}>
                  {who === w && <motion.span layoutId="seg" className={'absolute inset-0 rounded-md bg-white shadow-[0_1px_2px_rgba(23,33,29,0.12)]' /* taste-skill-ignore: data-ui control */} transition={{ duration: 0.2 }} />}
                  <span className="relative">{w === 'institution' ? 'Institution' : 'AICTE staff'}</span>
                </button>
              ))}
            </div>
            <label htmlFor="cta-email" className="mt-5 block text-[14px] font-medium">Email</label>
            <input id="cta-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username"
              className="mt-1.5 h-12 w-full rounded-lg border border-[#DDE4DF] px-3 text-[16px] outline-none transition-colors focus:border-[#236B9A] focus:ring-2 focus:ring-[#236B9A]/20" />
            <p className="mt-2 text-[13px] text-[#5D6963]">The choice only fills an example address. Your actual role comes from your account.</p>
            <motion.button whileTap={{ y: 1 }} type="submit" className="mt-5 inline-flex h-[52px] w-full items-center justify-center gap-2 rounded-[6px] bg-[#176B5B] text-[16px] font-semibold text-white transition-colors hover:bg-[#125548]">
              Continue <CornerDownLeft className="h-4 w-4" aria-hidden />
            </motion.button>
          </motion.form>
        </div>
      </section>

      <footer className="px-5 pb-[30px] pt-[30svh] text-[14px] sm:px-10 lg:px-14">
        <div className="grid gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-baseline">
          <span className="text-[#5D6963]">SIH26262 prototype, synthetic data</span>
          <span className="flex flex-wrap gap-6"><Link to="/sign-in" className="hover:underline">Sign in</Link><a href="#how" className="hover:underline">How it works</a><a href="#roles" className="hover:underline">Roles</a></span>
          <span className="text-[#5D6963] sm:text-right">2026 · Not an official AICTE service</span>
        </div>
      </footer>
    </div>
  );
}
