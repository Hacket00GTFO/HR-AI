import { cn } from '@/lib/utils';
import { Button } from './button';

interface EmptyStateProps {
    icon?: React.ReactNode;
    title: string;
    description?: string;
    actionLabel?: string;
    onAction?: () => void;
    className?: string;
}

export function EmptyState({ icon, title, description, actionLabel, onAction, className }: EmptyStateProps) {
    return (
        <div
            className={cn(
                'flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card/50 px-6 py-12 text-center',
                className
            )}
        >
            {icon && (
                <div aria-hidden="true" className="text-muted-foreground [&_svg]:size-10">
                    {icon}
                </div>
            )}
            <p className="font-display text-base font-semibold text-foreground">{title}</p>
            {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
            {actionLabel && onAction && (
                <Button variant="secondary" size="sm" onClick={onAction} className="mt-2">
                    {actionLabel}
                </Button>
            )}
        </div>
    );
}
