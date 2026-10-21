import { Injectable } from '@angular/core';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { formatRxMedicineName } from '../../../shared/rx-label';
import { encodeRxQr } from '../../../shared/rx-qr-payload';

/** What `recordPrescriptionPrint` returns: the stored order as it goes on paper. */
export interface PrintedPrescriptionOrder {
    rx_number: string;
    version: number;
    replaces_rx_number?: string | null;
    authored_at: string;
    copy_number: number;
    printed_at?: string;
    clinic: { name?: string; hfr_id?: string };
    requester: { name?: string; license_number?: string; specialty?: string; hpr_id?: string };
    patient: { name?: string; age?: number | string | null; gender?: string; mobile?: string; mrn?: string };
    visit: { id?: number; date?: string; diagnosis?: string };
    items: any[];
}

@Injectable({
    providedIn: 'root'
})
export class PdfService {

    /**
     * Prints the screen's prescription. Used before the visit is finished
     * (`provisional`) and for visits from before orders existed: neither
     * has an order number, so the paper says so.
     */
    async generatePrescription(visit: any, patient: any, doctor: any, options: { provisional?: boolean } = {}) {
        const doc = new jsPDF();

        // Header
        doc.setFontSize(22);
        doc.setTextColor(40);
        doc.text(doctor.name || 'NalamDesk Clinic', 14, 20);

        doc.setFontSize(10);
        doc.setTextColor(100);
        doc.text(doctor.specialty || 'General Practice', 14, 26);
        doc.text(`License: ${doctor.license_number || 'N/A'}`, 14, 30);
        if (options.provisional) {
            doc.setTextColor(180, 0, 0);
            doc.text('PROVISIONAL: finish the visit to issue the prescription', 196, 26, { align: 'right' });
        }

        // Line
        doc.setDrawColor(200);
        doc.line(14, 35, 196, 35);

        // Patient Info
        doc.setFontSize(12);
        doc.setTextColor(0);
        doc.text(`Patient: ${patient.name}`, 14, 45);
        doc.text(`Age/Gender: ${patient.age} / ${patient.gender}`, 14, 50);
        doc.text(`Date: ${new Date(visit.date).toLocaleDateString()}`, 150, 45);

        // Diagnosis
        doc.text('Diagnosis:', 14, 65);
        doc.setFontSize(10);
        doc.text(visit.diagnosis || 'Review', 14, 70);

        // Rx Table: NMC generic-first labeling, GENERIC (Brand).
        const data = (visit.prescription || []).map((p: any) => [
            formatRxMedicineName(p),
            p.dosage,
            p.frequency,
            p.duration,
            p.instruction
        ]);

        autoTable(doc, {
            startY: 80,
            head: [['Medicine', 'Dosage', 'Frequency', 'Duration', 'Instruction']],
            body: data,
            theme: 'grid',
            headStyles: { fillColor: [66, 66, 66] }
        });

        await this.signatureAndQr(doc, {
            patient, doctor, date: visit.date, diagnosis: visit.diagnosis, lines: visit.prescription || []
        });

        // Save
        doc.save(`Prescription-${patient.name}-${new Date().toISOString().split('T')[0]}.pdf`);
    }

    /**
     * Prints a stored prescription order (#20): clinic, prescriber and
     * patient identity, the order number and version, and every line with
     * its quantity. Copies after the first are marked as copies.
     */
    async generateOrderPrescription(order: PrintedPrescriptionOrder) {
        const doc = new jsPDF();
        const requester = order.requester || {};
        const patient = order.patient || {};

        doc.setFontSize(18);
        doc.setTextColor(40);
        doc.text(order.clinic?.name || 'NalamDesk Clinic', 14, 18);
        doc.setFontSize(9);
        doc.setTextColor(100);
        if (order.clinic?.hfr_id) doc.text(`Facility ID (HFR): ${order.clinic.hfr_id}`, 14, 23);

        doc.setFontSize(12);
        doc.setTextColor(0);
        doc.text(requester.name || 'Doctor', 14, 31);
        doc.setFontSize(9);
        doc.setTextColor(100);
        doc.text([requester.specialty, `Reg. No: ${requester.license_number || 'N/A'}`, requester.hpr_id ? `HPR: ${requester.hpr_id}` : '']
            .filter(Boolean).join('  |  '), 14, 36);

        doc.setFontSize(10);
        doc.setTextColor(0);
        doc.text(`Rx No: ${order.rx_number}${order.version > 1 ? ` (version ${order.version})` : ''}`, 196, 18, { align: 'right' });
        doc.text(`Date: ${new Date(order.authored_at).toLocaleDateString()}`, 196, 23, { align: 'right' });
        if (order.replaces_rx_number) {
            doc.setFontSize(9);
            doc.text(`Replaces ${order.replaces_rx_number}`, 196, 28, { align: 'right' });
        }
        if (order.copy_number > 1) {
            doc.setFontSize(10);
            doc.setTextColor(180, 0, 0);
            doc.text(`COPY ${order.copy_number - 1}: reprint of ${order.rx_number}`, 196, 33, { align: 'right' });
        }

        doc.setDrawColor(200);
        doc.line(14, 40, 196, 40);

        doc.setFontSize(11);
        doc.setTextColor(0);
        doc.text(`Patient: ${patient.name || ''}`, 14, 48);
        doc.text(`Age/Gender: ${patient.age ?? ''} / ${patient.gender || ''}`, 14, 54);
        if (patient.mrn) doc.text(`MRN: ${patient.mrn}`, 120, 48);
        if (patient.mobile) doc.text(`Mobile: ${patient.mobile}`, 120, 54);

        doc.text('Diagnosis:', 14, 64);
        doc.setFontSize(10);
        doc.text(order.visit?.diagnosis || 'Review', 14, 69);

        const items = order.items || [];
        autoTable(doc, {
            startY: 76,
            head: [['#', 'Medicine', 'Dose', 'Route', 'Frequency', 'Duration', 'Qty', 'Instruction']],
            body: items.map((line: any, i: number) => [
                String(i + 1),
                formatRxMedicineName(line),
                line.dosage,
                line.route,
                line.frequency,
                line.duration,
                line.quantity != null ? `${line.quantity} ${line.quantity_unit || ''}`.trim() : '',
                [line.instruction, Number(line.refills) > 0 ? `Refills: ${line.refills}` : ''].filter(Boolean).join('. ')
            ]),
            theme: 'grid',
            headStyles: { fillColor: [66, 66, 66] }
        });

        await this.signatureAndQr(doc, {
            patient, doctor: requester, date: order.authored_at, diagnosis: order.visit?.diagnosis, lines: items
        });

        doc.save(`Prescription-${order.rx_number}${order.copy_number > 1 ? `-copy${order.copy_number - 1}` : ''}.pdf`);
    }

    /**
     * Signature right, scannable prescription QR left. Both travel
     * together: if the table leaves no room, the whole footer block spills
     * to a fresh page so the QR never detaches from its signature.
     */
    private async signatureAndQr(doc: jsPDF, input: { patient: any; doctor: any; date: any; diagnosis?: string; lines: any[] }) {
        let footerY = (doc as any).lastAutoTable.finalY + 30;
        if (footerY + 40 > 287) {
            doc.addPage();
            footerY = 50;
        }
        doc.setFontSize(10);
        doc.setTextColor(0);
        doc.text('Doctor Signature', 150, footerY);
        try {
            const qrText = encodeRxQr({
                patient: { name: input.patient?.name, age: input.patient?.age, gender: input.patient?.gender },
                doctor: { name: input.doctor?.name, license_number: input.doctor?.license_number },
                date: input.date instanceof Date ? input.date.toISOString() : input.date,
                diagnosis: input.diagnosis,
                lines: (input.lines || []).map((p: any) => ({
                    medicine: formatRxMedicineName(p),
                    dosage: p.dosage,
                    route: p.route,
                    frequency: p.frequency,
                    duration: p.duration,
                    instruction: p.instruction
                }))
            });
            const { default: QRCode } = await import('qrcode');
            const qrUrl = await QRCode.toDataURL(qrText, { width: 132, margin: 1 });
            const qrY = footerY - 28;
            doc.addImage(qrUrl, 'PNG', 14, qrY, 32, 32);
            doc.setFontSize(8);
            doc.setTextColor(100);
            doc.text('Scan for digital prescription', 14, qrY + 36);
        } catch (e) {
            console.warn('Prescription QR skipped:', e instanceof Error ? e.message : e);
        }
    }
}
