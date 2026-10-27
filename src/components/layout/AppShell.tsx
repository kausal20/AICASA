import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import * as RD from '@radix-ui/react-dialog';
import * as DM from '@radix-ui/react-dropdown-menu';
import * as TT from '@radix-ui/react-tooltip';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck, ChevronDown, ChevronRight, FlaskConical, LogOut, Menu, Repeat, Search, UserRound, X } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthProvider';
import { NAV, ROLE_LABEL, findNav, titleFor, type NavGroup } from './nav';
import { Wordmark } from './Wordmark';
import { DisplayPreferences } from './DisplayPreferences';
import { Glossary } from '@/features/help/Glossary';
import { cn } from '@/lib/cn';
import { listNotifications, markRead } from '@/services/operations';
import { useNavCounts } from '@/hooks/useNavCounts';
import { fmtDateTime, humanize, notificationDue, plainText } from '@/lib/format';
import { responsibilityLabel } from '@/lib/responsibilities';
import type { Role } from '@/types/domain';

const COLLAPSE_KEY = 'aicasa.nav.collapsed';
function readCollapsed(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '{}'); } catch { return {}; }
}

function NavBadge({ n, tone }: { n?: number; tone?: 'danger' | 'warning' | 'neutral' }) {
  if (!n) return null;
  return (
    <span className={cn('ml-auto min-w-[20px] rounded-full px-1.5 text-center text-[11px] font-semibold leading-5 tabular',
      tone === 'danger' ? 'bg-danger text-white' : tone === 'warning' ? 'bg-warning-soft text-[#7a5100]' : 'bg-surface-sunken text-ink-soft')}>
      {n > 99 ? '99+' : n}
    </span>
  );
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const { workspace, can } = useAuth();
  const counts = useNavCounts();
  const loc = useLocation();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readCollapsed);
  const toggle = (id: string) => {
    const next = { ...collapsed, [id]: !collapsed[id] };
    setCollapsed(next);
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next)); } catch { /* preference only */ }
  };
  if (!workspace) return null;
  const activeGroup = findNav(loc.pathname, workspace)?.group.id;
  return (
    <nav aria-label="Main" className="space-y-1">
      {NAV[workspace].map((g: NavGroup) => {
        const items = g.items.filter((i) => !i.capability || can(i.capability));
        if (!items.length) return null;
        // A group holding the current page never hides it.
        const isOpen = !collapsed[g.id] || activeGroup === g.id;
        const groupCount = items.reduce((a, i) => a + (i.badge && i.badgeTone !== 'neutral' ? counts[i.badge] ?? 0 : 0), 0);
        return (
          <div key={g.id} className="pb-1">
            <button onClick={() => toggle(g.id)} aria-expanded={isOpen} aria-controls={`nav-${g.id}`}
              className="flex w-full items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold text-ink-faint hover:text-ink-soft">
              <ChevronDown className={cn('h-3 w-3 transition-transform duration-150', !isOpen && '-rotate-90')} aria-hidden />
              {g.label}
              {!isOpen && groupCount > 0 && <span className="ml-auto h-2 w-2 rounded-full bg-danger" aria-label={`${groupCount} items need attention`} />}
            </button>
            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.ul id={`nav-${g.id}`} initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.18 }} className="space-y-0.5 overflow-hidden">
                  {items.map((i) => (
                    <li key={i.to}>
                      <NavLink to={i.to} end={i.end ?? i.to === '/app/applications'} onClick={onNavigate}
                        className={({ isActive }) => cn(
                          'nav-item relative flex items-center gap-2.5 rounded-lg px-3 py-[7px] text-sm font-medium transition-colors duration-200',
                          isActive ? 'bg-primary-soft text-primary-ink' : 'text-ink-soft hover:bg-surface-muted hover:text-ink',
                        )}>
                        {({ isActive }) => (
                          <>
                            {isActive && <motion.span layoutId="nav-active" className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-primary" transition={{ duration: 0.2 }} />}
                            <i.icon className={cn('h-4 w-4 shrink-0', isActive ? 'text-primary' : 'text-ink-faint')} aria-hidden />
                            <span className="truncate">{i.label}</span>
                            <NavBadge n={i.badge ? counts[i.badge] : undefined} tone={i.badgeTone} />
                          </>
                        )}
                      </NavLink>
                    </li>
                  ))}
                </motion.ul>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </nav>
  );
}

function ScopeCard() {
  const { workspace, activeAssignments, institution, context, setInstitution } = useAuth();
  if (workspace === 'institution') {
    const insts = context?.institutions ?? [];
    return (
      <div className="rounded-xl bg-surface-muted px-3 py-2.5">
        <p className="text-[11px] font-medium text-ink-faint">Institution</p>
        {insts.length > 1 ? (
          <select aria-label="Switch institution" className="mt-0.5 w-full bg-transparent text-[13px] font-medium text-ink" value={institution?.id}
            onChange={(e) => setInstitution(e.target.value)}>
            {insts.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        ) : <p className="mt-0.5 text-[13px] font-medium leading-snug text-ink">{institution?.name ?? 'No institution'}</p>}
        {(context?.granted_institutions.length ?? 0) > 0 && (
          <p className="mt-1 text-[11px] text-ink-soft">Read access to {context!.granted_institutions.length} affiliated institution{context!.granted_institutions.length > 1 ? 's' : ''}</p>
        )}
      </div>
    );
  }
  const regions = activeAssignments.map((a) => a.region_code ?? 'National');
  const caps = [...new Set(activeAssignments.flatMap((a) => a.capabilities))];
  return (
    <div className="rounded-xl bg-surface-muted px-3 py-2.5">
      <p className="text-[11px] font-medium text-ink-faint">{workspace ? ROLE_LABEL[workspace] : ''} · scope</p>
      <p className="mt-0.5 text-[13px] font-semibold text-ink">{regions.join(', ')}{regions[0] !== 'National' && ' region'}</p>
      <p className="mt-1 text-[11px] leading-snug text-ink-soft">{caps.map(responsibilityLabel).join(' · ') || 'No responsibilities'}</p>
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className="px-5 pb-4 pt-5"><Link to="/app" onClick={onNavigate} aria-label="AICASA dashboard"><Wordmark /></Link></div>
      <div className="px-3 pb-3"><ScopeCard /></div>
      <div className="flex-1 overflow-y-auto px-2 pb-4"><SidebarNav onNavigate={onNavigate} /></div>
      <div className="border-t border-line px-5 py-3">
        <p className="flex items-start gap-2 text-[11px] leading-snug text-ink-soft"><FlaskConical className="mt-px h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
          SIH26262 prototype. Synthetic data only; not an official AICTE system.</p>
      </div>
    </div>
  );
}

function NotificationsMenu() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const counts = useNavCounts();
  const list = useQuery({ queryKey: ['notifications', 'recent'], queryFn: () => listNotifications(8) });
  const n = counts.unread ?? 0;
  const refresh = () => { qc.invalidateQueries({ queryKey: ['notifications'] }); qc.invalidateQueries({ queryKey: ['navcounts'] }); };
  return (
    <DM.Root onOpenChange={(o) => { if (o) list.refetch(); }}>
      <DM.Trigger className="relative rounded-lg p-2 text-ink-soft hover:bg-surface-muted hover:text-ink" aria-label={`Notifications, ${n} unread`}>
        <Bell className="h-[18px] w-[18px]" />
        <AnimatePresence>
          {n > 0 && (
            <motion.span key={n} initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }}
              className="absolute right-1 top-1 min-w-[16px] rounded-full bg-danger px-1 text-center text-[10px] font-semibold leading-4 text-white tabular">{n > 99 ? '99+' : n}</motion.span>
          )}
        </AnimatePresence>
      </DM.Trigger>
      <DM.Portal>
        <DM.Content align="end" sideOffset={8} asChild>
          <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16 }}
            className="z-50 w-[min(92vw,400px)] overflow-hidden rounded-2xl border border-line bg-surface shadow-pop">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <p className="text-sm font-semibold">Notifications {n > 0 && <span className="ml-1 text-xs font-normal text-ink-soft">{n} unread</span>}</p>
              {n > 0 && <button className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline" onClick={async () => { await markRead(null); refresh(); }}><CheckCheck className="h-3.5 w-3.5" />Mark all read</button>}
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              {list.isLoading ? <p className="px-4 py-6 text-sm text-ink-soft">Loading…</p> :
                list.error ? <p className="px-4 py-6 text-sm text-danger">Notifications could not be loaded.</p> :
                !list.data?.length ? <p className="px-4 py-6 text-sm text-ink-soft">No notifications yet.</p> :
                  list.data.map((x, i) => (
                    <DM.Item key={x.id} asChild onSelect={async () => {
                      if (!x.read_at) { await markRead([x.id]); refresh(); }
                      if (x.link) nav(x.link);
                    }}>
                      <motion.div initial={{ opacity: 0, x: 6 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.18, delay: i * 0.025 }}
                        className={cn('flex cursor-pointer gap-3 border-b border-line px-4 py-3 outline-none last:border-0 hover:bg-surface-muted focus:bg-surface-muted', !x.read_at && 'bg-accent-soft/30')}>
                        <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', x.read_at ? 'bg-transparent' : x.kind === 'escalation' ? 'bg-danger' : 'bg-accent')} aria-label={x.read_at ? undefined : 'Unread'} />
                        <span className="min-w-0">
                          <span className="block text-[13px] font-medium text-ink">{x.title}</span>
                          <span className="mt-0.5 block text-xs text-ink-soft">{plainText(x.body)}</span>
                          {notificationDue(x) && <span className="mt-0.5 block text-xs font-medium text-ink">{notificationDue(x)}</span>}
                          <span className="mt-1 block text-[11px] text-ink-faint">{humanize(x.kind)} · {fmtDateTime(x.created_at)}</span>
                        </span>
                      </motion.div>
                    </DM.Item>
                  ))}
            </div>
            <DM.Item onSelect={() => nav('/app/notifications')} className="block cursor-pointer px-4 py-2.5 text-center text-[13px] font-medium text-accent outline-none hover:bg-surface-muted focus:bg-surface-muted">View all notifications</DM.Item>
          </motion.div>
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

function UserMenu() {
  const { context, workspace, roles, setWorkspace, signOut } = useAuth();
  const nav = useNavigate();
  const name = context?.profile.full_name || context?.profile.email || 'User';
  const item = 'flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-[13px] outline-none hover:bg-surface-muted focus:bg-surface-muted';
  return (
    <DM.Root>
      <DM.Trigger className="flex items-center gap-2 rounded-xl py-1 pl-1 pr-2 hover:bg-surface-muted" aria-label="Account menu">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-semibold text-white">
          {name.replace(/\(.*\)/, '').split(' ').filter(Boolean).map((p) => p[0]).slice(0, 2).join('')}
        </span>
        <span className="hidden text-left leading-tight md:block">
          <span className="block max-w-[170px] truncate text-[13px] font-medium text-ink">{name}</span>
          <span className="block text-[11px] text-ink-soft">{workspace ? ROLE_LABEL[workspace] : ''}</span>
        </span>
        <ChevronDown className="h-3.5 w-3.5 text-ink-soft" aria-hidden />
      </DM.Trigger>
      <DM.Portal>
        <DM.Content align="end" sideOffset={8} className="z-50 min-w-[240px] rounded-2xl border border-line bg-surface p-1 shadow-pop">
          <div className="px-3 py-2.5">
            <p className="text-[13px] font-semibold">{name}</p>
            <p className="text-xs text-ink-soft">{context?.profile.email}</p>
          </div>
          <DM.Separator className="my-1 h-px bg-line" />
          {roles.length > 1 && (
            <>
              <DM.Label className="px-3 pb-1 pt-1.5 text-[11px] font-medium text-ink-faint">Switch workspace</DM.Label>
              {roles.map((r: Role) => (
                <DM.Item key={r} onSelect={() => { setWorkspace(r); nav('/app'); }} className={item}>
                  <Repeat className="h-3.5 w-3.5" aria-hidden />{ROLE_LABEL[r]}{r === workspace && <span className="ml-auto text-xs text-primary">Current</span>}
                </DM.Item>
              ))}
              <DM.Separator className="my-1 h-px bg-line" />
            </>
          )}
          <DM.Item onSelect={() => nav('/app/profile')} className={item}><UserRound className="h-3.5 w-3.5" aria-hidden />Profile and preferences</DM.Item>
          <DM.Item onSelect={() => signOut()} className={cn(item, 'text-danger hover:bg-danger-soft focus:bg-danger-soft')}><LogOut className="h-3.5 w-3.5" aria-hidden />Sign out</DM.Item>
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

function GlobalSearch() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) && !t.isContentEditable) { e.preventDefault(); ref.current?.focus(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  const submit = (e: FormEvent) => { e.preventDefault(); if (q.trim()) { nav(`/app/applications?q=${encodeURIComponent(q.trim())}`); ref.current?.blur(); } };
  return (
    <form onSubmit={submit} role="search" className="relative hidden w-full min-w-[240px] max-w-md md:block">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" aria-hidden />
      <input ref={ref} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search applications by reference, title or institution"
        aria-label="Search applications" className="h-9 w-full rounded-xl border border-transparent bg-surface-muted pl-9 pr-10 text-[13px] text-ink placeholder:text-ink-faint transition-colors hover:border-line focus:border-accent focus:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/20" />
      <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-line bg-surface px-1.5 text-[11px] font-medium text-ink-faint" aria-hidden>/</kbd>
    </form>
  );
}

function Breadcrumb() {
  const loc = useLocation();
  const { workspace } = useAuth();
  const found = findNav(loc.pathname, workspace);
  const isCase = /^\/app\/applications\/[0-9a-f-]{36}/.test(loc.pathname);
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 shrink items-center gap-1.5 whitespace-nowrap text-[13px]">
      <span className="hidden truncate text-ink-faint xl:inline">{workspace ? ROLE_LABEL[workspace] : ''}</span>
      {found && <><ChevronRight className="hidden h-3.5 w-3.5 text-ink-faint xl:inline" aria-hidden /><span className="hidden whitespace-nowrap text-ink-soft xl:inline">{found.group.label}</span></>}
      <ChevronRight className="hidden h-3.5 w-3.5 shrink-0 text-ink-faint xl:inline" aria-hidden />
      {isCase ? (
        <><Link to="/app/applications" className="text-ink-soft hover:text-ink hover:underline">Applications</Link><ChevronRight className="h-3.5 w-3.5 text-ink-faint" aria-hidden /><span className="font-medium text-ink">Details</span></>
      ) : <span className="truncate font-medium text-ink">{found?.item.label ?? 'AICASA'}</span>}
    </nav>
  );
}

export function AppShell() {
  const loc = useLocation();
  const { workspace } = useAuth();
  const [drawer, setDrawer] = useState(false);
  useEffect(() => { setDrawer(false); }, [loc.pathname]);
  const title = titleFor(loc.pathname, workspace);
  useEffect(() => { document.title = title === 'AICASA' ? 'AICASA' : `${title} · AICASA`; }, [title]);

  return (
    <TT.Provider delayDuration={250}>
      <div className="min-h-screen bg-page">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:shadow-pop">Skip to content</a>
        <aside className="fixed inset-y-0 left-0 z-30 hidden w-[256px] border-r border-line bg-surface lg:block"><Sidebar /></aside>

        <RD.Root open={drawer} onOpenChange={setDrawer}>
          <AnimatePresence>
            {drawer && (
              <RD.Portal forceMount>
                <RD.Overlay asChild forceMount>
                  <motion.div className="fixed inset-0 z-40 bg-[#0F172A]/35 lg:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} />
                </RD.Overlay>
                <RD.Content asChild forceMount>
                  <motion.div className="fixed inset-y-0 left-0 z-50 w-[288px] max-w-[85vw] bg-surface shadow-pop lg:hidden"
                    initial={{ x: -24, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -24, opacity: 0 }} transition={{ duration: 0.2 }}>
                    <RD.Title className="sr-only">Navigation</RD.Title>
                    <RD.Description className="sr-only">Main navigation for your workspace</RD.Description>
                    <RD.Close className="absolute right-3 top-4 rounded-md p-1.5 text-ink-soft hover:bg-surface-muted" aria-label="Close navigation"><X className="h-4 w-4" /></RD.Close>
                    <Sidebar onNavigate={() => setDrawer(false)} />
                  </motion.div>
                </RD.Content>
              </RD.Portal>
            )}
          </AnimatePresence>
        </RD.Root>

        <div className="lg:pl-[256px]">
          <header className="sticky top-0 z-20 border-b border-line bg-surface/95">
            <div className="flex h-[60px] items-center gap-3 px-4 sm:px-6">
              <button className="rounded-lg p-2 text-ink-soft hover:bg-surface-muted lg:hidden" onClick={() => setDrawer(true)} aria-label="Open navigation"><Menu className="h-5 w-5" /></button>
              <Breadcrumb />
              <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-1.5 sm:gap-2">
                {/* one search box per page: list pages with their own search do not repeat it in the header */}
                {!/^\/app\/(applications|queue|admin\/users|evc\/experts)\/?$/.test(loc.pathname) && <GlobalSearch />}
                <TT.Root>
                  <TT.Trigger asChild>
                    <span tabIndex={0} className="hidden shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-[#eedcb1] bg-warning-soft px-2.5 py-1 text-[11px] font-semibold text-[#7a5100] sm:inline-flex">
                      <FlaskConical className="h-3 w-3" aria-hidden />Synthetic data
                    </span>
                  </TT.Trigger>
                  <TT.Portal>
                    <TT.Content sideOffset={6} className="z-50 max-w-[260px] rounded-lg bg-ink px-3 py-2 text-xs leading-snug text-white shadow-pop">
                      SIH26262 prototype. All records are synthetic demonstration data. Not an official AICTE service; nothing here is an official decision or record.
                    </TT.Content>
                  </TT.Portal>
                </TT.Root>
                <Glossary />
                <DisplayPreferences />
                <NotificationsMenu />
                <UserMenu />
              </div>
            </div>
          </header>
          <main id="main" className="workspace-content mx-auto w-full max-w-[1520px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={loc.pathname} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18, ease: 'easeOut' }}>
                <Outlet />
              </motion.div>
            </AnimatePresence>
          </main>
        </div>
      </div>
    </TT.Provider>
  );
}
