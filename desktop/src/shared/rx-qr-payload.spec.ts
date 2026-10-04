import { describe, expect, it } from 'vitest';
import QRCode from 'qrcode';
import { decodeRxQr, encodeRxQr, RX_QR_CHAR_LIMIT } from './rx-qr-payload';

const input = {
    patient: { name: 'John Doe', age: 35, gender: 'Male' },
    doctor: { name: 'Dr. Smith', license_number: 'MED12345' },
    date: '2026-01-15T10:00:00Z',
    diagnosis: 'Common Cold',
    lines: [
        { medicine: 'Paracetamol (Crocin)', dosage: '500mg', route: 'Oral', frequency: '1-0-1', duration: '5 days', instruction: 'After food' },
        { medicine: 'Cetirizine', dosage: '10mg', route: 'Oral', frequency: '0-0-1', duration: '3 days', instruction: 'Before sleep' }
    ]
};

describe('rx-qr-payload', () => {
    it('round-trips a typical prescription through deflate', () => {
        const encoded = encodeRxQr(input);
        expect(encoded.startsWith('ND1.')).toBe(true);
        expect(encoded.length).toBeLessThan(RX_QR_CHAR_LIMIT);
        const decoded = decodeRxQr(encoded) as any;
        expect(decoded.app).toBe('ND-Rx');
        expect(decoded.v).toBe(1);
        expect(decoded.p[0]).toBe('John Doe');
        expect(decoded.rx).toHaveLength(2);
        expect(decoded.rx[0][0]).toBe('Paracetamol (Crocin)');
        expect(decoded.rx[0][2]).toBe('Oral');
    });

    it('renders through the real QR encoder within capacity', async () => {
        const encoded = encodeRxQr(input);
        const url = await QRCode.toDataURL(encoded, { width: 132, margin: 1 });
        expect(url.startsWith('data:image/png')).toBe(true);
    });

    it('round-trips payloads whose base64 needs padding stripped', () => {
        const encoded = encodeRxQr({ ...input, patient: { name: 'Al' } });
        expect(encoded.endsWith('=')).toBe(false);
        const decoded = decodeRxQr(encoded) as any;
        expect(decoded.p[0]).toBe('Al');
    });

    it('rejects foreign codes and oversized payloads', () => {
        expect(() => decodeRxQr('HELLO')).toThrow('Not a NalamDesk prescription code');
        const big = {
            ...input,
            lines: Array.from({ length: 400 }, (_, i) => ({
                medicine: `Medicine ${i} ${Buffer.from(String(i * 7919)).toString('base64')}${'x'.repeat(i % 37)}`,
                dosage: `${100 + i}mg-${'y'.repeat(i % 43)}`,
                frequency: '1-1-1', duration: '30 days', instruction: `Instruction set ${i}-${'z'.repeat(i % 29)}`
            }))
        };
        expect(() => encodeRxQr(big)).toThrow('too large for QR');
    });

    it('refuses inflate bombs that expand past the accepted limit', () => {
        // Crafted tiny payload expanding beyond 64KB: still decodes structurally,
        // but the guard must fire before JSON.parse sees it.
        const huge = 'a'.repeat(70000);
        const { deflateSync, strToU8 } = require('fflate') as typeof import('fflate');
        const bytes = deflateSync(strToU8(JSON.stringify({ app: 'ND-Rx', v: 1, p: [huge], rx: [] })));
        let binary = '';
        for (const byte of bytes) binary += String.fromCodePoint(byte);
        let out = btoa(binary).replaceAll('+', '-').replaceAll('/', '_');
        while (out.endsWith('=')) out = out.slice(0, -1);
        expect(() => decodeRxQr('ND1.' + out)).toThrow('beyond the accepted limit');
    });
});
