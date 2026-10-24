import { useEffect, useState } from 'react';
import { Rows3 } from 'lucide-react';

export function DisplayPreferences() {
  const [density, setDensity] = useState<'comfortable' | 'compact'>(() => {
    try { return localStorage.getItem('aicasa.density') === 'compact' ? 'compact' : 'comfortable'; } catch { return 'comfortable'; }
  });
  useEffect(() => { document.documentElement.dataset.density = density; try { localStorage.setItem('aicasa.density', density); } catch { /* session preference still works */ } }, [density]);
  return <button onClick={() => setDensity(density === 'comfortable' ? 'compact' : 'comfortable')} aria-label={`Display density: ${density}. Switch to ${density === 'comfortable' ? 'compact' : 'comfortable'}`} aria-pressed={density === 'compact'} className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm text-ink-soft hover:bg-surface-muted"><Rows3 className="h-4 w-4" aria-hidden /><span className="hidden 2xl:inline">{density === 'comfortable' ? 'Comfortable' : 'Compact'}</span></button>;
}
