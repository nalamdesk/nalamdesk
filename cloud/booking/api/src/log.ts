// Metadata-only request log, as in the relay. The shape is fixed so a body,
// a phone digest or a sealed envelope can never be added by accident.
export interface BookingLogEntry {
    route: 'clinics' | 'slots' | 'book' | 'status' | 'clinic';
    /** Route template, never a caller-supplied value. */
    path: string;
    clinicId?: string;
    status: number;
    ms: number;
    /** Short machine code for refusals, such as `slot_taken`. */
    code?: string;
}

export type BookingLogger = (entry: BookingLogEntry) => void;

export const stdoutLogger: BookingLogger = (entry) => {
    process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
};
