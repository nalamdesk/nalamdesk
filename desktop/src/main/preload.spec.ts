import { beforeAll, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
    exposeInMainWorld: vi.fn(),
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn()
}));

vi.mock('electron', () => ({
    contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
    ipcRenderer: { invoke: electron.invoke, on: electron.on, removeListener: electron.removeListener }
}));


describe('preload bridge surface', () => {
    let api: any;

    beforeAll(async () => {
        await import('./preload');
        expect(electron.exposeInMainWorld).toHaveBeenCalledOnce();
        api = electron.exposeInMainWorld.mock.calls[0][1];
    });

    it('exposes logout and packaged version IPC without a filesystem bridge', async () => {
        expect(api.logout).toEqual(expect.any(Function));
        expect(api.getAppVersion).toEqual(expect.any(Function));
        await api.logout();
        await api.getAppVersion();
        expect(electron.invoke).toHaveBeenCalledWith('auth:logout');
        expect(electron.invoke).toHaveBeenCalledWith('app:getVersion');
    });

    it('exposes picker-based backup restore without raw filesystem access', async () => {
        expect(api.fs).toBeUndefined();
        expect(api.backup.readFile).toBeUndefined();
        await api.backup.selectRestoreBundle();
        expect(electron.invoke).toHaveBeenCalledWith('backup:selectRestoreBundle');
    });

    it('exposes local backup health IPC', async () => {
        await api.backup.getLocalBackupHealth();
        expect(electron.invoke).toHaveBeenCalledWith('backup:getLocalBackupHealth');
    });

    it('sends queue writes with the renderer object payload Electron IPC unpacks', async () => {
        await api.db.addToQueue({ patientId: 42, priority: 2 });
        await api.db.updateQueueStatus({ id: 9, status: 'waiting' });
        await api.db.removeFromQueue(9);
        expect(electron.invoke).toHaveBeenCalledWith('db:addToQueue', { patientId: 42, priority: 2 });
        expect(electron.invoke).toHaveBeenCalledWith('db:updateQueueStatus', { id: 9, status: 'waiting' });
        expect(electron.invoke).toHaveBeenCalledWith('db:removeFromQueue', 9);
    });

    it('exposes catalog search/create and updates IPC', async () => {
        await api.db.searchConditions('flu');
        await api.db.searchMedicines('para');
        await api.db.createCondition({ name: 'URI' });
        await api.db.createMedicine({ name: 'Paracetamol' });
        await api.db.getConditionMedPresets(4);
        await api.db.listConditions(true);
        await api.db.listMedicines(false);
        await api.db.updateCondition({ id: 1, name: 'URI' });
        await api.db.updateMedicine({ id: 2, name: 'Paracetamol' });
        await api.db.retireCondition(1);
        await api.db.retireMedicine(2);
        await api.db.replaceConditionMedPresets({ conditionId: 1, lines: [] });
        await api.updates.check({ source: 'manual' });
        await api.updates.download();
        await api.updates.install();
        await api.updates.cancel();
        await api.updates.getStatus();
        const off = api.updates.onEvent(() => undefined);
        off();
        expect(electron.invoke).toHaveBeenCalledWith('db:searchConditions', 'flu', undefined);
        expect(electron.invoke).toHaveBeenCalledWith('db:createMedicine', { name: 'Paracetamol' });
        expect(electron.invoke).toHaveBeenCalledWith('updates:check', { source: 'manual' });
        expect(electron.invoke).toHaveBeenCalledWith('updates:download');
        expect(electron.on).toHaveBeenCalledWith('updates:event', expect.any(Function));
    });

    it('exposes cloud slot publish IPC alongside slot reads', async () => {
        await api.cloud.publishSlots([{ date: '2026-10-04', time: '10:00' }], ['2026-10-04']);
        await api.cloud.getPublishedSlots('2026-10-04');
        expect(electron.invoke).toHaveBeenCalledWith(
            'cloud:publishSlots', [{ date: '2026-10-04', time: '10:00' }], ['2026-10-04']);
        expect(electron.invoke).toHaveBeenCalledWith('cloud:getPublishedSlots', '2026-10-04');
    });

    it('exposes pairing and booking decision IPC, and no app-secret onboarding', async () => {
        await api.cloud.requestPairing({ hfrId: 'IN2710000123', label: 'Reception' });
        await api.cloud.activatePairing({ code: 'ABCD-1234' });
        await api.cloud.cancelPairing();
        await api.cloud.decide({ ref: 'ABCDEFGHJKMN', decision: 'accepted' });
        const off = api.cloud.onPairingChanged(() => undefined);
        off();
        expect(electron.invoke).toHaveBeenCalledWith('cloud:requestPairing', { hfrId: 'IN2710000123', label: 'Reception' });
        expect(electron.invoke).toHaveBeenCalledWith('cloud:activatePairing', { code: 'ABCD-1234' });
        expect(electron.invoke).toHaveBeenCalledWith('cloud:cancelPairing');
        expect(electron.invoke).toHaveBeenCalledWith('cloud:decide', { ref: 'ABCDEFGHJKMN', decision: 'accepted' });
        expect(electron.on).toHaveBeenCalledWith('cloud:pairingChanged', expect.any(Function));
        expect(api.cloud.onboard).toBeUndefined();
        expect(api.cloud.toggle).toBeUndefined();
    });

    it('exposes per-user override admin IPC', async () => {
        const input = { userId: 20, action: 'updateQueueStatus', effect: 'allow', reason: 'Covers Tuesdays' };
        await api.db.getUserOverrides(20);
        await api.db.saveUserOverride(input);
        await api.db.deleteUserOverride({ userId: 20, action: 'updateQueueStatus' });
        expect(electron.invoke).toHaveBeenCalledWith('db:getUserOverrides', 20);
        expect(electron.invoke).toHaveBeenCalledWith('db:saveUserOverride', input);
        expect(electron.invoke).toHaveBeenCalledWith('db:deleteUserOverride', { userId: 20, action: 'updateQueueStatus' });
    });

    it('exposes custom role admin IPC', async () => {
        await api.db.getAllRoles();
        await api.db.saveRole({ name: 'billing-clerk', permissions: ['getQueue'] });
        await api.db.deleteRole('billing-clerk');
        expect(electron.invoke).toHaveBeenCalledWith('db:getAllRoles');
        expect(electron.invoke).toHaveBeenCalledWith('db:saveRole', { name: 'billing-clerk', permissions: ['getQueue'] });
        expect(electron.invoke).toHaveBeenCalledWith('db:deleteRole', 'billing-clerk');
    });

    it('exposes HIU record fetch and ABDM intake IPC', async () => {
        await api.db.abdmHiuFetchRecords({ consentId: 1 });
        await api.db.abdmHiuGetExternalRecords({ patientId: 1 });
        await api.db.abdmHiuClearExternalRecords({ patientId: 1 });
        await api.db.abdmHiuImportMedication({ patientId: 1, medicine_name: 'Amlodipine' });
        await api.db.abdmAbhaLookup({ abhaAddress: 'x@sbx' });
        await api.db.abdmAbhaCard({ id: 1 });
        expect(electron.invoke).toHaveBeenCalledWith('db:abdmHiuFetchRecords', { consentId: 1 });
        expect(electron.invoke).toHaveBeenCalledWith('db:abdmHiuGetExternalRecords', { patientId: 1 });
        expect(electron.invoke).toHaveBeenCalledWith('db:abdmHiuClearExternalRecords', { patientId: 1 });
        expect(electron.invoke).toHaveBeenCalledWith('db:abdmHiuImportMedication', { patientId: 1, medicine_name: 'Amlodipine' });
        expect(electron.invoke).toHaveBeenCalledWith('db:abdmAbhaLookup', { abhaAddress: 'x@sbx' });
        expect(electron.invoke).toHaveBeenCalledWith('db:abdmAbhaCard', { id: 1 });
    });

    it('exposes demo seed admin IPC', async () => {
        await api.db.getDemoSeedState();
        await api.db.seedDemoData();
        await api.db.clearDemoData();
        expect(electron.invoke).toHaveBeenCalledWith('db:getDemoSeedState');
        expect(electron.invoke).toHaveBeenCalledWith('db:seedDemoData');
        expect(electron.invoke).toHaveBeenCalledWith('db:clearDemoData');
    });

    it('exposes duplicate-warning search IPC', async () => {
        await api.db.findDuplicateCandidates({ name: 'Ravi', mobile: '9888877771' });
        expect(electron.invoke).toHaveBeenCalledWith('db:findDuplicateCandidates', { name: 'Ravi', mobile: '9888877771' });
    });

    it('exposes merge workflow IPC', async () => {
        await api.db.previewPatientMerge({ survivorId: 1, duplicateId: 2 });
        await api.db.mergePatients({ survivorId: 1, duplicateId: 2, reason: 'Dup' });
        await api.db.unmergePatients(2);
        expect(electron.invoke).toHaveBeenCalledWith('db:previewPatientMerge', { survivorId: 1, duplicateId: 2 });
        expect(electron.invoke).toHaveBeenCalledWith('db:mergePatients', { survivorId: 1, duplicateId: 2, reason: 'Dup' });
        expect(electron.invoke).toHaveBeenCalledWith('db:unmergePatients', 2);
    });

    it('exposes billing ledger IPC', async () => {
        await api.db.getInvoice(7);
        await api.db.getVisitInvoices(3);
        await api.db.createInvoice({ visitId: 3, items: [] });
        await api.db.recordPayment({ invoiceId: 9, amount: 200 });
        await api.db.refundPayment({ paymentId: 4, reason: 'Dup' });
        await api.db.voidInvoice({ invoiceId: 9, reason: 'Cancelled' });
        expect(electron.invoke).toHaveBeenCalledWith('db:getInvoice', 7);
        expect(electron.invoke).toHaveBeenCalledWith('db:getVisitInvoices', 3);
        expect(electron.invoke).toHaveBeenCalledWith('db:createInvoice', { visitId: 3, items: [] });
        expect(electron.invoke).toHaveBeenCalledWith('db:recordPayment', { invoiceId: 9, amount: 200 });
        expect(electron.invoke).toHaveBeenCalledWith('db:refundPayment', { paymentId: 4, reason: 'Dup' });
        expect(electron.invoke).toHaveBeenCalledWith('db:voidInvoice', { invoiceId: 9, reason: 'Cancelled' });
    });

    it('exposes prescription order IPC', async () => {
        await api.db.getVisitPrescriptions(3);
        await api.db.cancelPrescription({ visitId: 3, reason: 'Stopped' });
        await api.db.recordPrescriptionPrint({ visitId: 3 });
        expect(electron.invoke).toHaveBeenCalledWith('db:getVisitPrescriptions', 3);
        expect(electron.invoke).toHaveBeenCalledWith('db:cancelPrescription', { visitId: 3, reason: 'Stopped' });
        expect(electron.invoke).toHaveBeenCalledWith('db:recordPrescriptionPrint', { visitId: 3 });
    });
});
