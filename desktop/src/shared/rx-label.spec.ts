import { describe, expect, it } from 'vitest';
import { formatRxMedicineName } from './rx-label';

describe('formatRxMedicineName', () => {
    it('prints GENERIC (Brand) when both are known', () => {
        expect(formatRxMedicineName({ medicine: 'Crocin 500', generic_name: 'Paracetamol', brand_name: 'Crocin' }))
            .toBe('Paracetamol (Crocin)');
    });

    it('prints the raw name when no generic is on file', () => {
        expect(formatRxMedicineName({ medicine: 'Local mixture' })).toBe('Local mixture');
        expect(formatRxMedicineName({})).toBe('');
    });

    it('prints the generic alone when the brand matches or is missing', () => {
        expect(formatRxMedicineName({ medicine: 'Paracetamol', generic_name: 'Paracetamol', brand_name: 'Paracetamol' }))
            .toBe('Paracetamol');
        expect(formatRxMedicineName({ medicine: 'Paracetamol', generic_name: 'Paracetamol' }))
            .toBe('Paracetamol');
    });

    it('keeps an unrelated typed name visible next to the label', () => {
        expect(formatRxMedicineName({ medicine: 'Aspirin', generic_name: 'Paracetamol', brand_name: 'Crocin' }))
            .toBe('Paracetamol (Crocin, as Aspirin)');
    });
});
