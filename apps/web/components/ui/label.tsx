'use client';

import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cn } from '@/lib/utils';

// Always pair with a control via htmlFor (or wrap the control inside).
const Label = React.forwardRef<
    React.ElementRef<typeof LabelPrimitive.Root>,
    React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> & { required?: boolean | undefined }
>(({ className, required, children, ...props }, ref) => (
    <LabelPrimitive.Root
        ref={ref}
        className={cn(
            'text-sm font-medium leading-none text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
            className
        )}
        {...props}
    >
        {children}
        {required && (
            <span aria-hidden="true" className="ml-0.5 text-coral-600 dark:text-coral-400">
                *
            </span>
        )}
    </LabelPrimitive.Root>
));
Label.displayName = 'Label';

export { Label };
