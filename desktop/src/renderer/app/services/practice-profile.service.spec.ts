/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { PracticeProfileService } from './practice-profile.service';

describe('PracticeProfileService', () => {
    it('defaults to India ABDM and derives display helpers', () => {
        const service = new PracticeProfileService(null);
        expect(service.mode()).toBe('india_abdm');
        expect(service.frequency('1-0-1')).toBe('1-0-1');
        expect(service.temperature(37).unit).toBe('°F');
        expect(service.identifierLabel()).toBe('ABHA Number');
        expect(service.exportLabel()).toBe('ABDM NRCeS FHIR R4');
    });

    it('loads the stored mode and switches reactively', async () => {
        const invoke = vi.fn()
            .mockResolvedValueOnce({ standards_mode: 'international' })
            .mockResolvedValue({});
        const service = new PracticeProfileService({ invoke } as any);
        await service.load();
        expect(service.mode()).toBe('international');
        expect(service.frequency('1-0-1')).toBe('BID');
        expect(service.identifierLabel()).toBe('MRN / National ID');

        await service.setMode('india_abdm');
        expect(invoke).toHaveBeenCalledWith('saveSettings', { standards_mode: 'india_abdm' });
        expect(service.mode()).toBe('india_abdm');
    });

    it('ignores unknown stored modes and rejects unknown sets', async () => {
        const service = new PracticeProfileService({ invoke: vi.fn().mockResolvedValue({ standards_mode: 'mars' }) } as any);
        await service.load();
        expect(service.mode()).toBe('india_abdm');
        await expect(service.setMode('mars' as any)).rejects.toThrow('Unknown standards mode');
    });

    it('stays on default when the backend is unreachable', async () => {
        const service = new PracticeProfileService({ invoke: vi.fn().mockRejectedValue(new Error('down')) } as any);
        await service.load();
        expect(service.mode()).toBe('india_abdm');
    });
});
