import { useEffect, useId, useState, type FormEvent } from 'react';
import { ApiError, bookingStatus, type BookingStatus } from '../lib/api';
import { formatReference, parseReference } from '../lib/booking';
import { navigate } from '../navigation';

type Lookup =
    | { state: 'idle' }
    | { state: 'loading' }
    | { state: 'found'; ref: string; status: BookingStatus; clinicName: string | null }
    | { state: 'missing' }
    | { state: 'failed' };

const MEANING: Record<BookingStatus, { title: string; body: (clinic: string) => string; tone: string }> = {
    Requested: {
        title: 'Waiting for the clinic',
        body: (clinic) => `${clinic} has not answered yet. They will call you once they have looked at it.`,
        tone: 'bg-marigold-wash text-ink'
    },
    Accepted: {
        title: 'Accepted',
        body: (clinic) => `${clinic} has accepted your request. They will call you to confirm the details.`,
        tone: 'bg-[#e3f1e8] text-leaf'
    },
    Declined: {
        title: 'Declined',
        body: (clinic) => `${clinic} could not take this request. You can ask for another time, or call the clinic.`,
        tone: 'bg-danger-wash text-danger'
    }
};

export function StatusPage({ initialRef }: { initialRef: string }) {
    const inputId = useId();
    const [input, setInput] = useState(initialRef ? formatReference(initialRef.toUpperCase()) : '');
    const [lookup, setLookup] = useState<Lookup>({ state: 'idle' });
    const [invalid, setInvalid] = useState(false);

    const check = (raw: string) => {
        const ref = parseReference(raw);
        setInvalid(!ref);
        if (!ref) return;
        setLookup({ state: 'loading' });
        bookingStatus(ref)
            .then((found) => setLookup({ state: 'found', ...found }))
            .catch((error) => setLookup(error instanceof ApiError && error.status === 404 ? { state: 'missing' } : { state: 'failed' }));
    };

    useEffect(() => {
        if (initialRef) check(initialRef);
    }, [initialRef]);

    const submit = (event: FormEvent) => {
        event.preventDefault();
        const ref = parseReference(input);
        if (ref) navigate(`/booking/${ref}`);
        else setInvalid(true);
    };

    return (
        <section aria-labelledby="status-title" className="pt-6 sm:pt-12">
            <h1 id="status-title" className="text-display leading-tight font-medium tracking-tight sm:text-display-lg">Check a request</h1>
            <p className="mt-3 max-w-[52ch] text-lg text-ink-soft">Enter the 12-character reference you got when you sent the request.</p>

            <form onSubmit={submit} className="mt-8 flex max-w-xl flex-col gap-3 sm:flex-row sm:items-end" noValidate>
                <div className="flex-1">
                    <label htmlFor={inputId} className="label">Reference</label>
                    <input
                        id={inputId}
                        className="field text-lg tracking-[0.12em] uppercase tabular-nums"
                        placeholder="XXXX-XXXX-XXXX"
                        autoComplete="off"
                        autoCapitalize="characters"
                        spellCheck={false}
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        aria-invalid={invalid}
                        aria-describedby={invalid ? `${inputId}-error` : undefined}
                    />
                </div>
                <button type="submit" className="btn btn-primary">Check</button>
            </form>
            {invalid && <p id={`${inputId}-error`} className="mt-2 text-sm text-danger">That does not look like a reference. It has 12 letters and numbers.</p>}

            <div className="mt-8 max-w-xl" aria-live="polite">
                {lookup.state === 'loading' && <p className="text-ink-soft">Checking…</p>}
                {lookup.state === 'missing' && (
                    <p className="rounded-[10px] border border-line bg-surface px-4 py-4">
                        We could not find that request. Requests are removed 48 hours after they are sent, so an older one will not show here.
                    </p>
                )}
                {lookup.state === 'failed' && <p role="alert" className="rounded-[10px] bg-danger-wash px-4 py-4 text-danger">The check did not go through. Please try again.</p>}
                {lookup.state === 'found' && (
                    <div className="rounded-[10px] border border-line bg-surface px-5 py-5">
                        <p className="text-sm tracking-[0.12em] text-muted tabular-nums">{formatReference(lookup.ref)}</p>
                        <p className={`mt-3 inline-block rounded-[6px] px-2.5 py-1 font-semibold ${MEANING[lookup.status].tone}`}>{MEANING[lookup.status].title}</p>
                        <p className="mt-3 text-ink-soft">{MEANING[lookup.status].body(lookup.clinicName ?? 'The clinic')}</p>
                    </div>
                )}
            </div>
        </section>
    );
}
