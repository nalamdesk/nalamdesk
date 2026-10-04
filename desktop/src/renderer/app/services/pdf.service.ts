
import { Injectable } from '@angular/core';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { formatRxMedicineName } from '../../../shared/rx-label';

@Injectable({
    providedIn: 'root'
})
export class PdfService {

    async generatePrescription(visit: any, patient: any, doctor: any) {
        const doc = new jsPDF();

        // Header
        doc.setFontSize(22);
        doc.setTextColor(40);
        doc.text(doctor.name || 'NalamDesk Clinic', 14, 20);

        doc.setFontSize(10);
        doc.setTextColor(100);
        doc.text(doctor.specialty || 'General Practice', 14, 26);
        doc.text(`License: ${doctor.license_number || 'N/A'}`, 14, 30);

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

        // Footer
        const finalY = (doc as any).lastAutoTable.finalY + 30;
        doc.text('Doctor Signature', 150, finalY);

        // Save
        doc.save(`Prescription-${patient.name}-${new Date().toISOString().split('T')[0]}.pdf`);
    }
}
