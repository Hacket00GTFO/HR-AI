'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './button';

interface PaginationProps {
    page: number;
    totalPages: number;
    onPageChange: (page: number) => void;
    previousLabel?: string;
    nextLabel?: string;
    pageLabel?: (page: number) => string;
    className?: string;
}

export function Pagination({
    page,
    totalPages,
    onPageChange,
    previousLabel = 'Previous',
    nextLabel = 'Next',
    pageLabel = (p) => `Page ${p}`,
    className
}: PaginationProps) {
    if (totalPages <= 1) return null;
    const pages = Array.from({ length: totalPages }, (_, i) => i + 1);
    return (
        <nav aria-label="Pagination" className={cn('flex items-center justify-center gap-1', className)}>
            <Button
                variant="ghost"
                size="sm"
                onClick={() => onPageChange(page - 1)}
                disabled={page <= 1}
                aria-label={previousLabel}
            >
                <ChevronLeft aria-hidden="true" />
            </Button>
            {pages.map((p) => (
                <Button
                    key={p}
                    variant={p === page ? 'secondary' : 'ghost'}
                    size="sm"
                    onClick={() => onPageChange(p)}
                    aria-label={pageLabel(p)}
                    aria-current={p === page ? 'page' : undefined}
                >
                    {p}
                </Button>
            ))}
            <Button
                variant="ghost"
                size="sm"
                onClick={() => onPageChange(page + 1)}
                disabled={page >= totalPages}
                aria-label={nextLabel}
            >
                <ChevronRight aria-hidden="true" />
            </Button>
        </nav>
    );
}
