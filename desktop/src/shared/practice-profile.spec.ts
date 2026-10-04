import { describe, expect, it } from 'vitest';
import {
    displayFrequency,
    displayTemperature,
    displayWeight,
    exportTarget,
    isStandardsMode,
    parseTemperature,
    parseWeight,
    primaryIdentifierLabel
} from './practice-profile';

describe('practice-profile', () => {
    it('accepts the two modes and rejects the rest', () => {
        expect(isStandardsMode('india_abdm')).toBe(true);
        expect(isStandardsMode('international')).toBe(true);
        expect(isStandardsMode('usa')).toBe(false);
        expect(isStandardsMode(null)).toBe(false);
    });

    it('converts temperature both directions without loss', () => {
        expect(displayTemperature(37, 'international')).toEqual({ value: 37, unit: '°C' });
        expect(displayTemperature(37, 'india_abdm')).toEqual({ value: 98.6, unit: '°F' });
        expect(parseTemperature(98.6, '°F')).toBeCloseTo(37, 5);
        expect(parseTemperature(37, '°C')).toBe(37);
        expect(parseTemperature(37, '')).toBe(37);
    });

    it('converts weight both directions with optional imperial', () => {
        expect(displayWeight(70, 'india_abdm')).toEqual({ value: 70, unit: 'kg' });
        expect(displayWeight(70, 'international')).toEqual({ value: 70, unit: 'kg' });
        expect(displayWeight(70, 'international', true)).toEqual({ value: 154.3, unit: 'lbs' });
        expect(parseWeight(154.3, 'lbs')).toBeCloseTo(70, 1);
        expect(parseWeight(70, 'kg')).toBe(70);
    });

    it('renders Latin frequencies in International mode and passes unknowns through', () => {
        expect(displayFrequency('1-0-1', 'international')).toBe('BID');
        expect(displayFrequency('SOS', 'international')).toBe('PRN');
        expect(displayFrequency('STAT', 'international')).toBe('STAT');
        expect(displayFrequency('1-0-1', 'india_abdm')).toBe('1-0-1');
        expect(displayFrequency('weird-schedule', 'international')).toBe('weird-schedule');
        expect(displayFrequency('', 'international')).toBe('');
    });

    it('labels identity prompts and export targets per mode', () => {
        expect(primaryIdentifierLabel('india_abdm')).toBe('ABHA Number');
        expect(primaryIdentifierLabel('international')).toBe('MRN / National ID');
        expect(exportTarget('india_abdm')).toBe('ABDM NRCeS FHIR R4');
        expect(exportTarget('international')).toBe('HL7 IPS');
    });
});
