import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export function Field({ label, required, hint, error, children, htmlFor, className }: {
  label: string; required?: boolean; hint?: ReactNode; error?: string; children: ReactNode; htmlFor?: string; className?: string;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={htmlFor} className="flex items-baseline gap-1.5 text-[13px] font-medium text-ink">
        {label}
        {required ? <span className="text-danger" aria-hidden>*</span> : <span className="text-xs font-normal text-ink-faint">optional</span>}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-ink-soft">{hint}</p>}
      {error && <p role="alert" className="text-xs font-medium text-danger">{error}</p>}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input(
  { className, invalid, ...rest }, ref,
) {
  return <input ref={ref} aria-invalid={invalid || undefined} className={cn('input-base h-10', invalid && 'border-danger', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(function Textarea(
  { className, invalid, rows = 3, ...rest }, ref,
) {
  return <textarea ref={ref} rows={rows} aria-invalid={invalid || undefined} className={cn('input-base resize-y leading-relaxed', invalid && 'border-danger', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(function Select(
  { className, invalid, children, ...rest }, ref,
) {
  return (
    <select ref={ref} aria-invalid={invalid || undefined} className={cn('input-base h-10 pr-8', invalid && 'border-danger', className)} {...rest}>
      {children}
    </select>
  );
});

type Extra = { label: string; hint?: ReactNode; error?: string };

/** Labelled field with generated id wiring. Forwards refs so react-hook-form can register it. */
export const TextField = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & Extra>(function TextField(
  { label, required, hint, error, ...rest }, ref,
) {
  const id = useId();
  return (
    <Field label={label} required={required} hint={hint} error={error} htmlFor={id}>
      <Input ref={ref} id={id} required={required} invalid={!!error} {...rest} />
    </Field>
  );
});

export const TextAreaField = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & Extra>(function TextAreaField(
  { label, required, hint, error, ...rest }, ref,
) {
  const id = useId();
  return (
    <Field label={label} required={required} hint={hint} error={error} htmlFor={id}>
      <Textarea ref={ref} id={id} required={required} invalid={!!error} {...rest} />
    </Field>
  );
});

export const SelectField = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & Extra>(function SelectField(
  { label, required, hint, error, children, ...rest }, ref,
) {
  const id = useId();
  return (
    <Field label={label} required={required} hint={hint} error={error} htmlFor={id}>
      <Select ref={ref} id={id} required={required} invalid={!!error} {...rest}>{children}</Select>
    </Field>
  );
});
