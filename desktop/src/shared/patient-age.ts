/**
 * Durable demographics: derive display age from date of birth instead of the
 * mutable stored `age`, which goes stale. Unknown DOB (null) falls back to
 * the stored age; estimated DOB is flagged so charts read "≈42" honestly.
 */

export interface DerivedAge {
    /** Completed years, or null when neither DOB nor stored age exists. */
    years: number | null;
    /** True when the DOB itself was recorded as approximate. */
    estimated: boolean;
    /** Chart-ready label, e.g. "42", "≈42", or "—". */
    label: string;
}

export function deriveAge(
    dob: string | null | undefined,
    dobEstimated: boolean | number | null | undefined,
    storedAge: number | null | undefined,
    now: Date = new Date()
): DerivedAge {
    const estimated = !!dobEstimated;
    if (dob) {
        const born = new Date(String(dob).slice(0, 10) + 'T00:00:00');
        if (!Number.isNaN(born.getTime()) && born.getTime() <= now.getTime()) {
            let years = now.getFullYear() - born.getFullYear();
            const hadBirthday =
                now.getMonth() > born.getMonth() ||
                (now.getMonth() === born.getMonth() && now.getDate() >= born.getDate());
            if (!hadBirthday) years -= 1;
            if (years >= 0) {
                return { years, estimated, label: estimated ? `≈${years}` : `${years}` };
            }
        }
    }
    if (storedAge != null && Number.isFinite(Number(storedAge))) {
        return { years: Number(storedAge), estimated: false, label: `${Number(storedAge)}` };
    }
    return { years: null, estimated: false, label: '—' };
}
