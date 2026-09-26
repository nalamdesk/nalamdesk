import * as crypto from 'node:crypto';
import type { DeviceKeyStore } from './DeviceKeyStore';
import { FideliusService, type FideliusEnvelope } from './FideliusService';

export interface HiuDeps {
    getSettings?: () => any;
    getHiuPrivateProtected?: () => string | null;
    saveHiuPrivateProtected?: (value: string) => unknown;
    saveSettingsPatch?: (patch: Record<string, unknown>) => unknown;
    keyStore?: DeviceKeyStore;
}

/**
 * HIU (Health Information User) identity: the clinic's own X25519 keypair
 * used to receive encrypted health records under patient consent (M3).
 *
 * The private half is generated once, wrapped by the OS keychain, and stored
 * as an opaque blob — the same contract as the ABDM client secret: it never
 * appears in generic settings reads, IPC getters, or LAN responses. Only
 * the public half (raw 32-byte base64) is shareable.
 */
export class HiuService {
    constructor(private readonly deps: HiuDeps = {}) { }

    /** Shareable HIU public key (raw base64), or null before first use. */
    getPublicKey(): string | null {
        try {
            return this.deps.getSettings?.()?.abdm_hiu_public_key || null;
        } catch {
            return null;
        }
    }

    /**
     * Generates the HIU keypair on first use; later calls return the stored
     * public key without touching private material. Throws
     * ENCRYPTION_UNAVAILABLE when device crypto cannot wrap the key.
     */
    ensureKeypair(): { publicKey: string } {
        const existing = this.getPublicKey();
        if (existing && this.deps.getHiuPrivateProtected?.()) return { publicKey: existing };
        const store = this.deps.keyStore;
        if (!store) throw new Error('ENCRYPTION_UNAVAILABLE');
        const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519', {
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });
        const publicRaw = crypto.createPublicKey(publicKey)
            .export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
        let wrapped: Buffer;
        try {
            wrapped = store.protect(Buffer.from(privateKey, 'utf8'));
        } catch (error) {
            throw new Error(`ENCRYPTION_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.deps.saveHiuPrivateProtected?.(wrapped.toString('base64'));
        this.deps.saveSettingsPatch?.({ abdm_hiu_public_key: publicRaw });
        return { publicKey: publicRaw };
    }

    /** Test seam for the inbound decrypt path PR2 builds on. */
    decryptForTest(envelope: FideliusEnvelope): unknown {
        return new FideliusService().decryptEnvelope(envelope, this.readPrivatePem());
    }

    private readPrivatePem(): string {
        const store = this.deps.keyStore;
        const wrapped: string | null | undefined = this.deps.getHiuPrivateProtected?.();
        if (!store || !wrapped) throw new Error('ENCRYPTION_UNAVAILABLE');
        return store.unprotect(Buffer.from(wrapped, 'base64')).toString('utf8');
    }
}
