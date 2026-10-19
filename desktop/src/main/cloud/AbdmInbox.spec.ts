import * as crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AbdmInboxHandler, type AbdmInboxRow } from './AbdmInbox';

vi.mock('electron-log', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

// Same format as cloud/relay/src/seal.ts.
function seal(plaintext: string, recipient: crypto.KeyObject, clinicId: string, type: string): string {
    const eph = crypto.generateKeyPairSync('x25519');
    const shared = crypto.diffieHellman({ publicKey: crypto.createPublicKey(recipient), privateKey: eph.privateKey });
    const salt = crypto.randomBytes(16);
    const key = Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from('nalamdesk-mailbox-v1'), 32));
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`nalamdesk-mailbox-v1|${clinicId}|${type}`));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.from(JSON.stringify({
        v: 1, epk: eph.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
        salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64')
    })).toString('base64');
}

function setup(fail = false) {
    const { privateKey } = crypto.generateKeyPairSync('x25519');
    const rows: AbdmInboxRow[] = [];
    const deps = {
        store: { saveAbdmInboxItem: (row: AbdmInboxRow) => { if (fail) throw new Error('locked'); rows.push(row); } },
        clinicId: () => 'cln_1',
        privateKey: () => privateKey
    };
    return { privateKey, rows, callbacks: new AbdmInboxHandler('abdm-callback', deps), pushes: new AbdmInboxHandler('abdm-data-push', deps) };
}

describe('AbdmInboxHandler', () => {
    it('keeps a data push exactly as the HIP sent it', () => {
        const h = setup();
        const body = '{"pageNumber":1,"entries":[{"content":"fidelius"}]}';
        expect(h.pushes.handle({ id: 'm1', type: 'abdm-data-push', sealed: seal(body, h.privateKey, 'cln_1', 'abdm-data-push') })).toBe('saved');
        expect(h.rows).toEqual([{ id: 'm1', type: 'abdm-data-push', path: null, request_id: null, received_at: null, payload: body }]);
    });

    it('drops an item sealed for another type or clinic, or not a callback', () => {
        const h = setup();
        const callback = JSON.stringify({ path: '/api/v3/hip/patient/share', headers: {}, body: '{}' });
        expect(h.callbacks.handle({ id: 'm1', type: 'abdm-callback', sealed: seal(callback, h.privateKey, 'cln_1', 'abdm-data-push') })).toBe('dropped');
        expect(h.callbacks.handle({ id: 'm2', type: 'abdm-callback', sealed: seal(callback, h.privateKey, 'cln_2', 'abdm-callback') })).toBe('dropped');
        expect(h.callbacks.handle({ id: 'm3', type: 'abdm-callback', sealed: seal('{"path":"/etc"}', h.privateKey, 'cln_1', 'abdm-callback') })).toBe('dropped');
        expect(h.rows).toEqual([]);
    });

    it('leaves the item in the mailbox when the database refuses it', () => {
        const h = setup(true);
        expect(h.pushes.handle({ id: 'm1', type: 'abdm-data-push', sealed: seal('{}', h.privateKey, 'cln_1', 'abdm-data-push') })).toBe('retry');
    });
});
