import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SharedTableComponent } from './table.component';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Component, Input, ElementRef, NgZone } from '@angular/core';
import { AgGridAngular } from 'ag-grid-angular';

// Mock AgGridAngular
@Component({
    selector: 'ag-grid-angular',
    template: '<div></div>',
    standalone: true
})
class MockAgGridAngular {
    @Input() rowData: any;
    @Input() columnDefs: any;
    @Input() defaultColDef: any;
    @Input() getRowId: any;
    @Input() theme: any;
    @Input() paginationPageSize: any;
    @Input() paginationPageSizeSelector: any;
    @Input() rowSelection: any;
    @Input() rowHeight: any;
    @Input() overlayNoRowsTemplate: any;
    @Input() animateRows: any;
}

// Mock ResizeObserver
global.ResizeObserver = class ResizeObserver {
    observe() { }
    unobserve() { }
    disconnect() { }
};

describe('SharedTableComponent', () => {
    let component: SharedTableComponent;
    let fixture: ComponentFixture<SharedTableComponent>;

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [SharedTableComponent],
        })
            .overrideComponent(SharedTableComponent, {
                remove: { imports: [AgGridAngular] },
                add: { imports: [MockAgGridAngular] }
            })
            .compileComponents();

        fixture = TestBed.createComponent(SharedTableComponent);
        component = fixture.componentInstance;
        fixture.detectChanges();
    });

    it('should create', () => {
        expect(component).toBeTruthy();
    });

    it('should have correct default column definitions for wrapping', () => {
        const defaults = component.defaultColDef;
        expect(defaults.wrapText).toBe(true);
        expect(defaults.autoHeight).toBe(true);
        expect(defaults.wrapHeaderText).toBe(false);
        expect(defaults.autoHeaderHeight).toBe(false);
        expect(defaults.minWidth).toBe(150);
    });

    it('should accept multiSelect input', () => {
        component.multiSelect = true;
        expect(component.multiSelect).toBe(true);
    });

    it('renders a checkbox column for multi-select and none for single', () => {
        expect(component.selectionOptions).toMatchObject({ mode: 'singleRow', checkboxes: false });
        component.multiSelect = true;
        component.ngOnChanges({ multiSelect: {} } as any);
        expect(component.selectionOptions).toMatchObject({ mode: 'multiRow', checkboxes: true, headerCheckbox: true, selectAll: 'filtered' });
    });

    it('keys grid rows by record id', () => {
        expect(component.getRowId({ data: { id: 42 } })).toBe('42');
    });

    it('exposes a visible horizontal overflow cue so trailing columns are not clipped', () => {
        const gridWrap = fixture.nativeElement.querySelector('.flex-1.w-full');
        expect(gridWrap.className).toContain('overflow-x-auto');
    });
});
