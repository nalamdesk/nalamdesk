import { describe, expect, it, vi } from 'vitest';
import { SetupChecklistComponent, buildSetupSteps } from './setup-checklist.component';

const facts = { clinicName: '', doctorCount: 0, patientCount: 0, lastBackupAt: null, cloudPaired: false };

describe('buildSetupSteps', () => {
    it('marks each step from live facts; online booking stays optional', () => {
        const steps = buildSetupSteps({ ...facts, clinicName: 'Sri Clinic', patientCount: 3 });
        expect(steps.map((s) => [s.id, s.done])).toEqual([
            ['clinic', true], ['doctor', false], ['patient', true], ['backup', false], ['cloud', false]
        ]);
        expect(steps.find((s) => s.id === 'cloud')?.optional).toBe(true);
        expect(steps.find((s) => s.id === 'backup')?.queryParams).toEqual({ tab: 'backup' });
    });
});

describe('SetupChecklistComponent', () => {
    const zone = { run: (fn: () => any) => fn() } as any;

    it('loads facts, counts required steps, and hides once all are done', async () => {
        const invoke = vi.fn(async (method: string) => {
            if (method === 'getPublicSettings') return { clinic_name: 'Sri Clinic' };
            if (method === 'getUsers') return [{ role: 'admin' }, { role: 'doctor' }];
            if (method === 'backupGetHealth') return { lastBackupAt: '2026-11-24T10:00:00Z' };
            return null;
        });
        const c = new SetupChecklistComponent({ invoke } as any, { navigate: vi.fn() } as any, zone,
            { getStatus: vi.fn(async () => ({ state: 'unpaired' })) } as any);
        c.patientCount = 0;
        await c.load();
        expect(c.doneCount).toBe(3);
        expect(c.requiredCount).toBe(4);
        expect(c.allRequiredDone).toBe(false);
        c.patientCount = 1;
        await c.load();
        expect(c.allRequiredDone).toBe(true);
    });

    it('survives failing sources and navigates to the step', async () => {
        const navigate = vi.fn();
        const c = new SetupChecklistComponent({ invoke: vi.fn(async () => { throw new Error('down'); }) } as any,
            { navigate } as any, zone, undefined);
        await c.load();
        expect(c.doneCount).toBe(0);
        c.go(c.steps[3]);
        expect(navigate).toHaveBeenCalledWith(['/settings'], { queryParams: { tab: 'backup' } });
    });
});
