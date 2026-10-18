import { describe, it, expect } from 'vitest';
import { DoctorPickService, SOLE_PRACTITIONER_REASON } from './doctor-pick.service';

describe('DoctorPickService', () => {
    it('resolves null without opening when no doctors are available', async () => {
        const service = new DoctorPickService();
        await expect(service.request([])).resolves.toBeNull();
        expect(service.open()).toBe(false);
    });

    it('resolves the only doctor immediately with the standing reason', async () => {
        const service = new DoctorPickService();
        await expect(service.request([{ id: 10, name: 'Dr. Smith' }])).resolves.toEqual({
            id: 10,
            reason: SOLE_PRACTITIONER_REASON
        });
        expect(service.open()).toBe(false);
    });

    it('opens the picker and resolves the choice with a typed reason', async () => {
        const service = new DoctorPickService();
        const pending = service.request([
            { id: 10, name: 'Dr. Smith' },
            { id: 11, name: 'Dr. Jones' }
        ]);
        expect(service.open()).toBe(true);
        expect(service.doctors()).toHaveLength(2);
        service.reasonInput.set('Covering night shift');
        service.choose(11);
        await expect(pending).resolves.toEqual({ id: 11, reason: 'Covering night shift' });
        expect(service.open()).toBe(false);
        expect(service.doctors()).toHaveLength(0);
    });

    it('keeps the picker open until a reason is given', async () => {
        const service = new DoctorPickService();
        const pending = service.request([
            { id: 10, name: 'Dr. Smith' },
            { id: 11, name: 'Dr. Jones' }
        ]);
        service.choose(11);
        expect(service.open()).toBe(true);
        expect(service.reasonError()).toBe(true);
        service.reasonInput.set('Covering night shift');
        service.choose(11);
        await expect(pending).resolves.toEqual({ id: 11, reason: 'Covering night shift' });
        expect(service.open()).toBe(false);
    });

    it('resolves null when the picker is cancelled', async () => {
        const service = new DoctorPickService();
        const pending = service.request([
            { id: 10, name: 'Dr. Smith' },
            { id: 11, name: 'Dr. Jones' }
        ]);
        service.choose(null);
        await expect(pending).resolves.toBeNull();
        expect(service.open()).toBe(false);
    });

    it('resolves every concurrent request instead of hanging the earlier ones', async () => {
        const service = new DoctorPickService();
        const first = service.request([
            { id: 10, name: 'Dr. Smith' },
            { id: 11, name: 'Dr. Jones' }
        ]);
        const second = service.request([
            { id: 10, name: 'Dr. Smith' },
            { id: 11, name: 'Dr. Jones' }
        ]);
        service.reasonInput.set('Covering night shift');
        service.choose(10);
        await expect(first).resolves.toEqual({ id: 10, reason: 'Covering night shift' });
        await expect(second).resolves.toEqual({ id: 10, reason: 'Covering night shift' });
        expect(service.open()).toBe(false);
    });
});
