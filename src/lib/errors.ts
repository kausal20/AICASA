export interface AppError {
  message: string;
  code?: string;
}

/** Normalise Supabase/PostgREST/Edge errors into a safe, user-facing message. */
export function toAppError(err: unknown): AppError {
  if (!err) return { message: 'Something went wrong.' };
  if (typeof err === 'string') return { message: err };
  const e = err as { message?: string; details?: string; code?: string; status?: number };
  if (e.code === 'PGRST301' || e.status === 401) return { message: 'Your session has expired. Sign in again.', code: 'not_authenticated' };
  if (e.code === '42501') return { message: 'You do not have permission to do that.', code: 'forbidden' };
  if (e.message?.includes('Failed to fetch')) return { message: 'Could not reach the server. Check your connection and retry.', code: 'network' };
  // Our database functions raise P0001 with the human-readable message and a machine code in details.
  if (e.code === 'P0001') return { message: e.message ?? 'The request was rejected.', code: e.details };
  return { message: e.message ?? 'Something went wrong.', code: e.code };
}

export function errorMessage(err: unknown): string {
  return toAppError(err).message;
}

/** Throw helper for supabase-js results. */
export function unwrap<T>(res: { data: T | null; error: unknown }): T {
  if (res.error) throw res.error;
  return res.data as T;
}
