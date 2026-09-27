import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { StatusBadge } from '@/components/ui/status-badge';

const messages = {
    status: {
        pending: 'Pending',
        interview: 'Interview',
        accepted: 'Accepted',
        rejected: 'Rejected',
        active: 'Active',
        paused: 'Paused',
        closed: 'Closed',
        draft: 'Draft'
    }
};

function renderBadge(status: string) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages}>
            <StatusBadge status={status} />
        </NextIntlClientProvider>
    );
}

describe('StatusBadge — canonical status → semantic color map', () => {
    it.each([
        ['pending', 'warning'],
        ['interview', 'info'],
        ['accepted', 'success'],
        ['rejected', 'danger']
    ])('%s maps to %s', (status, variant) => {
        const { container } = renderBadge(status);
        const badge = container.querySelector('span')!;
        expect(badge.className).toContain(`bg-${variant}-500/15`);
    });

    it('normalizes case (Pending → warning)', () => {
        const { container } = renderBadge('Pending');
        expect(screen.getByText('Pending')).toBeInTheDocument();
        expect(container.querySelector('span')!.className).toContain('bg-warning-500/15');
    });

    it('falls back to neutral + raw text for unknown statuses', () => {
        renderBadge('custom-state');
        expect(screen.getByText('custom-state')).toBeInTheDocument();
    });
});
