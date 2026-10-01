import { describe, it, expect } from 'vitest';
import { deriveAge } from './patient-age';

const NOW = new Date('2026-03-10T12:00:00');

describe('deriveAge', () => {
    it('derives completed years from DOB', () => {
        expect(deriveAge('1990-05-01', false, null, NOW)).toMatchObject({ years: 35, label: '35' });
        // Birthday tomorrow: not yet turned.
        expect(deriveAge('1990-03-11', false, null, NOW).years).toBe(35);
        expect(deriveAge('1990-03-10', false, null, NOW).years).toBe(36);
    });

    it('marks estimated DOB honestly', () => {
        expect(deriveAge('1990-05-01', true, null, NOW)).toMatchObject({ years: 35, estimated: true, label: '≈35' });
        expect(deriveAge('1990-05-01', 1, null, NOW).label).toBe('≈35');
    });

    it('falls back to stored age for unknown DOB', () => {
        expect(deriveAge(null, false, 42, NOW)).toMatchObject({ years: 42, label: '42' });
        expect(deriveAge('', false, null, NOW)).toMatchObject({ years: null, label: '—' });
    });

    it('rejects future and malformed DOB', () => {
        expect(deriveAge('2030-01-01', false, 50, NOW).years).toBe(50);
        expect(deriveAge('not-a-date', false, null, NOW).years).toBeNull();
    });
});
