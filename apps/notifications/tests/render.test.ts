import { describe, expect, it } from 'vitest';
import { renderTemplate } from '../src/render.js';

describe('renderTemplate (handlebars-lite)', () => {
    it('interpolates {{name}}-style variables', () => {
        expect(renderTemplate('Hi {{name}}, welcome to {{app}}', { name: 'Ana', app: 'StraforAI' })).toBe(
            'Hi Ana, welcome to StraforAI'
        );
    });

    it('resolves dotted paths', () => {
        expect(renderTemplate('Job: {{vacancy.title}}', { vacancy: { title: 'DevOps' } })).toBe('Job: DevOps');
    });

    it('renders missing values as empty string', () => {
        expect(renderTemplate('Hi {{name}}!', {})).toBe('Hi !');
    });

    it('renders truthy sections and drops falsy ones', () => {
        const tpl = 'Applied{{#vacancyTitle}} to {{vacancyTitle}}{{/vacancyTitle}}.';
        expect(renderTemplate(tpl, { vacancyTitle: 'Backend Dev' })).toBe('Applied to Backend Dev.');
        expect(renderTemplate(tpl, {})).toBe('Applied.');
    });

    it('escapes HTML when escape=true', () => {
        expect(renderTemplate('<p>{{name}}</p>', { name: '<script>alert(1)</script>' }, true)).toBe(
            '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'
        );
    });

    it('does not escape when escape=false', () => {
        expect(renderTemplate('{{url}}', { url: 'https://x?a=1&b=2' })).toBe('https://x?a=1&b=2');
    });

    it('stringifies non-string values', () => {
        expect(renderTemplate('Count: {{n}}', { n: 5 })).toBe('Count: 5');
    });
});
