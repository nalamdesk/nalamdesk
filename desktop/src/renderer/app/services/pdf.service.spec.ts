/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Hoist the mock object so it's accessible in both factory and tests
const { mockDoc, mockAutoTable, mockQrCode } = vi.hoisted(() => {
    const doc = {
        setFontSize: vi.fn(),
        setTextColor: vi.fn(),
        text: vi.fn(),
        setDrawColor: vi.fn(),
        line: vi.fn(),
        save: vi.fn(),
        addImage: vi.fn(),
        addPage: vi.fn(),
        lastAutoTable: { finalY: 100 }
    };
    return {
        mockDoc: doc,
        mockAutoTable: vi.fn(),
        mockQrCode: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,QR') }
    };
});

// Mock jsPDF and autoTable
vi.mock('jspdf', () => {
    return {
        default: class {
            constructor() {
                return mockDoc;
            }
        }
    };
});

vi.mock('jspdf-autotable', () => ({
    default: mockAutoTable
}));

vi.mock('qrcode', () => ({
    default: mockQrCode
}));

import { PdfService } from './pdf.service';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

describe('PdfService', () => {
    let service: PdfService;

    beforeEach(() => {
        service = new PdfService();
        vi.clearAllMocks();
        // Reset properties if needed
        mockDoc.lastAutoTable.finalY = 100;
        // mockDoc methods are spies, clearAllMocks clears them
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('generatePrescription', () => {
        const mockVisit = {
            date: '2026-01-15T10:00:00Z',
            diagnosis: 'Common Cold',
            prescription: [
                { medicine: 'Paracetamol', dosage: '500mg', frequency: '3x/day', duration: '5 days', instruction: 'After food' },
                { medicine: 'Cough Syrup', dosage: '5ml', frequency: '2x/day', duration: '3 days', instruction: 'Before sleep' }
            ]
        };

        const mockPatient = {
            name: 'John Doe',
            age: 35,
            gender: 'Male'
        };

        const mockDoctor = {
            name: 'Dr. Smith',
            specialty: 'General Medicine',
            license_number: 'MED12345'
        };

        it('should create a new jsPDF document', async () => {
            // We can't easily spy on constructor, but we can verify methods are called on the instance
            await service.generatePrescription(mockVisit, mockPatient, mockDoctor);
            // expect(jsPDF).toHaveBeenCalled(); // Removed as it's a class now
            expect(mockDoc.setFontSize).toHaveBeenCalled();
        });

        it('should set doctor header info', async () => {
            await service.generatePrescription(mockVisit, mockPatient, mockDoctor);
            expect(mockDoc.text).toHaveBeenCalledWith('Dr. Smith', 14, 20);
            expect(mockDoc.text).toHaveBeenCalledWith('General Medicine', 14, 26);
            expect(mockDoc.text).toHaveBeenCalledWith('License: MED12345', 14, 30);
        });

        it('should use fallback values for missing doctor info', async () => {
            await service.generatePrescription(mockVisit, mockPatient, {});
            expect(mockDoc.text).toHaveBeenCalledWith('NalamDesk Clinic', 14, 20);
            expect(mockDoc.text).toHaveBeenCalledWith('General Practice', 14, 26);
            expect(mockDoc.text).toHaveBeenCalledWith('License: N/A', 14, 30);
        });

        it('should add patient info', async () => {
            await service.generatePrescription(mockVisit, mockPatient, mockDoctor);
            expect(mockDoc.text).toHaveBeenCalledWith('Patient: John Doe', 14, 45);
            expect(mockDoc.text).toHaveBeenCalledWith('Age/Gender: 35 / Male', 14, 50);
        });

        it('should add diagnosis', async () => {
            await service.generatePrescription(mockVisit, mockPatient, mockDoctor);
            expect(mockDoc.text).toHaveBeenCalledWith('Diagnosis:', 14, 65);
            expect(mockDoc.text).toHaveBeenCalledWith('Common Cold', 14, 70);
        });

        it('should use "Review" as fallback when diagnosis is missing', async () => {
            await service.generatePrescription({ ...mockVisit, diagnosis: '' }, mockPatient, mockDoctor);
            expect(mockDoc.text).toHaveBeenCalledWith('Review', 14, 70);
        });

        it('should call autoTable with prescription data', async () => {
            await service.generatePrescription(mockVisit, mockPatient, mockDoctor);
            expect(mockAutoTable).toHaveBeenCalled(); // Check autoTable mock directly
            const atCall = (mockAutoTable as any).mock.calls[0];
            expect(atCall[1].body.length).toBe(2);
            expect(atCall[1].body[0][0]).toBe('Paracetamol');
            expect(atCall[1].head[0]).toEqual(['Medicine', 'Dosage', 'Frequency', 'Duration', 'Instruction']);
        });

        it('should print GENERIC (Brand) when the line carries both', async () => {
            const visit = {
                ...mockVisit,
                prescription: [
                    { medicine: 'Crocin 500', generic_name: 'Paracetamol', brand_name: 'Crocin', dosage: '500mg', frequency: '1-0-1', duration: '3 days', instruction: 'After food' },
                    { medicine: 'Local mixture', dosage: '5ml', frequency: '2x/day', duration: '3 days', instruction: 'Before sleep' }
                ]
            };
            await service.generatePrescription(visit, mockPatient, mockDoctor);
            const atCall = (mockAutoTable as any).mock.calls[0];
            expect(atCall[1].body[0][0]).toBe('Paracetamol (Crocin)');
            expect(atCall[1].body[1][0]).toBe('Local mixture');
        });

        it('embeds a scannable QR with the encoded prescription', async () => {
            await service.generatePrescription(mockVisit, mockPatient, mockDoctor);
            expect(mockQrCode.toDataURL).toHaveBeenCalled();
            const qrText = mockQrCode.toDataURL.mock.calls[0][0] as string;
            expect(qrText.startsWith('ND1.')).toBe(true);
            expect(mockDoc.addImage).toHaveBeenCalledWith(
                'data:image/png;base64,QR', 'PNG', 14, expect.any(Number), 32, 32);
        });

        it('skips the QR when the payload exceeds the byte cap', async () => {
            const big = {
                ...mockVisit,
                prescription: Array.from({ length: 400 }, (_, i) => ({
                    medicine: `Medicine ${i} ${Buffer.from(String(i * 7919)).toString('base64')}${'x'.repeat(i % 37)}`,
                    dosage: `${100 + i}mg-${'y'.repeat(i % 43)}`, frequency: '1-1-1', duration: '30 days',
                    instruction: `Instruction set ${i}-${'z'.repeat(i % 29)}`
                }))
            };
            mockDoc.addImage.mockClear();
            await service.generatePrescription(big, mockPatient, mockDoctor);
            expect(mockDoc.addImage).not.toHaveBeenCalled();
        });

        it('spills the whole footer block onto a fresh page near the bottom margin', async () => {
            mockDoc.lastAutoTable.finalY = 270;
            mockDoc.addPage.mockClear();
            mockDoc.addImage.mockClear();
            await service.generatePrescription(mockVisit, mockPatient, mockDoctor);
            expect(mockDoc.addPage).toHaveBeenCalled();
            expect(mockDoc.addImage).toHaveBeenCalledWith(
                'data:image/png;base64,QR', 'PNG', 14, 22, 32, 32);
            mockDoc.lastAutoTable.finalY = 100;
        });

        it('should handle empty prescription array', async () => {
            await service.generatePrescription({ ...mockVisit, prescription: [] }, mockPatient, mockDoctor);
            expect(mockAutoTable).toHaveBeenCalled();
            const atCall = (mockAutoTable as any).mock.calls[0];
            expect(atCall[1].body.length).toBe(0);
        });

        it('should handle null prescription', async () => {
            await service.generatePrescription({ ...mockVisit, prescription: null }, mockPatient, mockDoctor);
            expect(mockAutoTable).toHaveBeenCalled();
            const atCall = (mockAutoTable as any).mock.calls[0];
            expect(atCall[1].body.length).toBe(0);
        });

        it('should save the PDF with patient name', async () => {
            await service.generatePrescription(mockVisit, mockPatient, mockDoctor);
            expect(mockDoc.save).toHaveBeenCalledWith(expect.stringContaining('Prescription-John Doe-'));
        });

        it('should draw a separator line', async () => {
            await service.generatePrescription(mockVisit, mockPatient, mockDoctor);
            expect(mockDoc.line).toHaveBeenCalledWith(14, 35, 196, 35);
        });
    });
});
