import {
  Bell, Building2, CalendarClock, ClipboardCheck, FileSearch, FilePlus2, FileStack, FileText, Gauge, GitBranch,
  History, LayoutDashboard, ListChecks, ListTodo, Settings2, ShieldAlert, SlidersHorizontal, TimerReset, Users, Download, Inbox, Siren,
  type LucideIcon,
} from 'lucide-react';
import type { Capability, Role } from '@/types/domain';

/** Badge keys resolve to live, RLS-scoped counts (see useNavCounts). */
export type BadgeKey = 'returned' | 'corrections' | 'tasksOverdue' | 'escalations' | 'oblOverdue' | 'unread' | 'evcQueue';
export interface NavItem { to: string; label: string; icon: LucideIcon; capability?: Capability; end?: boolean; badge?: BadgeKey; badgeTone?: 'danger' | 'warning' | 'neutral' }
export interface NavGroup { id: string; label: string; items: NavItem[] }

export const NAV: Record<Role, NavGroup[]> = {
  institution: [
    {
      id: 'work', label: 'Daily work', items: [
        { to: '/app', label: 'Dashboard', icon: LayoutDashboard, end: true },
        { to: '/app/applications', label: 'Applications', icon: FileStack },
        { to: '/app/applications/new', label: 'New application', icon: FilePlus2 },
        { to: '/app/deficiencies', label: 'Deficiencies', icon: ShieldAlert, badge: 'returned', badgeTone: 'warning' },
      ],
    },
    {
      id: 'documents', label: 'Documents', items: [
        { to: '/app/documents', label: 'Document centre', icon: FileText },
        { to: '/app/precheck', label: 'Pre-submission check', icon: FileSearch },
      ],
    },
    {
      id: 'compliance', label: 'Compliance', items: [
        { to: '/app/compliance', label: 'Obligations', icon: ClipboardCheck, badge: 'oblOverdue', badgeTone: 'danger' },
        { to: '/app/expiry', label: 'Document validity', icon: TimerReset },
      ],
    },
    {
      id: 'account', label: 'Account', items: [
        { to: '/app/notifications', label: 'Notifications', icon: Bell, badge: 'unread', badgeTone: 'neutral' },
        { to: '/app/profile', label: 'Institution profile', icon: Building2 },
      ],
    },
  ],
  officer: [
    {
      id: 'work', label: 'Daily work', items: [
        { to: '/app', label: 'Dashboard', icon: LayoutDashboard, end: true },
        { to: '/app/queue', label: 'My queue', icon: Inbox },
        { to: '/app/tasks', label: 'Tasks & deadlines', icon: ListTodo, badge: 'tasksOverdue', badgeTone: 'danger' },
        { to: '/app/deficiencies', label: 'Correction reviews', icon: ShieldAlert, badge: 'corrections', badgeTone: 'warning' },
      ],
    },
    {
      id: 'monitoring', label: 'Monitoring', items: [
        { to: '/app/applications', label: 'All cases in scope', icon: FileStack },
        { to: '/app/evc', label: 'EVC scheduling', icon: CalendarClock, capability: 'evc', badge: 'evcQueue', badgeTone: 'warning' },
        { to: '/app/compliance', label: 'Compliance verification', icon: ClipboardCheck },
        { to: '/app/expiry', label: 'Document validity', icon: TimerReset },
        { to: '/app/escalations', label: 'Escalations', icon: Siren, badge: 'escalations', badgeTone: 'danger' },
      ],
    },
    {
      id: 'account', label: 'Account', items: [
        { to: '/app/notifications', label: 'Notifications', icon: Bell, badge: 'unread', badgeTone: 'neutral' },
        { to: '/app/profile', label: 'My profile', icon: Settings2 },
      ],
    },
  ],
  admin: [
    {
      id: 'overview', label: 'Overview', items: [
        { to: '/app', label: 'Dashboard', icon: Gauge, end: true },
        { to: '/app/applications', label: 'Applications', icon: FileStack },
      ],
    },
    {
      id: 'monitoring', label: 'Monitoring', items: [
        { to: '/app/escalations', label: 'Escalations', icon: Siren, badge: 'escalations', badgeTone: 'danger' },
        { to: '/app/evc', label: 'EVC overview', icon: CalendarClock },
        { to: '/app/compliance', label: 'Compliance', icon: ClipboardCheck, badge: 'oblOverdue', badgeTone: 'danger' },
        { to: '/app/expiry', label: 'Document validity', icon: TimerReset },
      ],
    },
    {
      id: 'configuration', label: 'Configuration', items: [
        { to: '/app/admin/workflows', label: 'Workflow routes', icon: GitBranch },
        { to: '/app/admin/rules', label: 'Alert rules', icon: SlidersHorizontal },
        { to: '/app/admin/users', label: 'Users & access', icon: Users, capability: 'user_admin' },
      ],
    },
    {
      id: 'oversight', label: 'Oversight', items: [
        { to: '/app/admin/audit', label: 'Audit log', icon: History, capability: 'audit' },
        { to: '/app/admin/reports', label: 'Reports & export', icon: Download, capability: 'reports' },
        { to: '/app/admin/system', label: 'System status', icon: ListChecks },
      ],
    },
    {
      id: 'account', label: 'Account', items: [
        { to: '/app/notifications', label: 'Notifications', icon: Bell, badge: 'unread', badgeTone: 'neutral' },
        { to: '/app/profile', label: 'My profile', icon: Settings2 },
      ],
    },
  ],
};

export const ROLE_LABEL: Record<Role, string> = { institution: 'Institution', officer: 'AICTE officer', admin: 'Administrator' };

export function findNav(path: string, role: Role | null): { group: NavGroup; item: NavItem } | null {
  if (!role) return null;
  let best: { group: NavGroup; item: NavItem } | null = null;
  for (const g of NAV[role]) for (const i of g.items) {
    if ((i.end ? path === i.to : path === i.to || path.startsWith(i.to + '/')) && (!best || i.to.length > best.item.to.length)) best = { group: g, item: i };
  }
  return best;
}

export function titleFor(path: string, role: Role | null): string {
  if (/^\/app\/applications\/[0-9a-f-]{36}/.test(path)) return 'Application';
  return findNav(path, role)?.item.label ?? 'AICASA';
}
