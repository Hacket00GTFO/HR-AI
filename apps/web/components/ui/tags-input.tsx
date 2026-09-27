'use client';

import * as React from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface TagsInputProps {
    id?: string | undefined;
    value: string[];
    onChange: (tags: string[]) => void;
    placeholder?: string | undefined;
    addLabel?: string | undefined;
    removeLabel?: ((tag: string) => string) | undefined;
    disabled?: boolean | undefined;
    className?: string | undefined;
    'aria-invalid'?: boolean | 'true' | 'false' | undefined;
    'aria-describedby'?: string | undefined;
}

// Keyboard-friendly tag input: Enter/comma commits, Backspace pops the last
// tag, each chip has a labeled remove button.
export function TagsInput({
    id,
    value,
    onChange,
    placeholder,
    addLabel = 'Add tag',
    removeLabel = (tag) => `Remove ${tag}`,
    disabled,
    className,
    ...aria
}: TagsInputProps) {
    const [draft, setDraft] = React.useState('');

    const commit = (raw: string) => {
        const tag = raw.trim();
        if (tag && !value.includes(tag)) onChange([...value, tag]);
        setDraft('');
    };

    return (
        <div
            className={cn(
                'flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-md border border-border bg-input px-2 py-1.5 text-sm shadow-sm focus-within:outline-2 focus-within:outline-ring',
                className
            )}
        >
            {value.map((tag) => (
                <span
                    key={tag}
                    className="inline-flex items-center gap-1 rounded-full bg-coral-500/15 px-2 py-0.5 text-xs font-medium text-coral-700 dark:text-coral-300"
                >
                    {tag}
                    <button
                        type="button"
                        aria-label={removeLabel(tag)}
                        className="rounded-full p-0.5 hover:bg-coral-500/20"
                        onClick={() => onChange(value.filter((t) => t !== tag))}
                        disabled={disabled}
                    >
                        <X className="size-3" aria-hidden="true" />
                    </button>
                </span>
            ))}
            <input
                id={id}
                value={draft}
                disabled={disabled}
                placeholder={value.length === 0 ? placeholder : undefined}
                aria-label={value.length === 0 ? undefined : addLabel}
                className="min-w-28 flex-1 bg-transparent px-1 py-0.5 text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                        e.preventDefault();
                        commit(draft);
                    } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
                        onChange(value.slice(0, -1));
                    }
                }}
                onBlur={() => commit(draft)}
                {...aria}
            />
        </div>
    );
}
