import { describe, expect, it } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import { open } from '../src/seal.js';
import { CLINIC_ID, harness, HIP_ID, PUSH_TOKEN } from './helpers.js';

const SHARE_BODY = JSON.stringify({ profile: { patient: { abhaAddress: 'priya@sbx', name: 'Priya Raman' } } });

describe('gateway callbacks', () => {
    it('seals a verified callback into the clinic mailbox, rings the doorbell and answers 202', async () => {
        const h = await harness();
        const res = await h.app.request('/api/v3/hip/patient/share', {
            method: 'POST',
            headers: {
                authorization: `Bearer ${await h.sign()}`,
                'x-hip-id': HIP_ID,
                'request-id': 'req-9',
                'content-type': 'application/json'
            },
            body: SHARE_BODY
        });
        expect(res.status).toBe(202);
        expect(h.mailbox).toHaveLength(1);
        const item = h.mailbox[0]!;
        expect(item).toMatchObject({ clinicId: CLINIC_ID, type: 'abdm-callback' });
        expect(item.sealed).not.toContain('priya');
        expect(Buffer.from(item.sealed, 'base64').toString()).not.toContain('priya');

        const opened = JSON.parse(open(item.sealed, h.clinic.privateKey, CLINIC_ID, 'abdm-callback').toString());
        expect(opened.path).toBe('/api/v3/hip/patient/share');
        expect(opened.body).toBe(SHARE_BODY);
        expect(opened.headers['request-id']).toBe('req-9');
        expect(opened.headers.authorization).toBeUndefined();
        expect(h.rings).toEqual([CLINIC_ID]);
    });

    it('routes HIU callbacks by X-HIU-ID', async () => {
        const h = await harness();
        const res = await h.app.request('/api/v3/hiu/consent/request/on-init', {
            method: 'POST', headers: { authorization: `Bearer ${await h.sign()}`, 'x-hiu-id': HIP_ID }, body: '{}'
        });
        expect(res.status).toBe(202);
        expect(h.mailbox).toHaveLength(1);
    });

    it('rejects a forged callback signed by another key', async () => {
        const h = await harness();
        const { privateKey } = await generateKeyPair('RS256');
        const forged = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'gw-1' })
            .setExpirationTime('5m').sign(privateKey);
        const res = await h.app.request('/api/v3/hip/patient/share', {
            method: 'POST', headers: { authorization: `Bearer ${forged}`, 'x-hip-id': HIP_ID }, body: SHARE_BODY
        });
        expect(res.status).toBe(401);
        expect(h.mailbox).toHaveLength(0);
        expect(h.rings).toHaveLength(0);
    });

    it.each([
        ['no Authorization header', undefined],
        ['a non-JWT bearer', 'Bearer abc'],
        ['an unsigned token', `Bearer ${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.`]
    ])('rejects a callback with %s', async (_label, authorization) => {
        const h = await harness();
        const headers: Record<string, string> = { 'x-hip-id': HIP_ID };
        if (authorization) headers.authorization = authorization;
        const res = await h.app.request('/api/v3/hip/patient/share', { method: 'POST', headers, body: '{}' });
        expect(res.status).toBe(401);
        expect(h.mailbox).toHaveLength(0);
    });

    it('rejects an expired gateway token', async () => {
        const h = await harness();
        const expired = await h.sign({}, Math.floor(Date.now() / 1000) - 120);
        const res = await h.app.request('/api/v3/hip/patient/share', {
            method: 'POST', headers: { authorization: `Bearer ${expired}`, 'x-hip-id': HIP_ID }, body: '{}'
        });
        expect(res.status).toBe(401);
    });

    it('refuses facilities that are unknown or not linked to the bridge', async () => {
        const h = await harness();
        const token = await h.sign();
        const unknown = await h.app.request('/api/v3/hip/patient/share', {
            method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-hip-id': 'IN0000000000' }, body: '{}'
        });
        expect(unknown.status).toBe(404);
        h.setFacility({ clinicId: CLINIC_ID, hipId: HIP_ID, sealingPublicKey: h.clinic.publicRaw, linkedToBridge: false });
        const unlinked = await h.app.request('/api/v3/hip/patient/share', {
            method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-hip-id': HIP_ID }, body: '{}'
        });
        expect(unlinked.status).toBe(404);
        expect(h.mailbox).toHaveLength(0);
    });

    it('answers 503 instead of 202 when the mailbox cannot store the item', async () => {
        const h = await harness();
        h.failMailbox();
        const res = await h.app.request('/api/v3/hip/patient/share', {
            method: 'POST', headers: { authorization: `Bearer ${await h.sign()}`, 'x-hip-id': HIP_ID }, body: '{}'
        });
        expect(res.status).toBe(503);
    });

    it('still answers 202 when the doorbell fails, since the desktop also polls', async () => {
        const h = await harness();
        h.failDoorbell();
        const res = await h.app.request('/api/v3/hip/patient/share', {
            method: 'POST', headers: { authorization: `Bearer ${await h.sign()}`, 'x-hip-id': HIP_ID }, body: '{}'
        });
        expect(res.status).toBe(202);
        expect(h.mailbox).toHaveLength(1);
    });

    it('logs metadata only', async () => {
        const h = await harness();
        await h.app.request('/api/v3/hip/patient/share', {
            method: 'POST', headers: { authorization: `Bearer ${await h.sign()}`, 'x-hip-id': HIP_ID }, body: SHARE_BODY
        });
        await h.app.request(`/hiu/data-push/${PUSH_TOKEN}`, { method: 'POST', body: '{"entries":[{"content":"cipher"}]}' });
        expect(h.logs.map((entry) => Object.keys(entry).sort())).toEqual([
            ['hipId', 'ms', 'path', 'route', 'status'],
            ['hipId', 'ms', 'path', 'route', 'status']
        ]);
        const text = JSON.stringify(h.logs);
        expect(text).not.toContain('priya');
        expect(text).not.toContain(PUSH_TOKEN);
        expect(text).not.toContain('cipher');
    });
});

describe('HIU data push', () => {
    const PUSH = JSON.stringify({ pageNumber: 1, transactionId: 'tx-1', entries: [{ content: 'fidelius-ciphertext' }], keyMaterial: { nonce: 'n' } });

    it('seals the pushed bytes unchanged into the mailbox', async () => {
        const h = await harness();
        const res = await h.app.request(`/hiu/data-push/${PUSH_TOKEN}`, { method: 'POST', body: PUSH });
        expect(res.status).toBe(202);
        const item = h.mailbox[0]!;
        expect(item.type).toBe('abdm-data-push');
        expect(open(item.sealed, h.clinic.privateKey, CLINIC_ID, 'abdm-data-push').toString()).toBe(PUSH);
        expect(h.rings).toEqual([CLINIC_ID]);
    });

    it('refuses unknown push tokens and non-JSON bodies', async () => {
        const h = await harness();
        expect((await h.app.request(`/hiu/data-push/${'q'.repeat(40)}`, { method: 'POST', body: PUSH })).status).toBe(404);
        expect((await h.app.request('/hiu/data-push/short', { method: 'POST', body: PUSH })).status).toBe(404);
        expect((await h.app.request(`/hiu/data-push/${PUSH_TOKEN}`, { method: 'POST', body: 'not json' })).status).toBe(400);
        expect(h.mailbox).toHaveLength(0);
    });
});
