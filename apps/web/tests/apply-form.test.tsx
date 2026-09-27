import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { ApplyForm } from '@/components/careers/apply-form';
import messages from '../messages/en.json';

// ApplyForm uses useRouter for the post-submit "back to careers" action;
// there is no App Router context in jsdom, so stub it.
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() })
}));

beforeAll(() => {
    // The form fetches /api/countries on mount — stub an empty list so it
    // falls back to the free-text country input.
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, json: async () => [] }) as Response)
    );
});

function renderForm() {
    return render(
        <NextIntlClientProvider locale="en" messages={messages}>
            <ApplyForm vacancyId={1} vacancyTitle="Frontend Engineer" />
        </NextIntlClientProvider>
    );
}

describe('ApplyForm', () => {
    it('shows required-field errors on empty submit', async () => {
        renderForm();
        await userEvent.click(screen.getByRole('button', { name: /submit application/i }));
        const alerts = await screen.findAllByRole('alert');
        expect(alerts.length).toBeGreaterThanOrEqual(3); // name, email, phone, education, country…
        expect(alerts.some((a) => a.textContent === 'This field is required')).toBe(true);
        expect(alerts.some((a) => a.textContent === 'Add at least one skill')).toBe(true);
    });

    it('marks invalid controls with aria-invalid', async () => {
        renderForm();
        await userEvent.click(screen.getByRole('button', { name: /submit application/i }));
        const email = await screen.findByLabelText(/email address/i);
        expect(email).toHaveAttribute('aria-invalid', 'true');
        expect(email).toHaveAttribute('aria-describedby', expect.stringContaining('af-email-error'));
    });

    it('rejects an invalid email format', async () => {
        renderForm();
        const email = screen.getByLabelText(/email address/i);
        await userEvent.type(email, 'not-an-email');
        await userEvent.click(screen.getByRole('button', { name: /submit application/i }));
        const alerts = await screen.findAllByRole('alert');
        expect(alerts.some((a) => a.textContent === 'Enter a valid email address')).toBe(true);
    });
});
