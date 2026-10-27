import { useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { motion } from 'motion/react';
import { ArrowLeft, Eye, EyeOff, KeyRound, ShieldAlert } from 'lucide-react';
import { supabase, isConfigured } from '@/lib/supabase';
import { Button, ButtonLink } from '@/components/ui/Button';
import { SelectField, TextField } from '@/components/ui/Field';
import { Notice } from '@/components/ui/States';
import { Wordmark } from '@/components/layout/Wordmark';
import { useAuth } from './AuthProvider';
import { errorMessage } from '@/lib/errors';

function AuthFrame({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-page">
      <header className="px-4 py-5 sm:px-8"><Link to="/" aria-label="AICASA home"><Wordmark /></Link></header>
      <main className="flex flex-1 items-start justify-center px-4 pb-16 pt-6 sm:pt-14">
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}
          className="w-full max-w-[420px] rounded-2xl border border-line bg-surface p-6 shadow-card sm:p-8">
          <h1 className="text-xl font-semibold text-ink">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-ink-soft">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </motion.div>
      </main>
      <footer className="px-4 pb-6 text-center text-xs text-ink-soft">SIH26262 prototype · synthetic data · not an official AICTE service</footer>
    </div>
  );
}

function NotConfigured() {
  return (
    <Notice tone="warning" title="Backend not configured">
      Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> in <code>.env.local</code>, then restart the dev server. See the README.
    </Notice>
  );
}

const OPEN_DEMO = import.meta.env.VITE_OPEN_DEMO === 'true';

/** Asks the demo-session function for a one-time token for the persona's synthetic account and signs in with it. */
async function startDemoSession(persona: string) {
  const { data, error } = await supabase.functions.invoke('demo-session', { body: { persona } });
  if (error || !data?.token_hash) {
    let msg = 'Could not start the demo.';
    try { const b = await (error as { context?: Response }).context?.json(); if (b?.error) msg = b.error; } catch { /* default */ }
    throw new Error(data?.error ?? msg);
  }
  const { error: vErr } = await supabase.auth.verifyOtp({ token_hash: data.token_hash, type: 'magiclink' });
  if (vErr) throw vErr;
}

/** The shared demonstration login, already filled in on the sign-in page. The role the visitor picks decides which synthetic account opens. */
const DEMO_EMAIL = 'demo123@gmail.com';
const DEMO_PASSWORD = 'Demo@1234';
const DEMO_ROLES: [persona: string, label: string][] = [['institution', 'College / institute'], ['officer', 'Officer'], ['admin', 'Administrative']];

/** TEMPORARY open-demo entry: no credentials. The server function checks a database switch and mints a one-time token. */
function DemoPicker() {
  const nav = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const enter = async (persona: string) => {
    setErr(null); setBusy(persona);
    try {
      await startDemoSession(persona);
      nav('/app', { replace: true });
    } catch (e) { setErr(errorMessage(e)); setBusy(null); }
  };
  const roles = [
    ['institution', 'College / university', 'Submit applications, answer deficiencies, track compliance.'],
    ['officer', 'AICTE officer', 'Work the queue, scrutinise, record deficiencies, route applications.'],
    ['admin', 'Administrator', 'Pendency, escalations, workflow routes, audit and reports.'],
  ];
  return (
    <div className="space-y-3">
      {err && <div role="alert"><Notice tone="danger">{err}</Notice></div>}
      {roles.map(([k, t, d]) => (
        <button key={k} onClick={() => enter(k)} disabled={!!busy}
          className="flex w-full items-start justify-between gap-3 rounded-xl border border-line bg-surface p-4 text-left transition-colors hover:border-primary hover:bg-primary-soft/40 disabled:opacity-60">
          <span><span className="block text-[14px] font-semibold text-ink">{t}</span><span className="mt-0.5 block text-[13px] text-ink-soft">{d}</span></span>
          <span className="mt-0.5 text-[13px] font-medium text-primary">{busy === k ? 'Opening…' : 'Enter'}</span>
        </button>
      ))}
      <p className="border-t border-line pt-3 text-xs leading-relaxed text-ink-soft">Temporary open demo. You enter a synthetic demo account; all data is fictional and anyone with this link can change it.</p>
    </div>
  );
}

const signInSchema = z.object({ email: z.string().email('Enter a valid email address.'), password: z.string().min(1, 'Enter your password.'), role: z.string() });

export function SignInPage() {
  const { status } = useAuth();
  const nav = useNavigate();
  const [err, setErr] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  const prefill = new URLSearchParams(window.location.search).get('email') ?? '';
  const form = useForm<z.infer<typeof signInSchema>>({ resolver: zodResolver(signInSchema), defaultValues: { email: prefill || DEMO_EMAIL, password: prefill ? '' : DEMO_PASSWORD, role: DEMO_ROLES[0][0] } });

  // the role comes from the account itself; a sign-in never resumes a page remembered from another account or role
  if (status === 'ready') return <Navigate to="/app" replace />;

  const onSubmit = form.handleSubmit(async (v) => {
    setErr(null);
    if (v.email.trim().toLowerCase() === DEMO_EMAIL && v.password === DEMO_PASSWORD) {
      try { await startDemoSession(v.role); nav('/app', { replace: true }); } catch (e) { setErr(errorMessage(e)); }
      return;
    }
    const { error } = await supabase.auth.signInWithPassword({ email: v.email, password: v.password });
    if (error) setErr(error.message === 'Invalid login credentials' ? 'Email or password is incorrect.' : errorMessage(error));
    else nav('/app', { replace: true });
  });

  return (
    <AuthFrame title={OPEN_DEMO ? 'Explore the AICASA demo' : 'Sign in to AICASA'} subtitle={OPEN_DEMO ? 'Choose a role to enter. No sign-in needed.' : 'Accounts are issued by an administrator. There is no public sign-up.'}>
      {!isConfigured ? <NotConfigured /> : OPEN_DEMO ? <DemoPicker /> : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {err && <div role="alert"><Notice tone="danger">{err}</Notice></div>}
          <TextField label="Email" type="email" autoComplete="username" required {...form.register('email')} error={form.formState.errors.email?.message} />
          <div className="relative">
            <TextField label="Password" type={show ? 'text' : 'password'} autoComplete="current-password" required className="pr-11" {...form.register('password')} error={form.formState.errors.password?.message} />
            <button type="button" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}
              className="absolute right-1 top-[30px] flex h-9 w-9 items-center justify-center rounded-md text-ink-soft hover:bg-surface-muted hover:text-ink">
              {show ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
            </button>
          </div>
          <SelectField label="Role" required {...form.register('role')}>
            {DEMO_ROLES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
          </SelectField>
          <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>Sign in</Button>
          <div className="flex justify-between text-[13px]">
            <Link to="/forgot-password" className="text-accent hover:underline">Forgot password?</Link>
            <Link to="/" className="text-ink-soft hover:text-ink">About this prototype</Link>
          </div>
          <p className="border-t border-line pt-4 text-xs leading-relaxed text-ink-soft">
            The demonstration login is filled in for you: choose a role and sign in. Sessions expire after an hour of inactivity and refresh automatically while you work.
          </p>
        </form>
      )}
    </AuthFrame>
  );
}

export function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const form = useForm<{ email: string }>({ resolver: zodResolver(z.object({ email: z.string().email('Enter a valid email address.') })) });
  const onSubmit = form.handleSubmit(async (v) => {
    setErr(null);
    const { error } = await supabase.auth.resetPasswordForEmail(v.email, { redirectTo: `${window.location.origin}/reset-password` });
    if (error) setErr(errorMessage(error)); else setSent(true);
  });
  return (
    <AuthFrame title="Reset your password" subtitle="We will email a reset link if the address belongs to an account.">
      {!isConfigured ? <NotConfigured /> : sent ? (
        <div className="space-y-4">
          <Notice tone="success">If an account exists for that address, a reset link is on its way. Delivery depends on the project's email settings.</Notice>
          <ButtonLink to="/sign-in" variant="secondary" icon={<ArrowLeft className="h-4 w-4" />}>Back to sign in</ButtonLink>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {err && <Notice tone="danger">{err}</Notice>}
          <TextField label="Email" type="email" required {...form.register('email')} error={form.formState.errors.email?.message} />
          <Button type="submit" className="w-full" loading={form.formState.isSubmitting} icon={<KeyRound className="h-4 w-4" />}>Send reset link</Button>
          <Link to="/sign-in" className="block text-center text-[13px] text-accent hover:underline">Back to sign in</Link>
        </form>
      )}
    </AuthFrame>
  );
}

const resetSchema = z.object({
  password: z.string().min(10, 'Use at least 10 characters.'),
  confirm: z.string(),
}).refine((v) => v.password === v.confirm, { message: 'Passwords do not match.', path: ['confirm'] });

export function ResetPasswordPage() {
  const nav = useNavigate();
  const [err, setErr] = useState<string | null>(null);
  const form = useForm<z.infer<typeof resetSchema>>({ resolver: zodResolver(resetSchema) });
  const onSubmit = form.handleSubmit(async (v) => {
    setErr(null);
    const { error } = await supabase.auth.updateUser({ password: v.password });
    if (error) setErr(errorMessage(error)); else nav('/app', { replace: true });
  });
  return (
    <AuthFrame title="Choose a new password">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {err && <Notice tone="danger">{err} The reset link may have expired; request a new one.</Notice>}
        <TextField label="New password" type="password" autoComplete="new-password" required {...form.register('password')} error={form.formState.errors.password?.message} />
        <TextField label="Confirm password" type="password" autoComplete="new-password" required {...form.register('confirm')} error={form.formState.errors.confirm?.message} />
        <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>Update password</Button>
      </form>
    </AuthFrame>
  );
}

export function UnauthorisedPage() {
  const { status, signOut, error } = useAuth();
  return (
    <AuthFrame title="Access not available" subtitle="Your sign-in worked, but this account has no active role.">
      <div className="space-y-4">
        <Notice tone="warning" icon={<ShieldAlert className="h-4 w-4" />}>
          {status === 'error' ? `Your access could not be loaded: ${error}` :
            'Roles are assigned by an authorised administrator. If you expected access, contact your regional administrator. Changing a URL or browser setting cannot grant access.'}
        </Notice>
        <div className="flex gap-2">
          {status !== 'signed_out' && <Button variant="secondary" onClick={() => signOut()}>Sign out</Button>}
          <ButtonLink to="/" variant="ghost">Home</ButtonLink>
        </div>
      </div>
    </AuthFrame>
  );
}

export function NotFoundPage() {
  return (
    <AuthFrame title="Page not found" subtitle="The address may be mistyped, or the page has moved.">
      <div className="flex gap-2">
        <ButtonLink to="/app">Go to my dashboard</ButtonLink>
        <ButtonLink to="/" variant="secondary">Home</ButtonLink>
      </div>
    </AuthFrame>
  );
}
