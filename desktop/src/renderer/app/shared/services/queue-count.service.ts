import { Injectable, signal } from '@angular/core';
import { DataService } from '../../services/api.service';

/**
 * Live sidebar queue badge. Layout binds to `count`; queue mutations call
 * `refresh()` (or `updateFrom()` when rows are already in hand) so the
 * badge never waits for a navigation to catch up.
 */
@Injectable({
    providedIn: 'root'
})
export class QueueCountService {
    private readonly _count = signal(0);
    readonly count = this._count.asReadonly();

    constructor(private dataService: DataService) { }

    async refresh(): Promise<void> {
        try {
            const queue = await this.dataService.invoke<any[]>('getQueue');
            this.updateFrom(queue || []);
        } catch {
            this._count.set(0);
        }
    }

    updateFrom(rows: any[]): void {
        this._count.set((rows || []).filter((q: any) => q?.status !== 'completed').length);
    }
}
