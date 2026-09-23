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

    it('reflects the live queue size in the sidebar badge', async () => {
        const mockDataService = { invoke: vi.fn().mockResolvedValue([
            { status: 'waiting' }, { status: 'in-consult' }, { status: 'completed' }
        ]) };
        const layout = new MainLayoutComponent(
            mockRouter,
            mockDialogService,
            mockAuthService,
            mockNgZone,
            mockRuntimeService,
            undefined,
            mockDataService as any
        );
        await layout.refreshQueueCount();
        expect(layout.queueCount).toBe(2);
        layout.ngOnDestroy();
    });

    it('resets the badge when the queue cannot load', async () => {
        const mockDataService = { invoke: vi.fn().mockRejectedValue(new Error('locked')) };
        const layout = new MainLayoutComponent(
            mockRouter,
            mockDialogService,
            mockAuthService,
            mockNgZone,
            mockRuntimeService,
            undefined,
            mockDataService as any
        );
        layout.queueCount = 5;
        await layout.refreshQueueCount();
        expect(layout.queueCount).toBe(0);
        layout.ngOnDestroy();
    });
});
