/**
 * @vitest-environment jsdom
 */
import '@angular/compiler';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DatePickerComponent } from './date-picker.component';
import { ElementRef } from '@angular/core';

describe('DatePickerComponent', () => {
    let component: DatePickerComponent;
    let mockElementRef: any;

    beforeEach(() => {
        mockElementRef = {
            nativeElement: {
                contains: vi.fn(),
                isConnected: true,
                getBoundingClientRect: vi.fn().mockReturnValue({ bottom: 100, height: 50, top: 50, left: 0, right: 100, width: 100 })
            }
        };
        component = new DatePickerComponent(mockElementRef);
        // Simulate ngOnInit
        component.ngOnInit();
    });

    it('should create', () => {
        expect(component).toBeTruthy();
    });

    it('should generate years based on min/max date', () => {
        const currentYear = new Date().getFullYear();
        // Default: currentYear to currentYear - 110
        expect(component.years.length).toBeGreaterThan(100);
        expect(component.years[0]).toBe(currentYear);
    });

    it('should select year and move to MONTH view', () => {
        component.selectYear(2000);
        expect(component.selectedYear).toBe(2000);
        expect(component.view).toBe('MONTH');
    });

    it('should select month and move to DAY view', () => {
        component.selectedYear = 2000;
        component.selectMonth(0); // Jan
        expect(component.selectedMonth).toBe(0);
        expect(component.view).toBe('DAY');
        expect(component.daysInMonth.length).toBe(31);
    });

    it('should select day and update value', () => {
        const onChangeSpy = vi.fn();
        component.registerOnChange(onChangeSpy);

        component.selectedYear = 2000;
        component.selectedMonth = 0; // Jan
        component.selectDay(15);

        expect(component.value).toBe('2000-01-15');
        expect(onChangeSpy).toHaveBeenCalledWith('2000-01-15');
        expect(component.isOpen).toBe(false);
    });

    it('should parse manual input (DDMMYYYY)', () => {
        const inputEvent = { target: { value: '25122000' } } as any;
        const onChangeSpy = vi.fn();
        component.registerOnChange(onChangeSpy);

        component.onInput(inputEvent);

        expect(component.value).toBe('2000-12-25');
        expect(onChangeSpy).toHaveBeenCalledWith('2000-12-25');
    });

    it('should parse manual input (DD/MM/YYYY)', () => {
        const inputEvent = { target: { value: '25/12/2000' } } as any;
        const onChangeSpy = vi.fn();
        component.registerOnChange(onChangeSpy);

        component.onInput(inputEvent);

        expect(component.value).toBe('2000-12-25');
    });

    it('should not update value for invalid date', () => {
        const inputEvent = { target: { value: '99999999' } } as any; // Invalid month/day
        const onChangeSpy = vi.fn();
        component.registerOnChange(onChangeSpy);

        component.onInput(inputEvent);

        expect(onChangeSpy).not.toHaveBeenCalled();
    });

    it('should respect minDate validation', () => {
        component.minDate = '2020-01-01';
        component.selectedYear = 2019;
        component.selectedMonth = 0;

        // 2019-01-01 is before 2020-01-01
        expect(component.isDateDisabled(1)).toBe(true);
    });

    it('should handle global click (close if outside)', () => {
        component.isOpen = true;
        const div = document.createElement('div');
        // Mock isConnected
        Object.defineProperty(div, 'isConnected', { value: true });

        const event = { target: div } as any;
        mockElementRef.nativeElement.contains.mockReturnValue(false);

        component.onGlobalClick(event);

        expect(component.isOpen).toBe(false);
    });

    it('should handle global click (stay open if inside)', () => {
        component.isOpen = true;
        const div = document.createElement('div');
        // Mock isConnected
        Object.defineProperty(div, 'isConnected', { value: true });

        const event = { target: div } as any;
        mockElementRef.nativeElement.contains.mockReturnValue(true);

        component.onGlobalClick(event);

        expect(component.isOpen).toBe(true);
    });

    it('should bound the year list by min/max dates', () => {
        component.minDate = '1990-06-01';
        component.maxDate = '2000-01-01';
        component.generateYears();
        expect(component.years[0]).toBe(2000);
        expect(component.years[component.years.length - 1]).toBe(1990);
    });

    it('should write values and preselect year/month', () => {
        component.writeValue('2001-02-03');
        expect(component.value).toBe('2001-02-03');
        expect(component.displayValue).toBe('03/02/2001');
        expect(component.selectedYear).toBe(2001);
        expect(component.selectedMonth).toBe(1);

        component.writeValue(null as any);
        expect(component.displayValue).toBe('');
    });

    it('should toggle the picker open above or below the field', () => {
        const touched = vi.fn();
        component.registerOnTouched(touched);
        mockElementRef.nativeElement.getBoundingClientRect.mockReturnValue(
            { bottom: 700, height: 50, top: 650, left: 10, right: 100, width: 90 });
        (window as any).innerHeight = 800;
        component.togglePicker();
        expect(component.isOpen).toBe(true);
        expect(component.top).toBe(650 - 350 - 5);
        expect(touched).toHaveBeenCalled();

        component.togglePicker();
        expect(component.isOpen).toBe(false);

        component.value = '2001-02-03';
        component.togglePicker();
        expect(component.view).toBe('DAY');
        expect(component.daysInMonth.length).toBe(28);

        component.value = null as any;
        component.isOpen = false;
        component.togglePicker();
        expect(component.view).toBe('YEAR');

        component.close();
        expect(component.isOpen).toBe(false);
    });

    it('should guard day selection without a year/month', () => {
        const onChange = vi.fn();
        component.registerOnChange(onChange);
        component.selectedYear = null;
        component.selectDay(5);
        expect(onChange).not.toHaveBeenCalled();
    });

    it('should title every view and name months', () => {
        component.view = 'YEAR';
        expect(component.getTitle()).toBe('Select Year');
        component.view = 'MONTH';
        component.selectedYear = 2001;
        expect(component.getTitle()).toBe('2001');
        component.view = 'DAY';
        component.selectedMonth = 0;
        expect(component.getTitle()).toBe('Jan 2001');
        expect(component.getMonthName()).toBe('Jan');
        component.selectedMonth = null;
        expect(component.getMonthName()).toBe('');

        component.view = 'DAY';
        component.goBack();
        expect(component.view).toBe('MONTH');
        component.goBack();
        expect(component.view).toBe('YEAR');
        component.goBack();
        expect(component.view).toBe('YEAR');
    });

    it('should generate February days including leap years', () => {
        component.selectedYear = 2000;
        component.selectedMonth = 1;
        component.generateDays();
        expect(component.daysInMonth.length).toBe(29);
        component.selectedYear = 2001;
        component.generateDays();
        expect(component.daysInMonth.length).toBe(28);

        component.selectedYear = null;
        component.daysInMonth = [1];
        component.generateDays();
        expect(component.daysInMonth).toEqual([1]);
    });

    it('should match selected dates and bound by max date', () => {
        component.value = '2001-02-03';
        component.selectedYear = 2001;
        component.selectedMonth = 1;
        expect(component.isSameDate(3)).toBe(true);
        expect(component.isSameDate(4)).toBe(false);
        component.value = null;
        expect(component.isSameDate(3)).toBe(false);

        component.selectedYear = 2001;
        component.selectedMonth = 5;
        expect(component.isDateDisabled(1)).toBe(false);
        component.maxDate = '2001-06-01';
        expect(component.isDateDisabled(2)).toBe(true);
        expect(component.isDateDisabled(1)).toBe(false);
        component.selectedMonth = null;
        expect(component.isDateDisabled(1)).toBe(false);
    });

    it('should clear the field and notify', () => {
        const onChange = vi.fn();
        component.registerOnChange(onChange);
        component.value = '2001-02-03';
        const stop = vi.fn();
        component.clear({ stopPropagation: stop } as any);
        expect(component.value).toBeNull();
        expect(component.displayValue).toBe('');
        expect(onChange).toHaveBeenCalledWith(null);
        expect(stop).toHaveBeenCalled();
    });

    it('should parse YYYY/MM/DD input and ignore garbage', () => {
        const onChange = vi.fn();
        component.registerOnChange(onChange);
        component.onInput({ target: { value: '2001/02/03' } } as any);
        expect(component.value).toBe('2001-02-03');
        expect(component.isOpen).toBe(true);

        component.value = null;
        component.onInput({ target: { value: 'hello' } } as any);
        expect(component.value).toBeNull();
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('should reject disabled dates from manual input', () => {
        component.minDate = '2001-02-03';
        const onChange = vi.fn();
        component.registerOnChange(onChange);
        component.onInput({ target: { value: '01/02/2001' } } as any);
        expect(onChange).not.toHaveBeenCalled();
    });

    it('should ignore global clicks and scrolls when closed', () => {
        component.isOpen = false;
        const div = document.createElement('div');
        Object.defineProperty(div, 'isConnected', { value: true });
        mockElementRef.nativeElement.contains.mockReturnValue(false);
        component.onGlobalClick({ target: div } as any);
        component.onWindowScroll();
        component.onWindowResize();
        expect(component.isOpen).toBe(false);
    });

    it('should ignore detached global click targets', () => {
        component.isOpen = true;
        const div = document.createElement('div');
        Object.defineProperty(div, 'isConnected', { value: false });
        mockElementRef.nativeElement.contains.mockReturnValue(false);
        component.onGlobalClick({ target: div } as any);
        expect(component.isOpen).toBe(true);
    });

    it('should close the open picker on scroll and resize', () => {
        component.isOpen = true;
        component.onWindowScroll();
        expect(component.isOpen).toBe(false);
        component.isOpen = true;
        component.onWindowResize();
        expect(component.isOpen).toBe(false);
    });
});
