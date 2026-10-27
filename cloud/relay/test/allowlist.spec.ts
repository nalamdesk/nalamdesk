import { describe, expect, it } from 'vitest';
import { resolveRoute } from '../src/allowlist.js';

describe('resolveRoute', () => {
    it.each([
        ['POST', '/abdm/abha/v3/enrollment/request/otp', 'abha', '/v3/enrollment/request/otp'],
        ['POST', '/abdm/abha/v3/enrollment/enrol/byAadhaar', 'abha', '/v3/enrollment/enrol/byAadhaar'],
        ['POST', '/abdm/abha/v3/enrollment/auth/byAbdm', 'abha', '/v3/enrollment/auth/byAbdm'],
        ['POST', '/abdm/abha/v3/enrollment/enrol/byDocument', 'abha', '/v3/enrollment/enrol/byDocument'],
        ['GET', '/abdm/abha/v3/enrollment/enrol/suggestion', 'abha', '/v3/enrollment/enrol/suggestion'],
        ['POST', '/abdm/abha/v3/enrollment/enrol/abha-address', 'abha', '/v3/enrollment/enrol/abha-address'],
        ['POST', '/abdm/abha/v3/profile/login/request/otp', 'abha', '/v3/profile/login/request/otp'],
        ['POST', '/abdm/abha/v3/profile/login/verify', 'abha', '/v3/profile/login/verify'],
        ['POST', '/abdm/abha/v3/profile/login/verify/user', 'abha', '/v3/profile/login/verify/user'],
        ['POST', '/abdm/abha/v3/profile/login/search', 'abha', '/v3/profile/login/search'],
        ['POST', '/abdm/abha/v3/profile/account/verify', 'abha', '/v3/profile/account/verify'],
        ['POST', '/abdm/abha/v3/profile/account/request/otp', 'abha', '/v3/profile/account/request/otp'],
        ['POST', '/abdm/abha/v3/profile/account/abha/search', 'abha', '/v3/profile/account/abha/search'],
        ['GET', '/abdm/abha/v3/profile/account', 'abha', '/v3/profile/account'],
        ['GET', '/abdm/abha/v3/profile/account/abha-card', 'abha', '/v3/profile/account/abha-card'],
        ['GET', '/abdm/abha/v3/profile/account/qrCode', 'abha', '/v3/profile/account/qrCode'],
        ['GET', '/abdm/abha/v3/profile/public/certificate', 'abha', '/v3/profile/public/certificate'],
        ['POST', '/abdm/gateway/patient-share/v3/on-share', 'gateway', '/patient-share/v3/on-share'],
        ['POST', '/abdm/gateway/consent/v3/request/init', 'gateway', '/consent/v3/request/init'],
        ['POST', '/abdm/gateway/consent/v3/request/status', 'gateway', '/consent/v3/request/status'],
        ['POST', '/abdm/gateway/hip/v3/link/patient/links/sms/notify2', 'gateway', '/hip/v3/link/patient/links/sms/notify2'],
        ['GET', '/abdm/gateway/hip/v3/link/patient/links', 'gateway', '/hip/v3/link/patient/links'],
        ['POST', '/abdm/gateway/v3/token/generate-token', 'gateway', '/v3/token/generate-token'],
        ['POST', '/abdm/gateway/hip/v3/link/carecontext', 'gateway', '/hip/v3/link/carecontext'],
        ['POST', '/abdm/gateway/hip/v3/link/context/notify', 'gateway', '/hip/v3/link/context/notify'],
        ['POST', '/abdm/gateway/consent/v3/request/hip/on-notify', 'gateway', '/consent/v3/request/hip/on-notify'],
        ['POST', '/abdm/gateway/consent/v3/fetch', 'gateway', '/consent/v3/fetch'],
        ['POST', '/abdm/gateway/data-flow/v3/health-information/request', 'gateway', '/data-flow/v3/health-information/request'],
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
        // Removed v3-fiction routes that must stay refused.
        ['POST', '/abdm/abha/v3/enrollment/enrol/byMobile'],
        ['POST', '/abdm/abha/v3/enrollment/enrol/verify'],
        ['POST', '/abdm/abha/v3/enrollment/enrol/byAbdm'],
        ['POST', '/abdm/abha/v3/profile/account/getAbhaCard'],
        ['GET', '/abdm/gateway/gateway/v3/bridge/getServices'],
        ['POST', '/abdm/abha/patient-share/v3/on-share'],
        ['POST', '/abdm/other/v3/profile/login/verify'],
        ['POST', '/abha/v3/profile/login/verify']
    ])('refuses %s %s', (method, path) => {
        expect(resolveRoute(method, path)).toBeNull();
    });
});
