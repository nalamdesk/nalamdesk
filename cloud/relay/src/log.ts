// Metadata-only request log. The shape is fixed so a body, a header value or
// a token can never be added by accident: route, path template, facility,
// status and timing. CloudWatch keeps these for 30 days (set on the stack).
export interface RelayLogEntry {
    route: 'proxy' | 'callback' | 'data-push' | 'health';
    /** Upstream or callback path; data-push tokens are never logged. */
    path: string;
    hipId?: string;
    status: number;
    ms: number;
    /** Short machine code for refusals, such as `path_not_allowed`. */
    code?: string;
}

export type RelayLogger = (entry: RelayLogEntry) => void;

export const stdoutLogger: RelayLogger = (entry) => {
    process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
};
