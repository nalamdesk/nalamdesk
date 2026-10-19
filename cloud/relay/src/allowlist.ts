export type Upstream = 'abha' | 'gateway';

export interface AllowedRoute {
    upstream: Upstream;
    method: 'GET' | 'POST';
    /** Path below the upstream root, matched in full. */
    pattern: RegExp;
    milestone: 'M1' | 'M2' | 'M3';
}

// Every path a paired desktop may reach, by milestone. Anything else is
// refused before the vendor token is attached, so a device can never reach
// gateway admin APIs (bridge registration, session minting, facility
// linking). Paths follow the public v3 docs; reconfirm each against the
// sandbox once credentials land (#152).
const SEGMENT = '[A-Za-z0-9._-]+';

export const ALLOWED_ROUTES: readonly AllowedRoute[] = [
    // M1: ABHA enrolment, login, profile and card (ABHA host).
    { upstream: 'abha', method: 'GET', pattern: /^\/v3\/profile\/public\/certificate$/, milestone: 'M1' },
    { upstream: 'abha', method: 'POST', pattern: new RegExp(`^/v3/enrollment/(request/otp|enrol/${SEGMENT}|auth/${SEGMENT})$`), milestone: 'M1' },
    { upstream: 'abha', method: 'GET', pattern: /^\/v3\/enrollment\/enrol\/suggestion$/, milestone: 'M1' },
    { upstream: 'abha', method: 'POST', pattern: /^\/v3\/enrollment\/enrol\/abha-address$/, milestone: 'M1' },
    { upstream: 'abha', method: 'POST', pattern: new RegExp(`^/v3/profile/login/(request/otp|verify|verify/user)$`), milestone: 'M1' },
    { upstream: 'abha', method: 'POST', pattern: /^\/v3\/profile\/account\/verify$/, milestone: 'M1' },
    { upstream: 'abha', method: 'GET', pattern: /^\/v3\/profile\/account(\/abha-card|\/qrCode)?$/, milestone: 'M1' },
    // M1: scan-and-share response (gateway).
    { upstream: 'gateway', method: 'POST', pattern: /^\/patient-share\/v3\/on-share$/, milestone: 'M1' },
    // M2: HIP discovery, linking, consent and data flow (gateway).
    { upstream: 'gateway', method: 'POST', pattern: /^\/v3\/token\/generate-token$/, milestone: 'M2' },
    { upstream: 'gateway', method: 'POST', pattern: /^\/hip\/v3\/link\/carecontext$/, milestone: 'M2' },
    { upstream: 'gateway', method: 'POST', pattern: /^\/hip\/v3\/link\/context\/notify$/, milestone: 'M2' },
    { upstream: 'gateway', method: 'POST', pattern: /^\/user-initiated-linking\/v3\/patient\/care-context\/on-discover$/, milestone: 'M2' },
    { upstream: 'gateway', method: 'POST', pattern: /^\/user-initiated-linking\/v3\/link\/care-context\/(on-init|on-confirm)$/, milestone: 'M2' },
    { upstream: 'gateway', method: 'POST', pattern: /^\/consent\/v3\/request\/hip\/on-notify$/, milestone: 'M2' },
    { upstream: 'gateway', method: 'POST', pattern: /^\/data-flow\/v3\/health-information\/hip\/on-request$/, milestone: 'M2' },
    { upstream: 'gateway', method: 'POST', pattern: /^\/data-flow\/v3\/health-information\/notify$/, milestone: 'M2' },
    // M3: HIU consent and fetch (gateway).
    { upstream: 'gateway', method: 'POST', pattern: /^\/consent\/v3\/request\/(init|status)$/, milestone: 'M3' },
    { upstream: 'gateway', method: 'POST', pattern: /^\/consent\/v3\/request\/hiu\/on-notify$/, milestone: 'M3' },
    { upstream: 'gateway', method: 'POST', pattern: /^\/consent\/v3\/fetch$/, milestone: 'M3' },
    { upstream: 'gateway', method: 'POST', pattern: /^\/data-flow\/v3\/health-information\/request$/, milestone: 'M3' }
];

export interface ResolvedRoute {
    upstream: Upstream;
    upstreamPath: string;
    route: AllowedRoute;
}

/**
 * Maps a desktop path such as `/abdm/abha/v3/profile/login/verify` onto an
 * allowlisted upstream route. Returns null for anything not on the list,
 * including traversal tricks, encoded slashes and query-smuggled paths.
 */
export function resolveRoute(method: string, desktopPath: string): ResolvedRoute | null {
    const match = /^\/abdm\/(abha|gateway)(\/[^?#]*)$/.exec(desktopPath);
    if (!match) return null;
    const upstream = match[1] as Upstream;
    const upstreamPath = match[2] as string;
    if (/(^|\/)\.\.?(\/|$)|%|\/\//.test(upstreamPath)) return null;
    const route = ALLOWED_ROUTES.find((candidate) =>
        candidate.upstream === upstream
        && candidate.method === method.toUpperCase()
        && candidate.pattern.test(upstreamPath));
    return route ? { upstream, upstreamPath, route } : null;
}
