import { describe, expect, it } from 'vitest';
import { open, seal } from '../src/seal.js';
import { clinicKeys } from './helpers.js';

describe('seal', () => {
    it('round-trips for the right clinic and type', () => {
        const keys = clinicKeys();
        const sealed = seal(Buffer.from('hello'), keys.publicRaw, 'clinic-1', 'abdm-callback');
        expect(open(sealed, keys.privateKey, 'clinic-1', 'abdm-callback').toString()).toBe('hello');
    });

    it('uses a fresh ephemeral key every time', () => {
        const keys = clinicKeys();
        const a = seal(Buffer.from('x'), keys.publicRaw, 'c', 't');
        const b = seal(Buffer.from('x'), keys.publicRaw, 'c', 't');
        expect(a).not.toBe(b);
    });

    it('fails to open for another clinic, another type or another key', () => {
        const keys = clinicKeys();
        const sealed = seal(Buffer.from('hello'), keys.publicRaw, 'clinic-1', 'abdm-callback');
        expect(() => open(sealed, keys.privateKey, 'clinic-2', 'abdm-callback')).toThrow();
        expect(() => open(sealed, keys.privateKey, 'clinic-1', 'abdm-data-push')).toThrow();
        expect(() => open(sealed, clinicKeys().privateKey, 'clinic-1', 'abdm-callback')).toThrow();
    });

    it('rejects a malformed recipient key', () => {
        expect(() => seal(Buffer.from('x'), 'AAAA', 'c', 't')).toThrow(/32-byte/);
    });
});
