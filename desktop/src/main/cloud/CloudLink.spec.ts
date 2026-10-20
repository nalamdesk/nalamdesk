import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron-log', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { scheduleRotation } from './CloudLink';

describe('scheduleRotation', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('retries a failed rotation within minutes, not the next hour', async () => {
        vi.useFakeTimers();
        const results = [false, false, true];
        const rotate = vi.fn(async () => { if (!results.shift()) throw new Error('reply lost'); });
        const stop = scheduleRotation(rotate, 60 * 60_000, 2 * 60_000);
        expect(rotate).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2 * 60_000);
        expect(rotate).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(2 * 60_000);
        expect(rotate).toHaveBeenCalledTimes(3);
        // Succeeded: nothing more until the hourly check.
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        expect(rotate).toHaveBeenCalledTimes(3);
        stop();
        await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
        expect(rotate).toHaveBeenCalledTimes(3);
    });

    it('stops a pending retry', async () => {
        vi.useFakeTimers();
        const rotate = vi.fn(async () => { throw new Error('offline'); });
        const stop = scheduleRotation(rotate, 60 * 60_000, 2 * 60_000);
        await vi.advanceTimersByTimeAsync(0);
        stop();
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(rotate).toHaveBeenCalledTimes(1);
    });
});
