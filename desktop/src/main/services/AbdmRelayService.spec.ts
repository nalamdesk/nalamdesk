import * as crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CloudUnavailableError, type AbdmRelaySend } from '../cloud/SignedCloudClient';
import { AbdmRelayService, abdmConfigView } from './AbdmRelayService';

const HFR = 'IN2710000123';

function relayWith(send: AbdmRelaySend | null, settings: any = {}, nowMs?: () => number) {
    return new AbdmRelayService({ getSettings: () => settings, relay: () => send, pairedHfrId: () => HFR, nowMs });
}

describe('AbdmRelayService', () => {
    it('is the mock until this computer is paired, or while an admin forces it', () => {
        const send = vi.fn() as unknown as AbdmRelaySend;
        expect(relayWith(null).status()).toEqual({ mode: 'mock', paired: false, hfr_id: null, forced_mock: false });
        expect(relayWith(null).isMockMode()).toBe(true);
        expect(relayWith(send).status()).toEqual({ mode: 'relay', paired: true, hfr_id: HFR, forced_mock: false });
        expect(relayWith(send).isMockMode()).toBe(false);
        expect(relayWith(send, { abdm_mock: 1 }).status()).toEqual({ mode: 'mock', paired: true, hfr_id: HFR, forced_mock: true });
        // An explicit "off" only means "follow pairing".
        expect(relayWith(null, { abdm_mock: 0 }).isMockMode()).toBe(true);
        expect(new AbdmRelayService().isMockMode()).toBe(true);
    });

    it('treats unreadable settings or pairing as unpaired and unforced', () => {
        const broken = new AbdmRelayService({
            getSettings: () => { throw new Error('db closed'); },
            relay: () => { throw new Error('restore'); },
            pairedHfrId: () => { throw new Error('nope'); }
        });
        expect(broken.status()).toEqual({ mode: 'mock', paired: false, hfr_id: null, forced_mock: false });
        const send = vi.fn() as unknown as AbdmRelaySend;
        const noHfr = new AbdmRelayService({ relay: () => send, pairedHfrId: () => { throw new Error('nope'); } });
        expect(noHfr.status().hfr_id).toBeNull();
    });

    it('sends through the relay under /abdm/<upstream> and returns the JSON body', async () => {
        const send = vi.fn(async () => ({ status: 200, body: { txnId: 't' } }));
        const relay = relayWith(send);

        expect(await relay.send('abha', 'POST', '/v3/enrollment/enrol/byMobile', { mobile: 'x' })).toEqual({ txnId: 't' });
        expect(send).toHaveBeenCalledWith('POST', '/abdm/abha/v3/enrollment/enrol/byMobile', { mobile: 'x' });

        await relay.send('gateway', 'POST', '/consent/v3/request/init');
        expect(send).toHaveBeenLastCalledWith('POST', '/abdm/gateway/consent/v3/request/init', {});
        await relay.send('abha', 'GET', '/v3/profile/account', { ignored: true });
        expect(send).toHaveBeenLastCalledWith('GET', '/abdm/abha/v3/profile/account', undefined);
    });

    it('explains refusals, an unreachable relay, and an unpaired computer', async () => {
        await expect(relayWith(null).send('abha', 'GET', '/v3/x')).rejects.toThrow('not paired');
        await expect(relayWith(vi.fn(async () => ({ status: 403, body: { error: 'path_not_allowed' } }))).send('abha', 'GET', '/v3/x'))
            .rejects.toThrow('ABDM request rejected (HTTP 403 (path_not_allowed)).');
        await expect(relayWith(vi.fn(async () => ({ status: 502, body: null }))).send('abha', 'GET', '/v3/x'))
            .rejects.toThrow('ABDM request rejected (HTTP 502).');
        await expect(relayWith(vi.fn(async () => { throw new CloudUnavailableError('network', 'Could not reach NalamDesk Cloud: ECONNRESET'); })).send('abha', 'GET', '/v3/x'))
            .rejects.toThrow('ABDM relay is unreachable: Could not reach NalamDesk Cloud: ECONNRESET');
        await expect(relayWith(vi.fn(async () => { throw new Error('boom'); })).send('abha', 'GET', '/v3/x')).rejects.toThrow('boom');
    });

    it('tests the route to ABDM with one relayed certificate read', async () => {
        let now = 0;
        const send = vi.fn(async () => { now += 120; return { status: 200, body: { publicKey: 'k' } }; });
        expect(await relayWith(send, {}, () => now).testConnectivity()).toEqual({
            ok: true, mode: 'relay', detail: `ABDM reached through the relay as ${HFR}.`, latencyMs: 120
        });
        expect(send).toHaveBeenCalledWith('GET', '/abdm/abha/v3/profile/public/certificate', undefined);

        const failed = await relayWith(vi.fn(async () => ({ status: 401, body: { error: 'device_revoked' } }))).testConnectivity();
        expect(failed).toMatchObject({ ok: false, mode: 'relay', detail: expect.stringContaining('device_revoked') });
        const odd = await relayWith(vi.fn(async () => { throw 'odd'; }) as unknown as AbdmRelaySend).testConnectivity();
        expect(odd).toMatchObject({ ok: false, detail: 'ABDM relay check failed.' });
    });

    it('reports the mock without calling anything', async () => {
        const send = vi.fn() as unknown as AbdmRelaySend;
        expect(await relayWith(null).testConnectivity()).toMatchObject({ ok: true, mode: 'mock', detail: expect.stringContaining('pair this computer') });
        expect(await relayWith(send, { abdm_mock: true }).testConnectivity()).toMatchObject({ ok: true, mode: 'mock', detail: expect.stringContaining('turn it off') });
        expect(send).not.toHaveBeenCalled();
    });

    it('RSA-encrypts OTP payloads for ABHA', () => {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' } });
        const sealed = AbdmRelayService.encryptWithPublicKey('482916', publicKey);
        const opened = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, Buffer.from(sealed, 'base64'));
        expect(opened.toString()).toBe('482916');
    });
});

describe('abdmConfigView', () => {
    it('shows registry identity and the relay connection, and no secrets', () => {
        const send = vi.fn() as unknown as AbdmRelaySend;
        const view = abdmConfigView({
            abdm_hip_id: 'H', abdm_counter_id: 'C', abdm_hfr_id: 'F', abdm_hpr_id: 'P', abdm_hip_endpoint: 'https://x',
            abdm_recipient_key: '{}', abdm_client_id: 'old', abdm_client_secret_protected: 'blob'
        }, relayWith(send));
        expect(view).toEqual({
            mock: false, forced_mock: false, paired: true, paired_hfr_id: HFR,
            hip_id: 'H', counter_id: 'C', hfr_id: 'F', hpr_id: 'P', hip_endpoint: 'https://x', has_recipient_key: true
        });
        expect(abdmConfigView(null, relayWith(null))).toMatchObject({ mock: true, paired: false, paired_hfr_id: '', hip_id: '', has_recipient_key: false });
    });
});
