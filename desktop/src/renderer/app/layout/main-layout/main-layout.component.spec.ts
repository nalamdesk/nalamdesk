import { MainLayoutComponent } from './main-layout.component';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Subject } from 'rxjs';
import { NavigationStart, NavigationEnd } from '@angular/router';

describe('MainLayoutComponent', () => {
    let component: MainLayoutComponent;
    let mockAuthService: any;
    let mockRouter: any;
    let mockDialogService: any;
    let mockNgZone: any;
    let mockRuntimeService: any;

    beforeEach(() => {
        mockAuthService = {
            logout: vi.fn().mockResolvedValue(undefined),
            getUser: vi.fn().mockReturnValue({ name: 'Dr. Test', role: 'doctor' })
        };

        mockRouter = {
            navigate: vi.fn(),
            url: '/dashboard',
            events: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) }
        };

        mockDialogService = {
            options: vi.fn().mockReturnValue({ type: 'info' }), // Signal mock is a function
            isOpen: vi.fn().mockReturnValue(false),
            close: vi.fn(),
            confirm: vi.fn()
        };

        mockNgZone = { run: vi.fn((fn) => fn()) };
        mockRuntimeService = {
            init: vi.fn().mockResolvedValue(undefined),
            lanAccessUrl: '',
        };

        component = new MainLayoutComponent(
            mockRouter,
            mockDialogService,
            mockAuthService,
            mockNgZone,
            mockRuntimeService
        );
    });

    it('should create', () => {
        expect(component).toBeTruthy();
    });

    it('should have user details', () => {
        expect(component.currentUser.name).toBe('Dr. Test');
    });

    it('should close drawer if open', () => {
        // Mock ElementRef for drawerCheckbox
        const mockCheckbox = {
            nativeElement: { checked: true }
        };
        component.drawerCheckbox = mockCheckbox as any;

        component.closeDrawer();

        expect(mockCheckbox.nativeElement.checked).toBe(false);
    });

    it('should logout', async () => {
        await component.logout();
        expect(mockAuthService.logout).toHaveBeenCalled();
        expect(mockRouter.navigate).not.toHaveBeenCalled();
    });

    it('swallows logout rejection without navigating or clearing session', async () => {
        mockAuthService.logout.mockRejectedValue(new Error('IPC Error'));
        localStorage.setItem('nalamdesk_user', JSON.stringify({ id: 1, name: 'Dr. Test' }));
        localStorage.setItem('nalamdesk_token', 'test-token');
        await expect(component.logout()).resolves.toBeUndefined();
        expect(mockAuthService.logout).toHaveBeenCalled();
        expect(mockRouter.navigate).not.toHaveBeenCalled();
        expect(localStorage.getItem('nalamdesk_user')).toBeTruthy();
        expect(localStorage.getItem('nalamdesk_token')).toBe('test-token');
    });

    it('clears the shell error when a child route starts', () => {
        const events = new Subject();
        mockRouter.events = events;
        const layout = new MainLayoutComponent(
            mockRouter,
            mockDialogService,
            mockAuthService,
            mockNgZone,
            mockRuntimeService
        );
        layout.ngOnInit();
        events.next(new NavigationStart(1, '/visits'));
        expect(mockDialogService.close).toHaveBeenCalled();
        mockDialogService.close.mockClear();
        events.next(new NavigationEnd(1, '/visits', '/visits'));
        expect(mockDialogService.close).not.toHaveBeenCalled();
        layout.ngOnDestroy();
    });

    it('reflects the live queue count from the badge service', async () => {
        const mockCount = { count: () => 3, refresh: vi.fn().mockResolvedValue(undefined) };
        const layout = new MainLayoutComponent(
            mockRouter,
            mockDialogService,
            mockAuthService,
            mockNgZone,
            mockRuntimeService,
            undefined,
            undefined,
            mockCount as any
        );
        expect(layout.queueCount).toBe(3);
        layout.ngOnInit();
        expect(mockCount.refresh).toHaveBeenCalled();
        layout.ngOnDestroy();
    });

    it('shows zero badge without the service', () => {
        expect(component.queueCount).toBe(0);
    });

    it('relaunches the product tour from the user menu', () => {
        const tours = { start: vi.fn() };
        const layout = new MainLayoutComponent(
            mockRouter,
            mockDialogService,
            mockAuthService,
            mockNgZone,
            mockRuntimeService,
            tours as any
        );
        layout.retakeTour();
        expect(tours.start).toHaveBeenCalledWith('doctor');
    });

    it('records the attending reason typed in the picker', () => {
        const pick = { reasonInput: { set: vi.fn() }, reasonError: { set: vi.fn() } };
        const layout = new MainLayoutComponent(
            mockRouter,
            mockDialogService,
            mockAuthService,
            mockNgZone,
            mockRuntimeService,
            undefined,
            pick as any
        );
        layout.onAttendingReasonInput({ target: { value: 'Covering night shift' } } as any);
        expect(pick.reasonInput.set).toHaveBeenCalledWith('Covering night shift');
        expect(pick.reasonError.set).toHaveBeenCalledWith(false);
    });

    it('returns zero queue count when the badge service throws', () => {
        const bad = { count: () => { throw new Error('down'); }, refresh: vi.fn() };
        const layout = new MainLayoutComponent(
            mockRouter, mockDialogService, mockAuthService, mockNgZone,
            mockRuntimeService, undefined, undefined, bad as any
        );
        expect(layout.queueCount).toBe(0);
    });

    it('initializes runtime and refreshes on navigation end', async () => {
        const events = new Subject();
        mockRouter.events = events;
        (globalThis as any).electron = {};
        const runtime = { init: vi.fn(async () => undefined), lanAccessUrl: '' };
        const count = { count: () => 0, refresh: vi.fn(async () => undefined) };
        const layout = new MainLayoutComponent(
            mockRouter, mockDialogService, mockAuthService, mockNgZone,
            runtime as any, undefined, undefined, count as any
        );
        layout.ngOnInit();
        expect(runtime.init).toHaveBeenCalled();
        events.next(new NavigationEnd(1, '/queue', '/queue'));
        await Promise.resolve();
        expect(count.refresh).toHaveBeenCalledTimes(2);
        layout.ngOnDestroy();
        delete (globalThis as any).electron;
    });

    it('copies the LAN URL through electron IPC or the web clipboard', async () => {
        mockRuntimeService.lanAccessUrl = 'http://192.168.1.10:3002';
        const writeText = vi.fn(async () => undefined);
        (globalThis as any).electron = { clipboard: { writeText } };
        component.copyIp();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledWith('http://192.168.1.10:3002');
        expect(component.isCopied).toBe(true);
        delete (globalThis as any).electron;

        const webWrite = vi.fn(async () => undefined);
        (navigator as any).clipboard = { writeText: webWrite };
        component.isCopied = false;
        component.copyIp();
        await Promise.resolve();
        expect(webWrite).toHaveBeenCalled();
        delete (navigator as any).clipboard;

        mockRuntimeService.lanAccessUrl = '';
        component.copyIp();
    });

    it('logs web clipboard failures', async () => {
        mockRuntimeService.lanAccessUrl = 'http://x:3002';
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        (navigator as any).clipboard = { writeText: vi.fn(async () => { throw new Error('denied'); }) };
        delete (globalThis as any).electron;
        component.copyIp();
        await new Promise((r) => setTimeout(r, 0));
        expect(error).toHaveBeenCalledWith('Copy failed:', expect.any(Error));
        delete (navigator as any).clipboard;
        mockRuntimeService.lanAccessUrl = '';
    });

    it('derives route names and user initials', () => {
        mockRouter.url = '/';
        expect(component.currentRouteName).toBe('Dashboard');
        mockRouter.url = '/patients';
        expect(component.currentRouteName).toBe('Patients');

        component.currentUser = null;
        expect(component.getUserInitials()).toBe('U');
        component.currentUser = { name: 'Amy' };
        expect(component.getUserInitials()).toBe('AM');
        component.currentUser = { name: 'Amy Pond' };
        expect(component.getUserInitials()).toBe('AP');
    });

    it('tolerates a missing drawer checkbox on close', () => {
        component.drawerCheckbox = undefined as any;
        expect(() => component.closeDrawer()).not.toThrow();
    });
});
