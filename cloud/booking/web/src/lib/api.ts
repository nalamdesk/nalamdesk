import { sha256Hex } from './booking';

export interface ClinicSummary {
    clinicId: string;
    name: string;
    city: string;
    specialty: string;
    online: boolean;
    sealingPublicKey: string;
}

export interface OpenSlot {
    slotId: string;
    date: string;
    time: string;
}

export type BookingStatus = 'Requested' | 'Accepted' | 'Declined';

export class ApiError extends Error {
    constructor(readonly status: number, readonly code: string) {
        super(code);
    }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
        response = await fetch(path, { ...init, credentials: 'omit' });
    } catch {
        throw new ApiError(0, 'offline');
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(response.status, typeof body?.error === 'string' ? body.error : 'unknown');
    return body as T;
}

export async function listClinics(): Promise<ClinicSummary[]> {
    return (await call<{ clinics: ClinicSummary[] }>('/api/clinics')).clinics;
}

export async function listSlots(clinicId: string): Promise<OpenSlot[]> {
    return (await call<{ slots: OpenSlot[] }>(`/api/slots/${encodeURIComponent(clinicId)}`)).slots;
}

export interface BookRequest {
    clinicId: string;
    ref: string;
    slotId: string | null;
    phoneDigest: string;
    sealed: string;
}

export async function submitBooking(request: BookRequest): Promise<{ ref: string; status: BookingStatus }> {
    const body = JSON.stringify(request);
    return call('/api/book', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            // CloudFront signs requests to the API with origin access control,
            // which needs the body hash from the caller for a POST.
            'x-amz-content-sha256': await sha256Hex(body)
        },
        body
    });
}

export async function bookingStatus(ref: string): Promise<{ ref: string; status: BookingStatus; clinicName: string | null }> {
    return call(`/api/booking/${encodeURIComponent(ref)}`);
}
