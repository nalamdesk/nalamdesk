import { describe, expect, it } from 'vitest';
import { resolveShortcut, shortcutList } from './shortcuts';

const key = (over: Partial<KeyboardEvent> & { target?: any } = {}) => ({
    key: '', code: '', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false,
    target: document.body, ...over,
}) as any;

describe('resolveShortcut', () => {
    it('maps Alt+letter by physical key, so macOS Option symbols still work', () => {
        expect(resolveShortcut(key({ altKey: true, code: 'KeyN', key: '˜' }))).toBe('new-patient');
        expect(resolveShortcut(key({ altKey: true, code: 'KeyQ', key: 'œ' }))).toBe('go-queue');
        expect(resolveShortcut(key({ altKey: true, code: 'KeyZ' }))).toBeNull();
    });

    it('works from inside a form field for Alt shortcuts', () => {
        const input = document.createElement('input');
        expect(resolveShortcut(key({ altKey: true, code: 'KeyF', target: input }))).toBe('search-patients');
    });

    it('ignores / and ? while typing, and other modifier combinations', () => {
        const input = document.createElement('input');
        expect(resolveShortcut(key({ key: '/' }))).toBe('search-patients');
        expect(resolveShortcut(key({ key: '?', shiftKey: true }))).toBe('show-help');
        expect(resolveShortcut(key({ key: '/', target: input }))).toBeNull();
        expect(resolveShortcut(key({ key: '/', ctrlKey: true }))).toBeNull();
        expect(resolveShortcut(key({ altKey: true, ctrlKey: true, code: 'KeyN' }))).toBeNull();
        expect(resolveShortcut(key({ altKey: true, code: 'KeyN', repeat: true }))).toBeNull();
    });

    it('labels keys for the platform', () => {
        expect(shortcutList(true)[0].keys).toBe('⌥N');
        expect(shortcutList(false)[0].keys).toBe('Alt+N');
    });
});
