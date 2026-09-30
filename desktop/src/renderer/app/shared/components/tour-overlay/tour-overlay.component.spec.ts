/**
 * @vitest-environment jsdom
 */
import '@angular/compiler';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TourOverlayComponent } from './tour-overlay.component';

describe('TourOverlayComponent', () => {
    let overlay: TourOverlayComponent;
    let tours: any;
    let ngZone: any;

    const step = { route: '/dashboard', selector: '#tour-target', title: 'Hi', body: 'Hello' };

    beforeEach(() => {
        tours = {
            _active: true,
            isActive: vi.fn(() => tours._active),
            current: vi.fn(() => (tours._active ? step : null)),
            position: vi.fn(() => 0),
            stepCount: vi.fn(() => 3),
            next: vi.fn(),
            back: vi.fn(),
            skip: vi.fn()
        };
        ngZone = { run: vi.fn((fn: any) => fn()) };
        document.body.innerHTML = '<div id="tour-target" style="width:100px;height:40px;"></div>';
        overlay = new TourOverlayComponent(tours, ngZone);
    });

    it('spotlights the step target and advances', () => {
        overlay.refresh();
        expect(overlay.step).toBe(step);
        expect(overlay.rect).not.toBeNull();
        expect(overlay.total).toBe(3);

        overlay.next();
        expect(tours.next).toHaveBeenCalled();
        overlay.back();
        expect(tours.back).toHaveBeenCalled();
        overlay.skip();
        expect(tours.skip).toHaveBeenCalled();
    });

    it('centers the card when the target is absent', () => {
        document.body.innerHTML = '';
        overlay.refresh();
        expect(overlay.step).toBe(step);
        expect(overlay.rect).toBeNull();
        expect(overlay.cardStyle.left).toContain('50%');
    });

    it('clears when the tour is inactive', () => {
        tours._active = false;
        overlay.refresh();
        expect(overlay.step).toBeNull();
        expect(overlay.rect).toBeNull();
    });

    it('subscribes on init and releases on destroy', () => {
        expect(() => {
            overlay.ngOnInit();
            overlay.ngOnDestroy();
        }).not.toThrow();
        expect(overlay.step).toBe(step);
    });
});
