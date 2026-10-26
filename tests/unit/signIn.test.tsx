// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { invoke, verifyOtp, signInWithPassword } = vi.hoisted(() => ({
  invoke: vi.fn(async (..._a: unknown[]) => ({ data: { token_hash: 'tok' }, error: null })),
  verifyOtp: vi.fn(async () => ({ error: null })),
  signInWithPassword: vi.fn(async () => ({ error: null })),
}));
vi.mock('@/lib/supabase', () => ({
  isConfigured: true,
  supabase: { functions: { invoke }, auth: { verifyOtp, signInWithPassword } },
}));
vi.mock('@/features/auth/AuthProvider', () => ({ useAuth: () => ({ status: 'signed_out' }) }));

import { SignInPage } from '@/features/auth/AuthPages';

describe('sign-in page', () => {
  it('is prefilled with the shared demo login and offers three plainly worded roles', () => {
    cleanup();
    render(<MemoryRouter><SignInPage /></MemoryRouter>);
    expect((screen.getByLabelText(/Email/) as HTMLInputElement).value).toBe('demo123@gmail.com');
    expect((screen.getByLabelText(/Password/) as HTMLInputElement).value).toBe('Demo@1234');
    const role = screen.getByLabelText(/Role/) as HTMLSelectElement;
    expect([...role.options].map((o) => o.text)).toEqual(['College / institute', 'Officer', 'Administrative']);
  });

  it('signs in as the account for the chosen role without sending the shared password to Supabase auth', async () => {
    cleanup();
    render(<MemoryRouter><SignInPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText(/Role/), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(verifyOtp).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith('demo-session', { body: { persona: 'admin' } });
    expect(signInWithPassword).not.toHaveBeenCalled();
  });
});
