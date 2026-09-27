'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Label } from './label';

interface FormFieldProps {
    /** Visible label text; always rendered inside a <Label htmlFor=id>. */
    label: string;
    /** id of the control — the label's htmlFor target. */
    id: string;
    /** Error message (already translated). Sets aria-invalid/describedby. */
    error?: string | undefined;
    hint?: string | undefined;
    required?: boolean | undefined;
    className?: string | undefined;
    /** Single control element — cloned to receive id/aria wiring. */
    children: React.ReactElement;
}

// Wraps a control with label + error + hint and wires the a11y attributes:
// aria-invalid on error, aria-describedby pointing at the error/hint nodes.
export function FormField({ label, id, error, hint, required, className, children }: FormFieldProps) {
    const errorId = `${id}-error`;
    const hintId = `${id}-hint`;
    const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;

    const control = React.cloneElement(children, {
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': describedBy,
        required: required || undefined
    } as Record<string, unknown>);

    return (
        <div className={cn('flex flex-col gap-1.5', className)}>
            <Label htmlFor={id} required={required}>
                {label}
            </Label>
            {control}
            {hint && (
                <p id={hintId} className="text-xs text-muted-foreground">
                    {hint}
                </p>
            )}
            {error && (
                <p id={errorId} role="alert" className="text-xs font-medium text-danger-500 dark:text-red-300">
                    {error}
                </p>
            )}
        </div>
    );
}
