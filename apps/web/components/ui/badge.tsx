import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
    'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors',
    {
        variants: {
            variant: {
                default: 'border-transparent bg-navy-900 text-white dark:bg-navy-700',
                neutral: 'border-border bg-muted text-muted-foreground',
                success: 'border-transparent bg-success-500/15 text-success-700 dark:text-green-300',
                warning: 'border-transparent bg-warning-500/15 text-warning-700 dark:text-amber-300',
                info: 'border-transparent bg-info-500/15 text-info-700 dark:text-blue-300',
                danger: 'border-transparent bg-danger-500/15 text-danger-700 dark:text-red-300',
                coral: 'border-transparent bg-coral-500/15 text-coral-700 dark:text-coral-300'
            }
        },
        defaultVariants: { variant: 'default' }
    }
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
    return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
