import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';

type View = { name: string; query: string };
export function SavedViews({ mode }: { mode: string }) {
  const { session, workspace } = useAuth();
  const [params, setParams] = useSearchParams();
  const key = `aicasa.views.${session?.user.id}.${workspace}.${mode}`;
  const [saved, setSaved] = useState<View[]>(() => { try { const v: unknown = JSON.parse(localStorage.getItem(key) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x.name === 'string' && typeof x.query === 'string').slice(0, 8) : []; } catch { return []; } });
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  function persist(views: View[]) { setSaved(views); try { localStorage.setItem(key, JSON.stringify(views)); setMessage('Saved on this browser.'); } catch { setMessage('Saved for this session; browser storage is unavailable.'); } }
  const presets: View[] = [
    { name: workspace !== 'officer' ? 'Overdue applications' : 'My overdue applications', query: `overdue=1${workspace === 'officer' ? `&assigned=${session?.user.id}` : ''}` },
    { name: 'Awaiting corrections', query: 'status=returned_for_correction' },
    { name: 'EVC this week', query: 'evcWeek=1' },
  ];
  return <div className="space-y-3 border-b border-line p-4">
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Saved application views"><span className="mr-1 text-sm font-semibold">Quick views</span>{presets.map((v) => <Button key={v.name} variant={params.toString() === v.query ? 'primary' : 'secondary'} size="sm" onClick={() => setParams(v.query)}>{v.name}</Button>)}</div>
    <details><summary className="min-h-9 cursor-pointer py-2 text-sm font-medium text-accent">Saved views ({saved.length})</summary>
      <div className="flex flex-wrap gap-2 py-2">{saved.map((v) => <div key={v.name} className="flex items-center rounded-lg border border-line"><Button size="sm" variant="ghost" onClick={() => setParams(v.query)}>{v.name}</Button><Button size="sm" variant="ghost" aria-label={`Remove saved view ${v.name}`} onClick={() => persist(saved.filter((x) => x.name !== v.name))}>×</Button></div>)}</div>
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); if (!name.trim()) return; const p = new URLSearchParams(params); p.delete('page'); persist([...saved.filter((v) => v.name !== name.trim()), { name: name.trim(), query: p.toString() }].slice(-8)); setName(''); }}><Input aria-label="Saved view name" placeholder="Name the current filters" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} className="max-w-xs" /><Button type="submit" variant="secondary" disabled={!name.trim()}>Save current view</Button></form><p role="status" className="mt-2 text-sm text-ink-soft">{message || 'Save up to eight filter combinations on this browser. Reusing a name replaces that view.'}</p>
    </details>
  </div>;
}
