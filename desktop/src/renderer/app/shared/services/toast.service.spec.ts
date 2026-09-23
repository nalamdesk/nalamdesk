import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToastService } from './toast.service';

describe('ToastService', () => {
    let service: ToastService;

    beforeEach(() => {
        vi.useFakeTimers();
        service = new ToastService();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('stacks toasts and auto-dismisses them', () => {
        service.success('Checked in Ramesh!');
        service.info('Sync running');
        expect(service.toasts()).toHaveLength(2);
        expect(service.toasts()[0]).toMatchObject({ message: 'Checked in Ramesh!', type: 'success' });

        vi.advanceTimersByTime(3500);
        expect(service.toasts()).toHaveLength(0);
    });

    it('dismisses a single toast on demand', () => {
        const id = service.warning('Low stock');
        service.info('Still here');
        service.dismiss(id);
        expect(service.toasts().map(t => t.message)).toEqual(['Still here']);
    });
});
