import { describe, expect, it } from 'vitest';
import { resolveRoute } from '../src/allowlist.js';

describe('resolveRoute', () => {
    it.each([
        ['POST', '/abdm/abha/v3/enrollment/request/otp', 'abha', '/v3/enrollment/request/otp'],
        ['POST', '/abdm/abha/v3/enrollment/enrol/byAadhaar', 'abha', '/v3/enrollment/enrol/byAadhaar'],
        ['POST', '/abdm/abha/v3/profile/login/verify', 'abha', '/v3/profile/login/verify'],
        ['GET', '/abdm/abha/v3/profile/account/abha-card', 'abha', '/v3/profile/account/abha-card'],
        ['GET', '/abdm/abha/v3/profile/public/certificate', 'abha', '/v3/profile/public/certificate'],
        ['POST', '/abdm/gateway/patient-share/v3/on-share', 'gateway', '/patient-share/v3/on-share'],
        ['POST', '/abdm/abha/v3/profile/account/getAbhaCard', 'abha', '/v3/profile/account/getAbhaCard'],
        ['POST', '/abdm/gateway/hip/v3/link/patient/links/sms/notify2', 'gateway', '/hip/v3/link/patient/links/sms/notify2'],
        ['GET', '/abdm/gateway/gateway/v3/bridge/getServices', 'gateway', '/gateway/v3/bridge/getServices'],
    ])('allows %s %s', (method, path, upstream, upstreamPath) => {
        expect(resolveRoute(method, path)).toMatchObject({ upstream, upstreamPath });
    });

    it.each([
        ['POST', '/abdm/gateway/gateway/v3/sessions'],
        ['PATCH', '/abdm/gateway/gateway/v3/bridge/url'],
        ['POST', '/abdm/gateway/v3/bridge/addUpdateServices'],
        ['POST', '/abdm/gateway/hip/v3/link/carecontext/../../gateway/v3/sessions'],
        ['POST', '/abdm/gateway/consent%2Fv3/request/init'],
        ['POST', '/abdm/gateway//consent/v3/request/init'],
        ['GET', '/abdm/gateway/consent/v3/request/init'],
        ['POST', '/abdm/abha/patient-share/v3/on-share'],
        ['POST', '/abdm/other/v3/profile/login/verify'],
        ['POST', '/abha/v3/profile/login/verify']
    ])('refuses %s %s', (method, path) => {
        expect(resolveRoute(method, path)).toBeNull();
    });
});
