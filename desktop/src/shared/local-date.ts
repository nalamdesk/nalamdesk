/**
 * Calendar date (YYYY-MM-DD) in the clinic computer's own time zone.
 *
 * `date.toISOString().slice(0, 10)` gives the UTC date, which in India is the
 * previous day until 05:30 local time, and turns a local midnight such as a
 * date-of-birth into the day before. Use this for any "today" or picked date
 * the desk sees.
 */
export function localDateISO(date: Date = new Date()): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}
