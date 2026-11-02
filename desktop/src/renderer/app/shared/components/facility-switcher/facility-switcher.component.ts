import { Component, Input, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FacilityService, roleLabel } from '../../../services/facility.service';
import { DialogService } from '../../services/dialog.service';

/** Starts the app again on the dashboard, so every view reloads in the new facility. */
export function reloadIntoDashboard(): void {
  const url = new URL(window.location.href);
  url.hash = '#/dashboard';
  window.location.replace(url.toString());
  window.location.reload();
}

/**
 * Facility switcher in the shell header (#214). Hidden when the user works
 * at one facility only. Switching reloads the facility-scoped views.
 */
@Component({
  selector: 'app-facility-switcher',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div *ngIf="facilities.canSwitch()" class="flex items-center gap-2" data-testid="facility-switcher">
      <label for="facility-switcher-select" class="sr-only">Facility</label>
      <select id="facility-switcher-select"
              class="select select-bordered select-sm max-w-[16rem] font-medium text-gray-800"
              [disabled]="busy"
              [value]="facilities.currentId()"
              (change)="onChange($event)">
        <option *ngFor="let f of facilities.facilities()" [value]="f.id" [selected]="f.id === facilities.currentId()">
          {{ f.name || f.code }}{{ f.kind === 'hospital' ? ' (hospital)' : '' }} · {{ label(f.role) }}
        </option>
      </select>
    </div>
  `
})
export class FacilitySwitcherComponent implements OnInit {
  readonly facilities = inject(FacilityService);
  private readonly dialog = inject(DialogService);
  /** Replaced in tests. */
  @Input() reload: () => void = reloadIntoDashboard;
  busy = false;

  ngOnInit(): void {
    if (this.facilities.facilities().length === 0) void this.facilities.load();
  }

  label(role: string): string {
    return roleLabel(role);
  }

  async onChange(event: Event): Promise<void> {
    const select = event.target as HTMLSelectElement;
    const id = Number(select.value);
    if (!id || id === this.facilities.currentId()) return;
    this.busy = true;
    const result = await this.facilities.switchTo(id);
    this.busy = false;
    if (result.ok) {
      this.reload();
      return;
    }
    select.value = String(this.facilities.currentId());
    void this.facilities.load();
    void this.dialog.open({
      title: 'Could not switch facility',
      message: 'You may no longer have access to that facility. The list has been refreshed.',
      type: 'error'
    });
  }
}
