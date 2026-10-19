import { describe, expect, it, vi } from 'vitest';
import { ParameterStoreCredentials } from '../src/parameterStore.js';

const NAMES = { clientIdName: '/nalamdesk/abdm/client-id', clientSecretName: '/nalamdesk/abdm/client-secret' };

function clientReturning(parameters: { Name: string; Value: string }[]) {
    return { send: vi.fn(async () => ({ Parameters: parameters })) };
}

describe('ParameterStoreCredentials', () => {
    it('reads both parameters in one decrypted call', async () => {
        const client = clientReturning([
            { Name: NAMES.clientIdName, Value: 'SBX_1' },
            { Name: NAMES.clientSecretName, Value: 's3cret' }
        ]);
        const creds = new ParameterStoreCredentials({ ...NAMES, client: client as any });
        expect(await creds.load()).toEqual({ clientId: 'SBX_1', clientSecret: 's3cret' });
        const command = (client.send.mock.calls[0] as any)[0];
        expect(command.input).toEqual({ Names: [NAMES.clientIdName, NAMES.clientSecretName], WithDecryption: true });
    });

    it('caches for five minutes, then reads again', async () => {
        const now = { t: 0 };
        const client = clientReturning([
            { Name: NAMES.clientIdName, Value: 'SBX_1' },
            { Name: NAMES.clientSecretName, Value: 's3cret' }
        ]);
        const creds = new ParameterStoreCredentials({ ...NAMES, client: client as any, nowMs: () => now.t });
        await creds.load();
        now.t = 4 * 60 * 1000;
        await creds.load();
        expect(client.send).toHaveBeenCalledTimes(1);
        now.t = 5 * 60 * 1000;
        await creds.load();
        expect(client.send).toHaveBeenCalledTimes(2);
    });

    it('fails without echoing values when a parameter is missing', async () => {
        const client = clientReturning([{ Name: NAMES.clientIdName, Value: 'SBX_1' }]);
        const creds = new ParameterStoreCredentials({ ...NAMES, client: client as any });
        await expect(creds.load()).rejects.toThrow('vendor_credentials_missing');
    });
});
