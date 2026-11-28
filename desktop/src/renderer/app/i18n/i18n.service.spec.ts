import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { I18nService, interpolate } from './i18n.service';
import { TA } from './ta';
import { HI } from './hi';

describe('I18nService', () => {
    beforeEach(() => localStorage.clear());

    it('defaults to English and returns the English text as written', () => {
        const i18n = new I18nService();
        expect(i18n.language()).toBe('en');
        expect(i18n.t('Patient Queue')).toBe('Patient Queue');
        expect(i18n.t('{age} years', { age: 42 })).toBe('42 years');
    });

    it('switches one language at a time, remembers it on this computer, and sets the page lang', () => {
        const i18n = new I18nService();
        i18n.setLanguage('ta');
        expect(i18n.t('Patient Queue')).toBe(TA['Patient Queue']);
        expect(document.documentElement.lang).toBe('ta');
        expect(new I18nService().language()).toBe('ta');
        i18n.setLanguage('hi');
        expect(i18n.t('Patient Queue')).toBe(HI['Patient Queue']);
        expect(i18n.t('A string nobody translated')).toBe('A string nobody translated');
    });

    it('ignores an unknown saved language', () => {
        localStorage.setItem(I18nService.STORAGE_KEY, 'fr');
        expect(new I18nService().language()).toBe('en');
    });

    it('interpolates placeholders and leaves unknown ones visible', () => {
        expect(interpolate('{a} and {b}', { a: 1 })).toBe('1 and {b}');
    });
});

describe('translation coverage', () => {
    // Every literal piped through `| t` in a template must exist in both dictionaries,
    // and both dictionaries must carry the same keys with every placeholder kept.
    const root = path.join(__dirname, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { if (entry.name !== 'i18n') walk(full); }
            else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) files.push(full);
        }
    };
    walk(root);
    const used = new Set<string>();
    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        for (const m of text.matchAll(/(['"])((?:\\.|(?!\1).)+)\1\s*\)?\s*\|\s*t\b/g)) used.add(m[2].replace(/\\'/g, "'"));
        for (const m of text.matchAll(/this\.tr\('((?:\\.|[^'])+)'/g)) used.add(m[1].replace(/\\'/g, "'"));
    }

    it('finds the translated templates', () => {
        expect(used.size).toBeGreaterThan(50);
    });

    for (const [name, dict] of [['Tamil', TA], ['Hindi', HI]] as const) {
        it(`${name} covers every piped string and keeps placeholders`, () => {
            const missing = [...used].filter((k) => !(k in dict));
            expect(missing).toEqual([]);
            for (const [key, value] of Object.entries(dict)) {
                const want = (key.match(/\{\w+\}/g) || []).sort();
                const got = (value.match(/\{\w+\}/g) || []).sort();
                expect(got, key).toEqual(want);
            }
        });
    }

    it('Tamil and Hindi carry the same keys', () => {
        expect(Object.keys(TA).sort()).toEqual(Object.keys(HI).sort());
    });
});
