import { describe, it, expect } from 'vitest';
import { METHOD_CATALOG, ALL_CATALOGUED_ACTIONS, ROLE_TEMPLATES, BUILTIN_ROLES, HANDLER_GATED_ACTIONS } from './access';

describe('access catalog', () => {
    it('covers every template permission', () => {
        for (const template of ROLE_TEMPLATES) {
            for (const method of template.permissions) {
                expect(ALL_CATALOGUED_ACTIONS.has(method), `${template.name} references unknown ${method}`).toBe(true);
            }
        }
    });

    it('keeps handler-gated actions out of templates', () => {
        // Gated actions pass Cedar but are rejected by Electron handler
        // role-strings; templating one would silently do nothing.
        for (const template of ROLE_TEMPLATES) {
            for (const method of template.permissions) {
                expect(HANDLER_GATED_ACTIONS.has(method), `${template.name} templates gated ${method}`).toBe(false);
            }
        }
    });

    it('keeps built-in roles distinct from templates', () => {
        expect(BUILTIN_ROLES).toEqual(['admin', 'doctor', 'nurse', 'receptionist']);
        expect(new Set(ROLE_TEMPLATES.map((t) => t.name)).size).toBe(ROLE_TEMPLATES.length);
    });
});
