import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { errorMessage } from '@/lib/errors';

/**
 * Wraps a server action: disables duplicate submits (isPending), shows the confirmed outcome
 * only after the server responds, and refreshes the affected queries.
 */
export function useAction<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>, opts: {
  success?: string | ((r: TResult) => string);
  invalidate?: unknown[][];
  onSuccess?: (r: TResult) => void;
} = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(r) : opts.success);
      for (const k of opts.invalidate ?? []) qc.invalidateQueries({ queryKey: k });
      if (opts.invalidate?.some((k) => k[0] === 'deficiencies')) {
        for (const key of ['application', 'applications', 'navcounts']) void qc.invalidateQueries({ queryKey: [key] });
      }
      opts.onSuccess?.(r);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}
