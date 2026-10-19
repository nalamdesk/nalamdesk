// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { formatReference, newReference, normalisePhone, parseReference, phoneDigest, REF_PATTERN } from '../src/lib/booking';

describe('booking helpers', () => {
    it('makes 12-character Crockford references and reads them back however they are typed', () => {
        const refs = new Set(Array.from({ length: 200 }, () => newReference()));
        expect(refs.size).toBe(200);
        for (const ref of refs) expect(ref).toMatch(REF_PATTERN);
        expect(formatReference('7K3P9QXA2B4M')).toBe('7K3P-9QXA-2B4M');
        expect(parseReference(' 7k3p-9qxa-2b4m ')).toBe('7K3P9QXA2B4M');
        expect(parseReference('7K3P-9QXA-2B4O')).toBe('7K3P9QXA2B40');
        expect(parseReference('12345')).toBeNull();
    });

    it('normalises Indian numbers and enforces 10 to 15 digits', () => {
        expect(normalisePhone('98765 43210')).toBe('9876543210');
        expect(normalisePhone('+91 98765-43210')).toBe('9876543210');
        expect(normalisePhone('098765 43210')).toBe('9876543210');
        expect(normalisePhone('+44 20 7946 0958')).toBe('442079460958');
        expect(normalisePhone('12345')).toBeNull();
        expect(normalisePhone('1234567890123456')).toBeNull();
    });

    it('digests the same number the same way, whatever the formatting', async () => {
        const a = await phoneDigest(normalisePhone('+91 98765 43210')!);
        const b = await phoneDigest(normalisePhone('9876543210')!);
        expect(a).toBe(b);
        expect(a).toMatch(/^[0-9a-f]{64}$/);
    });
});
