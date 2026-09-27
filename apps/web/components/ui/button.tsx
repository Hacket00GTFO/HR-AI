import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

// coral-600 (#D14438) on white text = AA-compliant primary action.
// coral-500 (#F45B4E) stays for accents/large elements only.
const buttonVariants = cva(
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
    {
        variants: {
            variant: {
                primary: 'bg-coral-600 text-white shadow-sm hover:bg-coral-700',
                secondary: 'border border-border bg-card text-foreground shadow-sm hover:bg-muted',
                ghost: 'text-foreground hover:bg-muted',
                danger: 'bg-danger-500 text-white shadow-sm hover:bg-danger-700'
            },
            size: {
                sm: 'h-8 px-3 text-sm',
                md: 'h-10 px-4 text-sm',
                lg: 'h-12 px-6 text-base',
                icon: 'h-10 w-10'
            }
        },
        defaultVariants: { variant: 'primary', size: 'md' }
    }
);

export interface ButtonProps
    extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
    asChild?: boolean;
    loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, variant, size, asChild = false, loading = false, disabled, children, ...props }, ref) => {
        const Comp = asChild ? Slot : 'button';
        return (
            <Comp
                ref={ref}
                className={cn(buttonVariants({ variant, size }), className)}
                disabled={disabled || loading}
                aria-busy={loading || undefined}
                {...props}
            >
                {/* Slot requires exactly one element child — never append the
                    spinner sibling when rendering asChild. */}
                {asChild ? (
                    children
                ) : (
                    <>
                        {loading && <Loader2 className="animate-spin" aria-hidden="true" />}
                        {children}
                    </>
                )}
            </Comp>
        );
    }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
