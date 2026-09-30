/**
 * @vitest-environment jsdom
 */
import '@angular/compiler';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TourService } from './tour.service';

describe('TourService', () => {
    let service: TourService;
    let router: any;

    beforeEach(() => {
        localStorage.clear();
        router = { navigate: vi.fn() };
        service = new TourService(router);
    });

    it('walks every step then finishes on the dashboard', () => {
        service.start('admin');
        expect(service.isActive()).toBe(true);
        expect(service.stepCount()).toBe(6);
        expect(service.current()?.route).toBe('/dashboard');
        expect(router.navigate).toHaveBeenCalledWith(['/dashboard']);

        for (let i = 0; i < 5; i++) service.next();
        expect(service.current()?.route).toBe('/settings');
        service.next();
        expect(service.isActive()).toBe(false);
        expect(service.dismissed).toBe(true);
        expect(router.navigate).toHaveBeenLastCalledWith(['/dashboard']);
    });

    it('omits the admin settings step for desk roles', () => {
        service.start('nurse');
        expect(service.stepCount()).toBe(5);
        for (let i = 0; i < 5; i++) service.next();
        expect(service.isActive()).toBe(false);
        expect(router.navigate).not.toHaveBeenCalledWith(['/settings']);
    });

    it('moves back without leaving the first step', () => {
        service.start('doctor');
        service.back();
        expect(service.position()).toBe(0);
        service.next();
        expect(service.position()).toBe(1);
        service.back();
        expect(service.position()).toBe(0);
        expect(service.isActive()).toBe(true);
    });

    it('skips without recording progress', () => {
        service.start('receptionist');
        service.skip();
        expect(service.isActive()).toBe(false);
        expect(service.dismissed).toBe(true);
        expect(service.current()).toBeNull();
    });
});
