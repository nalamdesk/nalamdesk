export type AbdmEnv = 'sandbox' | 'production';

export interface AbdmEnvironment {
    /** Gateway (HIE-CM) API root; v3 paths are appended under /api/hiecm. */
    gatewayBaseUrl: string;
    /** ABHA v3 API root; it is a separate host from the gateway. */
    abhaBaseUrl: string;
    /** Value of X-CM-ID on outbound calls. */
    cmId: string;
    /** Where the gateway publishes the keys that sign its callback JWTs. */
    gatewayCertsUrl: string;
}

// Hosts follow the public ABDM v3 docs. The certificate URL in particular
// still needs confirming with NHA for v3 (see #152); each value can be
// overridden per deployment without a code change.
export const ABDM_ENVIRONMENTS: Record<AbdmEnv, AbdmEnvironment> = {
    sandbox: {
        gatewayBaseUrl: 'https://dev.abdm.gov.in/api/hiecm',
        abhaBaseUrl: 'https://abhasbx.abdm.gov.in/abha/api',
        cmId: 'sbx',
        gatewayCertsUrl: 'https://dev.abdm.gov.in/api/hiecm/gateway/v3/certs'
    },
    production: {
        gatewayBaseUrl: 'https://live.abdm.gov.in/api/hiecm',
        abhaBaseUrl: 'https://abha.abdm.gov.in/abha/api',
        cmId: 'abdm',
        gatewayCertsUrl: 'https://live.abdm.gov.in/api/hiecm/gateway/v3/certs'
    }
};

export function resolveEnvironment(
    env: string | undefined,
    overrides: Partial<AbdmEnvironment> = {}
): { name: AbdmEnv; config: AbdmEnvironment } {
    const name: AbdmEnv = env === 'production' ? 'production' : 'sandbox';
    const config = { ...ABDM_ENVIRONMENTS[name] };
    for (const key of Object.keys(overrides) as (keyof AbdmEnvironment)[]) {
        const value = overrides[key];
        if (value) config[key] = value;
    }
    return { name, config };
}
