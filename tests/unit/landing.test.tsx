// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LandingPage } from '@/features/landing/LandingPage';

const mediaListeners = new Set<(event: { matches: boolean }) => void>();
let reducedMotion = false;

beforeEach(() => {
  reducedMotion = false;
  mediaListeners.clear();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reducedMotion && query.includes('prefers-reduced-motion'), media: query, onchange: null,
    addEventListener: (_: string, callback: (event: { matches: boolean }) => void) => mediaListeners.add(callback),
    removeEventListener: (_: string, callback: (event: { matches: boolean }) => void) => mediaListeners.delete(callback),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.hash}</output>;
}
function renderLanding() {
  return render(<MemoryRouter><LandingPage /><LocationProbe /></MemoryRouter>);
}
function stageButton(name: string) {
  return within(screen.getByRole('navigation', { name: 'Application journey stages' })).getByRole('button', { name: new RegExp(name) });
}

describe('signed-out landing page', () => {
  it('shows the matching evidence for all five stages and restarts the journey', () => {
    renderLanding();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const panel = document.getElementById('journey-detail')!;
    for (const [name, heading, evidence] of [
      ['Submission', 'One complete application. One starting point.', 'Application form'],
      ['Scrutiny', 'Spot the gap before it becomes a delay.', '25 computers below requirement'],
      ['Correction', 'A correction, with the history intact.', 'Updated inventory'],
      ['Expert visit', 'The right expertise, with conflicts checked.', 'Computer engineering'],
      ['Decision', 'A decision you can trace back.', 'RECORDED & TRACEABLE'],
    ]) {
      fireEvent.click(stageButton(name));
      expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
      expect(within(panel).getByText(evidence)).toBeTruthy();
      expect(stageButton(name).getAttribute('aria-pressed')).toBe('true');
    }
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }));
    expect(stageButton('Submission').getAttribute('aria-pressed')).toBe('true');
  });

  it('advances automatically and stays on the selected stage after interaction', () => {
    vi.useFakeTimers();
    renderLanding();
    act(() => { vi.advanceTimersByTime(4600); });
    expect(stageButton('Scrutiny').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(stageButton('Correction'));
    act(() => { vi.advanceTimersByTime(12000); });
    expect(stageButton('Correction').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Play application journey' })).toBeTruthy();
  });

  it('supports pause, resume, keyboard focus, and returning from the last stage', () => {
    vi.useFakeTimers();
    renderLanding();
    fireEvent.click(screen.getByRole('button', { name: 'Pause application journey' }));
    act(() => { vi.advanceTimersByTime(5000); });
    expect(stageButton('Submission').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(stageButton('Decision'));
    fireEvent.click(screen.getByRole('button', { name: 'Play application journey' }));
    act(() => { vi.advanceTimersByTime(4600); });
    expect(stageButton('Submission').getAttribute('aria-pressed')).toBe('true');
    fireEvent.focus(stageButton('Scrutiny'));
    act(() => { vi.advanceTimersByTime(9000); });
    expect(stageButton('Submission').getAttribute('aria-pressed')).toBe('true');
  });

  it('follows every internal link, including repeated anchor visits', () => {
    renderLanding();
    const links = screen.getAllByRole('link').filter((link) => !link.getAttribute('href')?.startsWith('https:') && link.getAttribute('href') !== '#main-content');
    for (const link of links) {
      const href = link.getAttribute('href')!;
      fireEvent.click(link);
      expect(screen.getByTestId('location').textContent).toBe(href);
      if (href.includes('#')) expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    }
    fireEvent.click(screen.getByRole('link', { name: 'See how it works' }));
    const count = vi.mocked(Element.prototype.scrollIntoView).mock.calls.length;
    fireEvent.click(screen.getByRole('link', { name: 'See how it works' }));
    expect(vi.mocked(Element.prototype.scrollIntoView).mock.calls.length).toBeGreaterThan(count);
  });

  it('keeps the journey readable and still with reduced motion', () => {
    reducedMotion = true;
    vi.useFakeTimers();
    const { container } = renderLanding();
    act(() => { vi.advanceTimersByTime(9000); });
    expect(stageButton('Submission').getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('button', { name: /Play application journey|Pause application journey/ })).toBeNull();
    expect(container.querySelector('[data-reveal].will-reveal')).toBeNull();
    fireEvent.click(stageButton('Decision'));
    expect(screen.getByRole('heading', { name: 'A decision you can trace back.' })).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'See how it works' }));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: 'instant', block: 'start' });
  });

  it('pauses while the browser tab is hidden', () => {
    vi.useFakeTimers();
    renderLanding();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange'));
    act(() => { vi.advanceTimersByTime(9000); });
    expect(stageButton('Submission').getAttribute('aria-pressed')).toBe('true');
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    fireEvent(document, new Event('visibilitychange'));
    act(() => { vi.advanceTimersByTime(4600); });
    expect(stageButton('Scrutiny').getAttribute('aria-pressed')).toBe('true');
  });

  it('pauses when the preview leaves the viewport and cleans up its observer', () => {
    vi.useFakeTimers();
    const observers: Array<{ callback: IntersectionObserverCallback; target?: Element; disconnect: ReturnType<typeof vi.fn> }> = [];
    vi.stubGlobal('IntersectionObserver', class {
      entry: typeof observers[number];
      constructor(callback: IntersectionObserverCallback) {
        this.entry = { callback, disconnect: vi.fn() };
        observers.push(this.entry);
      }
      observe(target: Element) { this.entry.target = target; }
      unobserve() {}
      disconnect() { this.entry.disconnect(); }
    });
    const { unmount } = renderLanding();
    const journeyObserver = observers.find((observer) => observer.target?.id === 'how-it-works')!;
    act(() => journeyObserver.callback([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver));
    act(() => { vi.advanceTimersByTime(9000); });
    expect(stageButton('Submission').getAttribute('aria-pressed')).toBe('true');
    act(() => journeyObserver.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    act(() => { vi.advanceTimersByTime(4600); });
    expect(stageButton('Scrutiny').getAttribute('aria-pressed')).toBe('true');
    unmount();
    expect(journeyObserver.disconnect).toHaveBeenCalled();
  });
});

describe('landing page redesign', () => {
  const headingLevels = () => [...document.querySelectorAll('h1, h2, h3, h4')].map((h) => Number(h.tagName[1]));

  it('leads with the benefit headline, one h1 and a logical heading order', () => {
    renderLanding();
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toBe('AICTE approvals, without the paper chase.');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const levels = headingLevels();
    levels.forEach((level, i) => { if (i > 0) expect(level - levels[i - 1]).toBeLessThanOrEqual(1); });
    expect(document.querySelector('abbr[title^="AICTE Integrated Compliance"]')?.textContent).toBe('AICASA');
    expect(screen.getByText(/All India Council for Technical Education/)).toBeTruthy();
  });

  it('has one header button and one primary hero call to action, both reaching sign-in, plus the audience strip', () => {
    renderLanding();
    const header = within(screen.getByRole('banner'));
    expect(header.getByRole('link', { name: 'How it works' }).getAttribute('href')).toMatch(/#how-it-works$/);
    expect(header.getByRole('link', { name: 'Features' }).getAttribute('href')).toMatch(/#features$/);
    expect(header.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/sign-in');
    expect(header.getAllByRole('link').filter((l) => l.className.includes('lp-header-signin'))).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Open the demo workspace' }).getAttribute('href')).toBe('/sign-in');
    expect(screen.getByRole('link', { name: 'See how it works' }).getAttribute('href')).toMatch(/#how-it-works$/);
    expect(screen.getByLabelText(/Built for institutions, officers and administrators/).textContent).toMatch(/For\s*Institutions.*Officers.*Administrators/);
    // the prototype disclaimer lives in the footer, not under the hero buttons
    const hero = document.querySelector('.lp-hero')!;
    expect(hero.textContent).not.toMatch(/synthetic data|Not an official/i);
    expect(within(screen.getByRole('contentinfo')).getByText(/SIH26262 student prototype · Synthetic data · Not an official AICTE service/)).toBeTruthy();
  });

  it('shows a labelled product preview built from the real UI whose stepper loops through the stages', () => {
    vi.useFakeTimers();
    renderLanding();
    expect(screen.getByText('Live product preview — demo data')).toBeTruthy();
    const current = () => document.querySelector('.lp-preview-card [aria-current="step"]')?.textContent ?? '';
    const first = current();
    expect(first).toMatch(/Scrutiny/);
    const seen = new Set([first.match(/Intake|Scrutiny|Decision/)![0]]);
    for (let i = 0; i < 3; i++) { act(() => { vi.advanceTimersByTime(3100); }); seen.add(current().match(/Intake|Scrutiny|Decision/)![0]); }
    expect([...seen].sort()).toEqual(['Decision', 'Intake', 'Scrutiny']);
    expect(document.querySelector('.lp-preview-card')?.textContent).toMatch(/Needs action/);
  });

  it('lifts and tilts the preview toward the pointer, and leaves it still with reduced motion', () => {
    renderLanding();
    const stage = document.querySelector('.lp-preview-stage')!;
    const card = document.querySelector<HTMLElement>('.lp-preview-card')!;
    stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.mouseMove(stage, { clientX: 200, clientY: 0 });
    expect(card.style.getPropertyValue('--tilt-y')).toBe('3.50deg');
    expect(card.style.getPropertyValue('--tilt-x')).toBe('2.50deg');
    fireEvent.mouseLeave(stage);
    expect(card.style.getPropertyValue('--tilt-y')).toBe('0deg');
    cleanup();
    reducedMotion = true;
    renderLanding();
    const still = document.querySelector<HTMLElement>('.lp-preview-card')!;
    fireEvent.mouseMove(document.querySelector('.lp-preview-stage')!, { clientX: 10, clientY: 10 });
    expect(still.style.getPropertyValue('--tilt-y')).toBe('');
  });

  it('presents the four differentiators with a benefit and a concrete example each', () => {
    renderLanding();
    const features = within(document.getElementById('features')!);
    expect(features.getByRole('heading', { level: 2 }).textContent).toBe('Four things paper and email cannot do.');
    const titles = features.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual(['Dynamic Deficiency Matrix', 'Smart EVC Routing', 'Concurrent Reviews with RBAC', 'Query & Clarification Window']);
    expect(features.getByText('Sanctioned intake requires 120 computers, only 95 declared — deficiency detected automatically.')).toBeTruthy();
    expect(features.getByText('Same-district and affiliated experts are filtered out, with the reason shown.')).toBeTruthy();
    expect(features.getByText('Routing waits for every review — nothing slips through a gap.')).toBeTruthy();
    expect(features.getByText('Version compare shows exactly what changed — nothing else.')).toBeTruthy();
    // jargon is explained in place
    expect(features.getByText(/EVC = Expert Visit Committee/)).toBeTruthy();
    expect(features.getByText(/RBAC = role-based access control/)).toBeTruthy();
  });

  it('gives every journey stage a plain-English line and explains the stage in the detail panel', () => {
    renderLanding();
    const nav = screen.getByRole('navigation', { name: 'Application journey stages' });
    for (const [name, line] of [['Submission', 'The institution files its documents online.'], ['Scrutiny', 'Officers check the file against the rules.'],
      ['Correction', 'The institution answers within 48 hours.'], ['Expert visit', 'An expert panel inspects the campus online.'], ['Decision', 'An authorised officer records the outcome.']]) {
      expect(within(nav).getByText(line)).toBeTruthy();
      fireEvent.click(stageButton(name));
      expect(screen.getByText(`In plain English: ${line}`)).toBeTruthy();
    }
    fireEvent.click(stageButton('Expert visit'));
    expect(screen.getByText(/Expert Visit Committee \(EVC\)/)).toBeTruthy();
  });

  it('auto-play stops when the visitor interacts and does not restart on its own', () => {
    vi.useFakeTimers();
    renderLanding();
    act(() => { vi.advanceTimersByTime(4100); });
    expect(stageButton('Scrutiny').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(stageButton('Expert visit'));
    act(() => { vi.advanceTimersByTime(20000); });
    expect(stageButton('Expert visit').getAttribute('aria-pressed')).toBe('true');
  });

  it('has a demo-access panel that reaches sign-in and never invents credentials', () => {
    renderLanding();
    const demo = within(document.getElementById('demo')!);
    expect(demo.getByRole('heading', { name: 'Here for the demo?' })).toBeTruthy();
    expect(demo.getByText(/working SIH26262 prototype with synthetic data/)).toBeTruthy();
    expect(demo.getByRole('link', { name: 'Enter the demo workspace' }).getAttribute('href')).toBe('/sign-in');
    expect(demo.queryByRole('button', { name: /Copy/ })).toBeNull();
    expect(demo.getByText(/issued by the project team/)).toBeTruthy();
  });

  it('shows copyable credentials only when the project publishes them through its public environment', () => {
    vi.stubEnv('VITE_PUBLIC_DEMO_EMAIL', 'visitor@example.test');
    vi.stubEnv('VITE_PUBLIC_DEMO_PASSWORD', 'published-demo-pass');
    renderLanding();
    const demo = within(document.getElementById('demo')!);
    expect(demo.getByText('visitor@example.test')).toBeTruthy();
    expect(demo.getByRole('button', { name: 'Copy email' })).toBeTruthy();
    expect(demo.getByRole('button', { name: 'Copy password' })).toBeTruthy();
    vi.unstubAllEnvs();
  });

  it('closes with the full name of AICASA and real footer links', () => {
    renderLanding();
    const footer = within(screen.getByRole('contentinfo'));
    expect(footer.getByText(/AICTE Integrated Compliance and Approval/)).toBeTruthy();
    const nav = footer.getByRole('navigation', { name: 'Footer navigation' });
    expect(within(nav).getByRole('link', { name: 'How it works' }).getAttribute('href')).toMatch(/#how-it-works$/);
    expect(within(nav).getByRole('link', { name: 'Features' }).getAttribute('href')).toMatch(/#features$/);
    expect(within(nav).getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/sign-in');
    expect(document.getElementById('how-it-works')).toBeTruthy();
    expect(document.getElementById('features')).toBeTruthy();
  });

  it('is fully readable with reduced motion: nothing is hidden for a reveal and no auto-play controls appear', () => {
    reducedMotion = true;
    const { container } = renderLanding();
    expect(container.querySelector('.will-reveal')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 3 }).length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByRole('button', { name: /application journey/i })).toBeNull();
    expect(document.querySelector('.lp-preview-card [aria-current="step"]')?.textContent).toMatch(/Scrutiny/);
  });
});
