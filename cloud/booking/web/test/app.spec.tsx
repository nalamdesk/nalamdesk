import * as nodeCrypto from 'node:crypto';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { open } from './sealReference';

const keys = nodeCrypto.generateKeyPairSync('x25519');
const publicRaw = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');

const clinics = [
    { clinicId: 'c1', name: 'Arogya Family Clinic', city: 'Chennai', specialty: 'General Practice', online: true, sealingPublicKey: publicRaw },
    { clinicId: 'c2', name: 'Kovai Child Care', city: 'Coimbatore', specialty: 'Paediatrics', online: false, sealingPublicKey: publicRaw }
];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let bookCalls: { headers: Headers; body: any }[];
let bookResponse: () => Response;

beforeEach(() => {
    window.history.replaceState(null, '', '/');
    bookCalls = [];
    bookResponse = () => json({ ref: 'X', status: 'Requested' }, 201);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
        if (url === '/api/clinics') return json({ clinics });
        if (url.startsWith('/api/slots/')) return json({ slots: [
            { slotId: '2099-01-05T09:30', date: '2099-01-05', time: '09:30' },
            { slotId: '2099-01-05T16:00', date: '2099-01-05', time: '16:00' },
            { slotId: '2099-01-06T10:00', date: '2099-01-06', time: '10:00' }
        ] });
        if (url === '/api/book') {
            bookCalls.push({ headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
            return bookResponse();
        }
        if (url.startsWith('/api/booking/')) return json({ ref: url.split('/').pop(), status: 'Accepted', clinicName: 'Arogya Family Clinic' });
        return json({ error: 'not_found' }, 404);
    }));
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('booking site', () => {
    it('filters the directory by name, city or specialty', async () => {
        const user = userEvent.setup();
        render(<App />);
        expect(await screen.findByRole('heading', { name: 'Arogya Family Clinic' })).toBeTruthy();
        expect(screen.getByText('Open on NalamDesk now')).toBeTruthy();
        await user.type(screen.getByLabelText('Clinic, city or specialty'), 'coimbatore');
        expect(screen.queryByRole('heading', { name: 'Arogya Family Clinic' })).toBeNull();
        expect(screen.getByRole('heading', { name: 'Kovai Child Care' })).toBeTruthy();
        await user.clear(screen.getByLabelText('Clinic, city or specialty'));
        await user.type(screen.getByLabelText('Clinic, city or specialty'), 'dental');
        expect(screen.getByText('No clinic matches “dental”.')).toBeTruthy();
    });

    it('sends only ciphertext and a phone digest, and shows the reference', async () => {
        const user = userEvent.setup();
        render(<App />);
        await user.click(await screen.findByRole('button', { name: 'Request a time at Arogya Family Clinic' }));
        const dialog = await screen.findByRole('dialog');
        await user.click(await within(dialog).findByRole('button', { name: '4:00 pm' }));
        await user.click(within(dialog).getByRole('button', { name: 'Continue' }));

        // Validation stops an empty form.
        await user.click(within(dialog).getByRole('button', { name: 'Send request' }));
        expect(within(dialog).getByText('Enter the patient’s name.')).toBeTruthy();
        expect(bookCalls).toHaveLength(0);

        await user.type(within(dialog).getByLabelText('Patient’s name'), 'Asha Raman');
        await user.type(within(dialog).getByLabelText('Phone number'), '+91 98765 43210');
        await user.type(within(dialog).getByLabelText(/Reason for the visit/), 'Fever for two days');
        await user.click(within(dialog).getByRole('checkbox'));
        await user.click(within(dialog).getByRole('button', { name: 'Send request' }));

        expect(await within(dialog).findByText('Request sent')).toBeTruthy();
        expect(bookCalls).toHaveLength(1);
        const { body, headers } = bookCalls[0]!;
        const wire = JSON.stringify(body);
        expect(wire).not.toContain('Asha');
        expect(wire).not.toContain('98765');
        expect(wire).not.toContain('Fever');
        expect(body).toMatchObject({ clinicId: 'c1', slotId: '2099-01-05T16:00' });
        expect(body.phoneDigest).toMatch(/^[0-9a-f]{64}$/);
        expect(headers.get('x-amz-content-sha256')).toBe(nodeCrypto.createHash('sha256').update(JSON.stringify(body)).digest('hex'));

        const opened = JSON.parse(open(body.sealed, keys.privateKey, 'c1', 'booking-request').toString());
        expect(opened).toMatchObject({
            v: 1, ref: body.ref, clinicId: 'c1', slotId: '2099-01-05T16:00',
            slot: { date: '2099-01-05', time: '16:00' }, name: 'Asha Raman', phone: '9876543210', reason: 'Fever for two days'
        });
        expect(within(dialog).getByText(body.ref.replace(/(.{4})(?=.)/g, '$1-'))).toBeTruthy();
    });

    it('sends a call-back request with no slot', async () => {
        const user = userEvent.setup();
        render(<App />);
        await user.click(await screen.findByRole('button', { name: 'Request a time at Kovai Child Care' }));
        const dialog = await screen.findByRole('dialog');
        await user.click(await within(dialog).findByRole('button', { name: /Ask for a call back/ }));
        await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
        await user.type(within(dialog).getByLabelText('Patient’s name'), 'Ravi');
        await user.type(within(dialog).getByLabelText('Phone number'), '9876543210');
        await user.click(within(dialog).getByRole('checkbox'));
        await user.click(within(dialog).getByRole('button', { name: 'Send request' }));
        expect(await within(dialog).findByText(/They are offline now/)).toBeTruthy();
        expect(bookCalls[0]!.body.slotId).toBeNull();
    });

    it('sends the patient back to pick another time when the slot was just taken', async () => {
        const user = userEvent.setup();
        bookResponse = () => json({ error: 'slot_taken' }, 409);
        render(<App />);
        await user.click(await screen.findByRole('button', { name: 'Request a time at Arogya Family Clinic' }));
        const dialog = await screen.findByRole('dialog');
        await user.click(await within(dialog).findByRole('button', { name: '9:30 am' }));
        await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
        await user.type(within(dialog).getByLabelText('Patient’s name'), 'Ravi');
        await user.type(within(dialog).getByLabelText('Phone number'), '9876543210');
        await user.click(within(dialog).getByRole('checkbox'));
        await user.click(within(dialog).getByRole('button', { name: 'Send request' }));
        expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'Someone has just asked for that time. Please pick another.');
        await waitFor(() => expect(within(dialog).getByRole('heading', { name: 'Choose a time' })).toBeTruthy());
    });

    it('shows a request status from the reference in the link', async () => {
        window.history.replaceState(null, '', '/booking/7k3p9qxa2b4m');
        render(<App />);
        expect(await screen.findByText('Accepted')).toBeTruthy();
        expect(screen.getByText(/Arogya Family Clinic has accepted your request/)).toBeTruthy();
        expect(vi.mocked(fetch)).toHaveBeenCalledWith('/api/booking/7K3P9QXA2B4M', expect.anything());
    });
});
