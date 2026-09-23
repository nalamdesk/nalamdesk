import { Injectable, signal } from '@angular/core';

export type ToastType = 'success' | 'info' | 'warning' | 'error';

export interface Toast {
    id: number;
    message: string;
    title?: string;
    type: ToastType;
}

/**
 * Fire-and-forget confirmations ("Checked in!", "Availability updated").
 * For anything needing a decision or carrying an error, use DialogService.
 */
@Injectable({
    providedIn: 'root'
})
export class ToastService {
    private readonly _toasts = signal<Toast[]>([]);
    readonly toasts = this._toasts.asReadonly();
    private nextId = 1;

    show(message: string, type: ToastType = 'success', title?: string, durationMs = 3500): number {
        const id = this.nextId++;
        this._toasts.update(list => [...list, { id, message, title, type }]);
        setTimeout(() => this.dismiss(id), durationMs);
        return id;
    }

    success(message: string, title?: string): number {
        return this.show(message, 'success', title);
    }

    info(message: string, title?: string): number {
        return this.show(message, 'info', title);
    }

    warning(message: string, title?: string): number {
        return this.show(message, 'warning', title);
    }

    error(message: string, title?: string): number {
        return this.show(message, 'error', title);
    }

    dismiss(id: number): void {
        this._toasts.update(list => list.filter(t => t.id !== id));
    }
}
