import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

// Native <select> — accessible out of the box (keyboard, screen readers,
// mobile pickers) without a heavyweight listbox primitive.
const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
    ({ className, children, ...props }, ref) => (
        <div className="relative">
            <select
                ref={ref}
                className={cn(
                    'flex h-10 w-full appearance-none rounded-md border border-border bg-input px-3 py-2 pr-9 text-sm text-foreground shadow-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger-500 aria-invalid:outline-danger-500',
                    className
                )}
                {...props}
            >
                {children}
            </select>
            <ChevronDown
                aria-hidden="true"
                className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
        </div>
    )
);
Select.displayName = 'Select';

export { Select };
