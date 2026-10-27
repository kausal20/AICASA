// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { invoke, verifyOtp, signInWithPassword } = vi.hoisted(() => ({
  invoke: vi.fn(async (..._a: unknown[]) => ({ data: { token_hash: 'tok' }, error: null })),
  verifyOtp: vi.fn(async () => ({ error: null })),
  signInWithPassword: vi.fn(async (..._a: unknown[]) => ({ error: null })),
}));
vi.mock('@/lib/supabase', () => ({ isConfigured: true, supabase: { functions: { invoke }, auth: { verifyOtp, signInWithPassword } } }));
vi.mock('@/features/auth/AuthProvider', () => ({ useAuth: () => ({ status: 'signed_out' }) }));

import { SignInPage } from '@/features/auth/AuthPages';

const renderPage = () => render(
  <MemoryRouter initialEntries={['/sign-in']}>
    <Routes><Route path="/sign-in" element={<SignInPage />} /><Route path="/app" element={<p>My dashboard</p>} /></Routes>
  </MemoryRouter>);

describe('sign-in page', () => {
  it('has the demo email and password already filled in, a show/hide toggle, and a role picker', () => {
    cleanup();
    renderPage();
    expect((screen.getByLabelText(/Email/) as HTMLInputElement).value).toBe('demo123@gmail.com');
    const password = screen.getByLabelText(/^Password/) as HTMLInputElement;
    expect(password.value).toBe('Demo@1234');
    expect(password.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(password.type).toBe('text');
    const role = screen.getByLabelText(/Role/) as HTMLSelectElement;
    expect([...role.options].map((o) => o.text)).toEqual(['College / institute', 'Officer', 'Administrative']);
  });

  it('signs in as the account for the chosen role and lands on the dashboard', async () => {
    cleanup();
    renderPage();
    fireEvent.change(screen.getByLabelText(/Role/), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByText('My dashboard')).toBeTruthy());
    expect(invoke).toHaveBeenCalledWith('demo-session', { body: { persona: 'admin' } });
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it('other emails still use normal password sign-in', async () => {
    cleanup();
    renderPage();
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'officer.wr.evc@aicasa-demo.test' } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'something-else' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(signInWithPassword).toHaveBeenCalledWith({ email: 'officer.wr.evc@aicasa-demo.test', password: 'something-else' }));
  });
});
