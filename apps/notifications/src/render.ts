// Handlebars-lite template rendering: {{path.to.value}} interpolation plus
// truthy sections {{#key}}...{{/key}}. No helpers, no iteration — enough for
// transactional templates.

export type TemplatePayload = Record<string, unknown>;

function lookup(payload: TemplatePayload, dottedPath: string): unknown {
    let cur: unknown = payload;
    for (const part of dottedPath.split('.')) {
        if (cur === null || typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
}

const SECTION_RE = /\{\{#\s*([\w.]+)\s*\}\}([\s\S]*?)\{\{\/\s*\1\s*\}\}/g;
const RAW_VAR_RE = /\{\{\{\s*([\w.]+)\s*\}\}\}/g;
const VAR_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * Render `template` against `payload`.
 * - Sections {{#key}}...{{/key}} render their body when the value is truthy.
 * - Variables {{key}} render String(value); missing values render ''.
 * - Raw variables {{{key}}} render String(value) unescaped — only for trusted
 *   content already produced server-side (e.g. admin test-send of a rendered
 *   template), never for user-supplied payload fields.
 * - `escape` controls HTML-escaping of substituted values (use for body_html).
 */
export function renderTemplate(template: string, payload: TemplatePayload, escape = false): string {
    const esc = (s: string) =>
        escape
            ? s
                  .replace(/&/g, '&amp;')
                  .replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;')
                  .replace(/'/g, '&#39;')
            : s;

    // Sections first (innermost-first via global replace until stable).
    let out = template;
    for (let i = 0; i < 10; i++) {
        const next = out.replace(SECTION_RE, (_m, key: string, body: string) => (lookup(payload, key) ? body : ''));
        if (next === out) break;
        out = next;
    }
    out = out.replace(RAW_VAR_RE, (_m, key: string) => {
        const value = lookup(payload, key);
        return value === undefined || value === null ? '' : String(value);
    });
    return out.replace(VAR_RE, (_m, key: string) => {
        const value = lookup(payload, key);
        return value === undefined || value === null ? '' : esc(String(value));
    });
}
