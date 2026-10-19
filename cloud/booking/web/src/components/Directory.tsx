import { useEffect, useId, useMemo, useState } from 'react';
import { ApiError, listClinics, type ClinicSummary } from '../lib/api';
import { BookingDialog } from './BookingDialog';

type Load = { state: 'loading' } | { state: 'ready'; clinics: ClinicSummary[] } | { state: 'failed'; offline: boolean };

export function matchesQuery(clinic: ClinicSummary, query: string): boolean {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const haystack = `${clinic.name} ${clinic.city} ${clinic.specialty}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
}

export function Directory() {
    const [load, setLoad] = useState<Load>({ state: 'loading' });
    const [query, setQuery] = useState('');
    const [chosen, setChosen] = useState<ClinicSummary | null>(null);
    const searchId = useId();
    const countId = useId();

    const fetchClinics = () => {
        setLoad({ state: 'loading' });
        listClinics()
            .then((clinics) => setLoad({ state: 'ready', clinics }))
            .catch((error) => setLoad({ state: 'failed', offline: error instanceof ApiError && error.code === 'offline' }));
    };
    useEffect(fetchClinics, []);

    const shown = useMemo(
        () => (load.state === 'ready' ? load.clinics.filter((clinic) => matchesQuery(clinic, query)) : []),
        [load, query]
    );

    return (
        <>
            <section aria-labelledby="intro" className="pt-6 pb-8 sm:pt-12">
                <h1 id="intro" className="max-w-[18ch] text-display leading-[1.08] font-medium tracking-tight sm:text-display-lg">
                    Ask your clinic for a time.
                </h1>
                <p className="mt-4 max-w-[52ch] text-lg text-ink-soft">
                    Pick a slot or ask for a call back. The clinic phones you to confirm, so nothing is booked until you have spoken to them.
                </p>

                <div className="mt-8 max-w-xl">
                    <label htmlFor={searchId} className="label">Clinic, city or specialty</label>
                    <input
                        id={searchId}
                        type="search"
                        className="field text-lg"
                        placeholder="For example: Chennai, or child care"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        aria-describedby={countId}
                        autoComplete="off"
                        enterKeyHint="search"
                    />
                </div>
            </section>

            <section aria-label="Clinics">
                <p id={countId} className="mb-3 text-sm text-muted" aria-live="polite">
                    {load.state === 'ready' && (shown.length === 1 ? '1 clinic' : `${shown.length} clinics`)}
                </p>

                {load.state === 'loading' && <p className="py-10 text-ink-soft" role="status">Loading clinics…</p>}

                {load.state === 'failed' && (
                    <div role="alert" className="rounded-[10px] bg-danger-wash px-4 py-4 text-danger">
                        <p className="font-semibold">{load.offline ? 'You seem to be offline.' : 'The clinic list did not load.'}</p>
                        <button type="button" className="btn-quiet mt-1 min-h-[44px] font-semibold" onClick={fetchClinics}>Try again</button>
                    </div>
                )}

                {load.state === 'ready' && shown.length === 0 && (
                    <div className="border-t border-line py-10">
                        <p className="font-semibold">
                            {load.clinics.length === 0 ? 'No clinics take online requests yet.' : `No clinic matches “${query.trim()}”.`}
                        </p>
                        <p className="mt-1 text-ink-soft">
                            {load.clinics.length === 0 ? 'Clinics appear here once they turn on online booking in NalamDesk.' : 'Try the town name or a shorter word.'}
                        </p>
                    </div>
                )}

                {shown.length > 0 && (
                    <ul className="divide-y divide-line border-y border-line">
                        {shown.map((clinic) => (
                            <li key={clinic.clinicId} className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center sm:justify-between">
                                <div className="min-w-0">
                                    <h2 className="text-title leading-snug font-semibold">{clinic.name}</h2>
                                    <p className="mt-0.5 text-ink-soft">{clinic.specialty} · {clinic.city}</p>
                                    <Presence online={clinic.online} />
                                </div>
                                <button type="button" className="btn btn-primary shrink-0 self-start sm:self-center" onClick={() => setChosen(clinic)}>
                                    Request a time<span className="sr-only"> at {clinic.name}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            {chosen && <BookingDialog clinic={chosen} onClose={() => setChosen(null)} />}
        </>
    );
}

function Presence({ online }: { online: boolean }) {
    return (
        <p className="mt-2 flex items-center gap-2 text-sm">
            <span aria-hidden="true" className={`inline-block size-2 rounded-full ${online ? 'bg-leaf' : 'bg-[#9aa0ab]'}`} />
            {online
                ? <span className="font-semibold text-leaf">Open on NalamDesk now</span>
                : <span className="text-muted">Offline now. They will see your request when they next open.</span>}
        </p>
    );
}
