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
    const journeyObserver = observers.find((observer) => observer.target?.id === 'journey')!;
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
