import { Component, EventEmitter, Input, Output, ElementRef, OnChanges, SimpleChanges, ContentChild, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-universal-dialog',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div *ngIf="isOpen" class="fixed inset-0 z-[300] flex items-center justify-center overflow-y-auto overflow-x-hidden p-4 sm:p-6"
         role="dialog" aria-modal="true" aria-labelledby="modal-title">
      
      <!-- Backdrop -->
      <div class="fixed inset-0 bg-black/50 transition-opacity duration-200" 
           (click)="onBackdropClick()"
           [class.opacity-0]="!animateIn"
           [class.opacity-100]="animateIn"></div>

      <!-- Dialog Panel -->
      <div class="relative w-full transform rounded-lg bg-white p-6 text-left shadow-xl border border-gray-200 transition-all duration-200 sm:my-8 sm:w-full sm:max-w-lg"
           [class.opacity-0]="!animateIn"
           [class.opacity-100]="animateIn">
           
        <!-- Close Button (Absolute Top Right) -->
        <button type="button" 
                class="absolute right-4 top-4 rounded-full p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors focus:outline-none"
                (click)="close()">
          <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <!-- Header / Icon -->
        <div class="mb-5 flex flex-col items-center sm:flex-row sm:items-start">
           <div *ngIf="icon" class="mx-auto flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full sm:mx-0 sm:h-10 sm:w-10 mb-4 sm:mb-0" [ngClass]="iconBgClass">
             <!-- Icon Projection or generic icon -->
             <ng-content select="[icon]"></ng-content>
             <svg *ngIf="!hasIconContent" class="h-6 w-6" [ngClass]="iconTextClass" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
               <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
             </svg>
           </div>
           
           <div class="mt-3 text-center sm:ml-4 sm:mt-0 sm:text-left w-full">
             <h3 class="text-xl font-bold leading-6 text-gray-900" id="modal-title">
               {{ title }}
             </h3>
             <div class="mt-2">
               <p class="text-sm text-gray-600">
                 <ng-content select="[body]"></ng-content>
                 {{ message }}
               </p>
               <!-- Default Content Area if no selector used -->
               <ng-content></ng-content> 
             </div>
           </div>
        </div>

        <!-- Actions -->
        <div class="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
           <ng-content select="[actions]"></ng-content>
           <!-- Default Close Action if enabled -->
           <button *ngIf="showDefaultActions && !hasActionsContent" type="button" 
                   class="bg-blue-600 text-white px-4 py-2 rounded font-medium hover:bg-blue-700 w-full sm:w-auto shadow-sm"
                   data-testid="default-ok"
                   (click)="close()">
             OK
           </button>
        </div>
        
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
  `]
})
export class UniversalDialogComponent implements OnChanges, OnDestroy {
  @Input() title: string = 'Notification';
  @Input() message: string = '';
  @Input() isOpen: boolean = false;
  @Input() icon: boolean = true;
  @Input() type: 'info' | 'success' | 'warning' | 'error' | 'confirm' = 'info';
  @Input() showDefaultActions = true;

  @Output() isOpenChange = new EventEmitter<boolean>();
  @Output() confirmDialog = new EventEmitter<void>();
  @Output() cancelDialog = new EventEmitter<void>();

  animateIn = false;

  // Template refs (#icon / #actions). CSS `[actions]` is not a ContentChild query.
  @ContentChild('icon', { read: ElementRef }) iconContent: ElementRef | undefined;
  @ContentChild('actions', { read: ElementRef }) actionsContent: ElementRef | undefined;

  private animateInTimerId: ReturnType<typeof setTimeout> | null = null;

  get hasIconContent(): boolean {
    return !!this.iconContent;
  }

  get hasActionsContent(): boolean {
    return !!this.actionsContent;
  }

  get iconBgClass(): string {
    switch (this.type) {
      case 'error': return 'bg-red-50';
      case 'warning': return 'bg-amber-50';
      case 'success': return 'bg-green-50';
      default: return 'bg-blue-50';
    }
  }

  get iconTextClass(): string {
    switch (this.type) {
      case 'error': return 'text-red-600';
      case 'warning': return 'text-amber-600';
      case 'success': return 'text-green-700';
      default: return 'text-blue-600';
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isOpen']) {
      if (this.animateInTimerId) {
        clearTimeout(this.animateInTimerId);
        this.animateInTimerId = null;
      }

      if (this.isOpen) {
        document.body.style.overflow = 'hidden';
        this.animateInTimerId = setTimeout(() => this.animateIn = true, 10);
      } else {
        document.body.style.overflow = '';
        this.animateIn = false;
      }
    }
  }

  ngOnDestroy(): void {
    document.body.style.overflow = '';
    if (this.animateInTimerId) {
      clearTimeout(this.animateInTimerId);
      this.animateInTimerId = null;
    }
  }

  close() {
    this.animateIn = false;
    this.isOpenChange.emit(false);
    this.cancelDialog.emit();
  }

  onBackdropClick() {
    this.close();
  }

  onConfirm() {
    this.confirmDialog.emit();
    this.close();
  }
}
