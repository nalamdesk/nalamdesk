import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../services/DatabaseService';
import { MIGRATIONS } from './migrations';
import { TestDatabase } from '../testing/TestDatabase';
import { runWithContext } from '../../shared/request-context';
import type { CloudDeviceRow } from '../cloud/DeviceIdentity';

const V54 = 54;

function deviceRow(patch: Partial<CloudDeviceRow> = {}): CloudDeviceRow {
    return {
        state: 'paired', hfr_id: 'IN3310000001', request_id: null, request_expires_at: null,
        device_id: 'dev-1', clinic_id: 'clinic-1', data_push_url: 'https://relay.example/push/1', label: 'Reception',
        signing_public: 'sig-pub', signing_private_protected: 'sig-priv', signing_created_at: 1,
        previous_signing_public: null, previous_signing_private_protected: null,
        sealing_public: 'seal-pub', sealing_private_protected: 'seal-priv', paired_at: 2, revoked_reason: null,
        updated_at: 3, iot_private_protected: 'iot-priv', iot_public: 'iot-pub', iot_certificate_pem: 'PEM',
        iot_endpoint: 'iot.example', iot_topic: 'topic/1', iot_client_id: 'client-1',
        ...patch
    };
}

/** A paired single-facility vault as it stands before v54 (#215). */
function seedPairedVault(db: TestDatabase) {
    for (const migration of MIGRATIONS.filter(m => m.version < V54)) migration.up(db);
    db.pragma(`user_version = ${V54 - 1}`);
    db.prepare(`INSERT INTO settings (clinic_name, cloud_enabled, cloud_clinic_id) VALUES ('Sunrise Clinic', 1, 'clinic-1')`).run();
    const row = deviceRow();
    const columns = Object.keys(row);
    const placeholders = columns.map(c => '@' + c).join(', ');
    db.prepare(`INSERT INTO cloud_device (id, ${columns.join(', ')}) VALUES (1, ${placeholders})`).run(row as any);
}

describe('migration v54: cloud pairing per facility (#215)', () => {
    let db: TestDatabase;
    let service: DatabaseService;

    beforeEach(async () => {
        db = new TestDatabase();
        seedPairedVault(db);
        service = new DatabaseService();
        service.setDb(db);
        await service.migrate({ skipBackup: true });
        db.prepare("INSERT INTO facilities (id, code, name) VALUES (2, 'ANN', 'Anna Nagar')").run();
    });

    afterEach(() => db.close());

    it('keeps the paired clinic paired as facility 1, keys and mailbox intact', () => {
        expect(db.pragma('user_version', { simple: true })).toBe(DatabaseService.latestSchemaVersion());
        const columns = (db.prepare('PRAGMA table_info(cloud_device)').all() as any[]).map(c => c.name);
        expect(columns).not.toContain('id');
        expect(service.getCloudDevice(1)).toEqual(deviceRow());
        expect(service.getCloudDevice(2)).toBeNull();
        expect(service.listCloudDeviceFacilities()).toEqual([1]);
    });

    it('moves the online-booking listing to facility 1', () => {
        expect(service.getSettings(1)).toMatchObject({ cloud_enabled: 1, cloud_clinic_id: 'clinic-1' });
        expect(service.getSettings(2)).toMatchObject({ cloud_enabled: 0, cloud_clinic_id: null });
        service.saveSettings({ cloud_enabled: 1, cloud_clinic_id: 'clinic-2' }, 2);
        expect(service.getSettings(1)).toMatchObject({ cloud_clinic_id: 'clinic-1' });
        expect(service.getSettings(2)).toMatchObject({ cloud_enabled: 1, cloud_clinic_id: 'clinic-2' });
    });

    it('gives each facility its own identity, read and written as the request facility', () => {
        const second = deviceRow({ hfr_id: 'IN3310000002', device_id: 'dev-2', signing_public: 'sig-2' });
        runWithContext({ userId: 1, facilityId: 2 }, () => service.saveCloudDevice(second));
        expect(runWithContext({ userId: 1, facilityId: 2 }, () => service.getCloudDevice())).toEqual(second);
        expect(runWithContext({ userId: 1, facilityId: 1 }, () => service.getCloudDevice())?.device_id).toBe('dev-1');
        expect(service.listCloudDeviceFacilities()).toEqual([1, 2]);

        runWithContext({ userId: 1, facilityId: 2 }, () => service.clearCloudDevice());
        expect(service.getCloudDevice(2)).toBeNull();
        expect(service.getCloudDevice(1)?.device_id).toBe('dev-1');
    });

    it('refuses a second live pairing for the same HFR ID or an unknown facility', () => {
        expect(() => service.saveCloudDevice(deviceRow({ state: 'requested' }), 2))
            .toThrow('MAIN is already paired with this HFR ID. Cancel or unpair it there first.');
        expect(() => service.saveCloudDevice(deviceRow({ hfr_id: 'IN3310000009' }), 99)).toThrow('Unknown facility.');
        // Once facility 1's pairing is revoked, the HFR ID can move.
        service.saveCloudDevice(deviceRow({ state: 'revoked' }), 1);
        service.saveCloudDevice(deviceRow({ state: 'requested' }), 2);
        expect(service.getCloudDevice(2)?.state).toBe('requested');
    });

    it('names an open request elsewhere, and drops it once expired', () => {
        const hfr = 'IN3310000005';
        service.saveCloudDevice(deviceRow({ hfr_id: hfr, state: 'requested', request_expires_at: Date.now() + 60_000 }), 2);
        expect(() => service.saveCloudDevice(deviceRow({ hfr_id: hfr, state: 'requested' }), 1))
            .toThrow('Anna Nagar has a pairing request open for this HFR ID.');
        service.saveCloudDevice(deviceRow({ hfr_id: hfr, state: 'requested', request_expires_at: Date.now() - 1 }), 2);
        service.saveCloudDevice(deviceRow({ hfr_id: hfr, state: 'requested', request_expires_at: Date.now() + 60_000 }), 1);
        expect(service.getCloudDevice(2)).toBeNull();
        expect(service.getCloudDevice(1)?.hfr_id).toBe(hfr);
    });

    it('files mailbox items under the facility they came to and checks retries per facility', () => {
        const item = (id: string) => ({ id, type: 'abdm-callback' as const, path: '/api/v3/x', request_id: 'r-1', received_at: null, payload: '{}' });
        runWithContext({ userId: 0, facilityId: 2 }, () => service.saveAbdmInboxItem(item('m-2')));
        service.saveAbdmInboxItem(item('m-1'));
        const items = service.getNewAbdmMailboxItems(10) as any[];
        expect(items.map(i => [i.id, i.facility_id]).sort()).toEqual([['m-1', 1], ['m-2', 2]]);

        service.setAbdmMailboxStatus('m-2', 'processed');
        expect(runWithContext({ userId: 0, facilityId: 2 }, () => service.abdmMailboxRequestSeen('/api/v3/x', 'r-1', 'other'))).toBe(true);
        expect(runWithContext({ userId: 0, facilityId: 1 }, () => service.abdmMailboxRequestSeen('/api/v3/x', 'r-1', 'other'))).toBe(false);
    });

    it('migrates a fresh vault with no settings or pairing', () => {
        const fresh = new TestDatabase();
        for (const migration of MIGRATIONS) migration.up(fresh);
        const freshService = new DatabaseService();
        freshService.setDb(fresh);
        expect(freshService.getCloudDevice(1)).toBeNull();
        expect(freshService.listFacilitiesForCloud()).toEqual([{ id: 1, code: 'MAIN', name: '' }]);
        fresh.close();
    });
});
