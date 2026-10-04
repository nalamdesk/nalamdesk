import { describe, expect, it } from 'vitest';
import {
    isAbhaAddressShape,
    isIdentifierSystem,
    luhnCheck,
    normalizeAbhaNumber,
    validateAbhaNumber,
    validateIdentifier
} from './patient-identifiers';

describe('patient-identifiers', () => {
    it('accepts the known systems and rejects the rest', () => {
        expect(isIdentifierSystem('mrn')).toBe(true);
        expect(isIdentifierSystem('abha-number')).toBe(true);
        expect(isIdentifierSystem('abha-address')).toBe(true);
        expect(isIdentifierSystem('insurance')).toBe(true);
        expect(isIdentifierSystem('other')).toBe(true);
        expect(isIdentifierSystem('aadhaar')).toBe(false);
        expect(isIdentifierSystem(null)).toBe(false);
    });

    it('normalizes ABHA numbers to XX-XXXX-XXXX-XXXX', () => {
        expect(normalizeAbhaNumber('12 3456 7890 1237')).toBe('12-3456-7890-1237');
        expect(normalizeAbhaNumber('12-3456-7890-1237')).toBe('12-3456-7890-1237');
        expect(normalizeAbhaNumber('12345678901237')).toBe('12-3456-7890-1237');
        expect(normalizeAbhaNumber('too-short')).toBeNull();
        expect(normalizeAbhaNumber('123456789012345')).toBeNull();
        expect(normalizeAbhaNumber(null)).toBeNull();
    });

    it('checks Luhn checksums', () => {
        expect(luhnCheck('79927398713')).toBe(true);
        expect(luhnCheck('79927398710')).toBe(false);
        expect(luhnCheck('')).toBe(false);
        expect(luhnCheck('12a45')).toBe(false);
    });

    it('validates ABHA numbers by shape and checksum', () => {
        // 79927398713891: 14 digits with a valid Luhn check digit.
        expect(validateAbhaNumber('79927398713891')).toBe('79-9273-9871-3891');
        expect(() => validateAbhaNumber('123')).toThrow('14 digits');
        expect(() => validateAbhaNumber('79927398713890')).toThrow('checksum');
    });

    it('validates ABHA address shape', () => {
        expect(isAbhaAddressShape('ramu99@abdm')).toBe(true);
        expect(isAbhaAddressShape('RAMU99@ABDM')).toBe(true);
        expect(isAbhaAddressShape('ramu99@other')).toBe(false);
        expect(isAbhaAddressShape('ab@abdm')).toBe(false);
        expect(isAbhaAddressShape(null)).toBe(false);
    });

    it('validates one identifier row per system rules', () => {
        expect(validateIdentifier('abha-number', '79927398713891')).toBe('79-9273-9871-3891');
        expect(validateIdentifier('abha-address', 'Ramu99@ABDM')).toBe('ramu99@abdm');
        expect(validateIdentifier('mrn', 'ND-100001')).toBe('ND-100001');
        expect(validateIdentifier('insurance', 'POL-7788')).toBe('POL-7788');
        expect(() => validateIdentifier('aadhaar', '1234')).toThrow('Unknown identifier system');
        expect(() => validateIdentifier('mrn', '  ')).toThrow('required');
        expect(() => validateIdentifier('mrn', 'oops')).toThrow('ND-100001');
        expect(() => validateIdentifier('abha-address', 'ramu99@other')).toThrow('name@abdm');
        expect(() => validateIdentifier('other', 'x'.repeat(65))).toThrow('too long');
    });
});
