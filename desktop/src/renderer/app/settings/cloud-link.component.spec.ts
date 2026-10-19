/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { CloudService } from '../services/cloud.service';
import { CloudLinkComponent, messageOf } from './cloud-link.component';

const status = (patch: Partial<CloudStatus> = {}): CloudStatus => ({ state: 'unpaired', configured: true, listingEnabled: false, ...patch });

describe('CloudLinkComponent', () => {
    let cloud: any;
    let component: CloudLinkComponent;

    beforeEach(() => {
        cloud = {
            getStatus: vi.fn(async () => status()),
            requestPairing: vi.fn(async () => status({ state: 'requested', hfrId: 'IN2710000123', keyFingerprint: 'ABCD-EFGH', requestExpiresAt: 1 })),
            activatePairing: vi.fn(async () => status({ state: 'paired', hfrId: 'IN2710000123', label: 'PC', pairedAt: 1 })),
            cancelPairing: vi.fn(async () => status()),
            forgetPairing: vi.fn(async () => status()),
            enableListing: vi.fn(async () => status({ state: 'paired', listingEnabled: true })),
            disableListing: vi.fn(async () => status({ state: 'paired' })),
            onPairingChanged: vi.fn(() => () => undefined),
            syncNow: vi.fn(async () => ({ success: true, paired: true, saved: 0 }))
        };
        component = new CloudLinkComponent(cloud as CloudService, { run: (fn: () => void) => fn() } as any);
    });

    it('walks an admin through request, code and pairing', async () => {
        component.isAdmin = true;
        await component.ngOnInit();
        expect(component.status?.state).toBe('unpaired');

        component.hfrId = ' in2710000123 ';
        component.label = ' Reception ';
        await component.request();
        expect(cloud.requestPairing).toHaveBeenCalledWith('IN2710000123', 'Reception');
        expect(component.status?.state).toBe('requested');

        component.code = 'abcd-1234';
        await component.activate();
        expect(cloud.activatePairing).toHaveBeenCalledWith('abcd-1234');
        expect(component.status?.state).toBe('paired');
        expect(component.code).toBe('');
    });

    it('shows the cloud\'s message and keeps the code when pairing fails', async () => {
        cloud.activatePairing.mockRejectedValueOnce(new Error("Error invoking remote method 'cloud:activatePairing': Error: That code is not right. 3 attempt(s) left."));
        component.code = 'ZZZZ-ZZZZ';
        await component.activate();
        expect(component.error).toBe('That code is not right. 3 attempt(s) left.');
        expect(component.code).toBe('ZZZZ-ZZZZ');
        expect(component.busy).toBe(false);
    });

    it('asks for listing details before turning online booking on, and turns it off directly', async () => {
        const checkbox = { checked: true } as HTMLInputElement;
        await component.toggleListing({ target: checkbox } as any);
        expect(component.showListingForm).toBe(true);
        expect(checkbox.checked).toBe(false);
        expect(cloud.enableListing).not.toHaveBeenCalled();

        component.listing = { name: ' Arogya ', city: 'Chennai', specialty: '' };
        await component.enableListing();
        expect(cloud.enableListing).toHaveBeenCalledWith({ name: 'Arogya', city: 'Chennai', specialty: undefined });
        expect(component.showListingForm).toBe(false);

        await component.toggleListing({ target: { checked: false } } as any);
        expect(cloud.disableListing).toHaveBeenCalled();
    });

    it('renders the request step with the key check staff will read back', async () => {
        TestBed.configureTestingModule({ imports: [CloudLinkComponent], providers: [{ provide: CloudService, useValue: cloud }] });
        cloud.getStatus.mockResolvedValue(status({ state: 'requested', hfrId: 'IN2710000123', keyFingerprint: 'ABCD-EFGH', requestExpiresAt: Date.now() }));
        const fixture = TestBed.createComponent(CloudLinkComponent);
        fixture.componentInstance.isAdmin = true;
        await fixture.componentInstance.ngOnInit();
        fixture.detectChanges();
        const text = fixture.nativeElement.textContent as string;
        expect(text).toContain('ABCD-EFGH');
        expect(text).toContain('Pairing code');
    });

    it('says whether messages arrive live and checks the mailbox on request', async () => {
        TestBed.configureTestingModule({ imports: [CloudLinkComponent], providers: [{ provide: CloudService, useValue: cloud }] });
        const paired = { state: 'paired' as const, hfrId: 'IN2710000123', label: 'PC', pairedAt: 1 };
        cloud.getStatus.mockResolvedValue(status({ ...paired, mailbox: { doorbell: 'connecting', lastCheckedAt: null } }));
        const fixture = TestBed.createComponent(CloudLinkComponent);
        await fixture.componentInstance.ngOnInit();
        fixture.detectChanges();
        expect(fixture.nativeElement.textContent).toContain('every 30 minutes');

        cloud.getStatus.mockResolvedValue(status({ ...paired, mailbox: { doorbell: 'live', lastCheckedAt: Date.now() } }));
        const button = [...fixture.nativeElement.querySelectorAll('button')].find((b: HTMLButtonElement) => b.textContent?.includes('Check now'));
        button.click();
        await vi.waitFor(() => expect(cloud.syncNow).toHaveBeenCalled());
        await fixture.whenStable();
        await vi.waitFor(() => {
            fixture.detectChanges();
            expect(fixture.nativeElement.textContent).toContain('arrive as they are sent');
        });
        expect(fixture.nativeElement.textContent).toContain('Last checked');
    });

    it('tells non-admins they cannot change pairing', async () => {
        TestBed.configureTestingModule({ imports: [CloudLinkComponent], providers: [{ provide: CloudService, useValue: cloud }] });
        const fixture = TestBed.createComponent(CloudLinkComponent);
        await fixture.componentInstance.ngOnInit();
        fixture.detectChanges();
        expect(fixture.nativeElement.textContent).toContain('Only an admin can change cloud pairing.');
        expect(fixture.nativeElement.querySelector('#cloud-hfr')).toBeNull();
    });

    it('strips the IPC wrapper from main\'s errors', () => {
        expect(messageOf(new Error("Error invoking remote method 'cloud:x': Error: Forbidden"))).toBe('Forbidden');
        expect(messageOf('plain')).toBe('plain');
    });
});
