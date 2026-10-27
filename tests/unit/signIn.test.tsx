// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { signInWithPassword } = vi.hoisted(() => ({
  signInWithPassword: vi.fn(async (..._a: unknown[]) => ({ error: null })),
}));
vi.mock('@/lib/supabase', () => ({ isConfigured: true, supabase: { auth: { signInWithPassword } } }));
vi.mock('@/features/auth/AuthProvider', () => ({ useAuth: () => ({ status: 'signed_out' }) }));

import { SignInPage } from '@/features/auth/AuthPages';

const renderAt = (state?: unknown) => render(
  <MemoryRouter initialEntries={[{ pathname: '/sign-in', state }]}>
    <Routes><Route path="/sign-in" element={<SignInPage />} /><Route path="/app" element={<p>My dashboard</p>} /><Route path="*" element={<p>Somewhere else</p>} /></Routes>
  </MemoryRouter>);

describe('sign-in page', () => {
  it('has empty fields with placeholders, no role picker and a show/hide password toggle', () => {
    cleanup();
    renderAt();
    const email = screen.getByLabelText(/Email/) as HTMLInputElement;
    const password = screen.getByLabelText(/^Password/) as HTMLInputElement;
    expect(email.value).toBe('');
    expect(email.placeholder).toBeTruthy();
    expect(password.value).toBe('');
    expect(screen.queryByLabelText(/Role/)).toBeNull();
    expect(document.body.textContent).not.toContain('demo123@gmail.com');
    expect(password.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(password.type).toBe('text');
    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(password.type).toBe('password');
  });

  it('always lands on the signed-in account\'s own dashboard, never a page remembered from before', async () => {
    cleanup();
    renderAt({ from: '/app/admin/users' });
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'officer.wr.evc@aicasa-demo.test' } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'not-a-real-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByText('My dashboard')).toBeTruthy());
    expect(signInWithPassword).toHaveBeenCalledWith({ email: 'officer.wr.evc@aicasa-demo.test', password: 'not-a-real-password' });
  });
});
