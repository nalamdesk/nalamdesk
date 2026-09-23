import { describe, it, expect, vi } from 'vitest';
import { QueueCountService } from './queue-count.service';

describe('QueueCountService', () => {
    it('counts active queue entries and resets when loading fails', async () => {
        const dataService = { invoke: vi.fn().mockResolvedValue([
            { status: 'waiting' }, { status: 'in-consult' }, { status: 'completed' }
        ]) };
        const service = new QueueCountService(dataService as any);
        expect(service.count()).toBe(0);
        await service.refresh();
        expect(service.count()).toBe(2);
        expect(dataService.invoke).toHaveBeenCalledWith('getQueue');

        dataService.invoke.mockRejectedValue(new Error('locked'));
        await service.refresh();
        expect(service.count()).toBe(0);
    });

    it('derives the count from already-loaded rows without fetching', () => {
        const service = new QueueCountService({ invoke: vi.fn() } as any);
        service.updateFrom([{ status: 'waiting' }, { status: 'completed' }] as any);
        expect(service.count()).toBe(1);
    });
});
