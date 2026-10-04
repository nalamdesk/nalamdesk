
import { Injectable, signal } from '@angular/core';
import {
    StandardsMode,
    displayFrequency,
    displayTemperature,
    displayWeight,
    exportTarget,
    isStandardsMode,
    primaryIdentifierLabel
} from '../../../shared/practice-profile';
import { DataService } from './api.service';

/**
 * Reactive practice-standards lens (issue #51). Components read display
 * helpers off the current mode signal; switching in Settings updates all
 * subscribers without a reload. Canonical storage is never touched here.
 */
@Injectable({
    providedIn: 'root'
})
export class PracticeProfileService {
    readonly mode = signal<StandardsMode>('india_abdm');

    constructor(private dataService: DataService | null = null) { }

    async load(): Promise<void> {
        if (!this.dataService) return;
        try {
            const settings = await this.dataService.invoke<any>('getPublicSettings');
            const stored = settings?.standards_mode;
            if (isStandardsMode(stored)) this.mode.set(stored);
        } catch {
            // Offline or pre-migration: stay on the default lens.
        }
    }

    async setMode(next: StandardsMode): Promise<void> {
        if (!isStandardsMode(next)) throw new Error('Unknown standards mode.');
        if (this.dataService) {
            await this.dataService.invoke('saveSettings', { standards_mode: next });
        }
        this.mode.set(next);
    }

    frequency(canonical: string): string {
        return displayFrequency(canonical, this.mode());
    }

    temperature(celsius: number): { value: number; unit: string } {
        return displayTemperature(celsius, this.mode());
    }

    weight(kg: number, imperial = false): { value: number; unit: string } {
        return displayWeight(kg, this.mode(), imperial);
    }

    identifierLabel(): string {
        return primaryIdentifierLabel(this.mode());
    }

    exportLabel(): string {
        return exportTarget(this.mode());
    }
}
