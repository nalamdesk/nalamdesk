import { describe, expect, it } from 'vitest';
import {
    acceptedFrequencySpellings,
    durationEndDate,
    frequencyLatin,
    isKnownFrequency,
    parseDurationDays,
    parseFrequency
} from './clinical-timing';

describe('clinical-timing', () => {
    it('parses Latin SIG to canonical shorthand', () => {
        expect(parseFrequency('BID')).toBe('1-0-1');
        expect(parseFrequency('TID')).toBe('1-1-1');
        expect(parseFrequency('OD')).toBe('1-0-0');
        expect(parseFrequency('HS')).toBe('0-0-1');
        expect(parseFrequency('PRN')).toBe('SOS');
        expect(parseFrequency('STAT')).toBe('STAT');
    });

    it('parses shorthand variants case- and space-insensitively', () => {
        expect(parseFrequency('bid')).toBe('1-0-1');
        expect(parseFrequency('  bid  ')).toBe('1-0-1');
        expect(parseFrequency('Bd')).toBe('1-0-1');
        expect(parseFrequency('QHS')).toBe('0-0-1');
        expect(parseFrequency('as needed')).toBe('SOS');
        expect(parseFrequency('1-0-1')).toBe('1-0-1');
        expect(parseFrequency('1-0-1 (BID)')).toBe('1-0-1');
    });

    it('passes unknown schedules through unchanged', () => {
        expect(parseFrequency('every 6 hours')).toBe('every 6 hours');
        expect(parseFrequency('')).toBe('');
        expect(parseFrequency(null)).toBe('');
        expect(isKnownFrequency('BID')).toBe(true);
        expect(isKnownFrequency('every 6 hours')).toBe(false);
        expect(isKnownFrequency('')).toBe(false);
    });

    it('maps canonical forms to Latin labels', () => {
        expect(frequencyLatin('1-0-1')).toBe('BID');
        expect(frequencyLatin('SOS')).toBe('PRN');
        expect(frequencyLatin('STAT')).toBe('STAT');
        expect(frequencyLatin('weird')).toBe('weird');
    });

    it('exposes the accepted spellings for hints', () => {
        const spellings = acceptedFrequencySpellings();
        expect(spellings).toContain('BID');
        expect(spellings).toContain('1-0-1');
        expect(spellings.length).toBeGreaterThan(20);
    });

    it('parses finite course durations into days', () => {
        expect(parseDurationDays('3 days')).toBe(3);
        expect(parseDurationDays('5 Days')).toBe(5);
        expect(parseDurationDays('1 week')).toBe(7);
        expect(parseDurationDays('2 weeks')).toBe(14);
        expect(parseDurationDays('1 month')).toBe(30);
        expect(parseDurationDays('3-4 days')).toBe(4);
        expect(parseDurationDays('single dose')).toBe(1);
        expect(parseDurationDays('STAT')).toBe(1);
    });

    it('leaves open-ended and unknown durations open', () => {
        expect(parseDurationDays('until review')).toBeNull();
        expect(parseDurationDays('chronic')).toBeNull();
        expect(parseDurationDays('long term')).toBeNull();
        expect(parseDurationDays('SOS')).toBeNull();
        expect(parseDurationDays('')).toBeNull();
        expect(parseDurationDays(null)).toBeNull();
        expect(parseDurationDays('every 6 hours')).toBeNull();
        expect(parseDurationDays('1-0-1')).toBeNull();
    });

    it('derives course end dates from a start plus duration', () => {
        expect(durationEndDate('2026-10-01', '3 days')).toBe('2026-10-04');
        expect(durationEndDate('2026-10-01', '1 week')).toBe('2026-10-08');
        expect(durationEndDate('2026-10-01', 'until review')).toBeNull();
        expect(durationEndDate('not-a-date', '3 days')).toBeNull();
    });
});
