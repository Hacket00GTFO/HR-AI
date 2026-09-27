import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

describe('Button', () => {
    it('renders children and is clickable', async () => {
        let clicked = 0;
        render(<Button onClick={() => clicked++}>Save</Button>);
        const btn = screen.getByRole('button', { name: 'Save' });
        await userEvent.click(btn);
        expect(clicked).toBe(1);
    });

    it('applies the AA-safe coral-600 primary variant', () => {
        render(<Button variant="primary">Apply</Button>);
        expect(screen.getByRole('button')).toHaveClass('bg-coral-600');
    });

    it('is disabled and busy while loading', () => {
        render(<Button loading>Working</Button>);
        const btn = screen.getByRole('button');
        expect(btn).toBeDisabled();
        expect(btn).toHaveAttribute('aria-busy', 'true');
    });

    it('supports asChild to render a link', () => {
        render(
            <Button asChild>
                <Link href="/careers">Careers</Link>
            </Button>
        );
        const link = screen.getByRole('link', { name: 'Careers' });
        expect(link).toHaveAttribute('href', '/careers');
    });
});
