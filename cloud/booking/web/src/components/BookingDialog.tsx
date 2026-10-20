import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { ApiError, listSlots, submitBooking, type ClinicSummary, type OpenSlot } from '../lib/api';
import {
    formatReference,
    NAME_MAX,
    newReference,
    normalisePhone,
    phoneDigest,
    REASON_MAX,
    type BookingPayload
} from '../lib/booking';
import { seal } from '../lib/seal';
import { onLinkClick } from '../navigation';

type Step = 'time' | 'details' | 'sent';
type SlotLoad = { state: 'loading' } | { state: 'ready'; slots: OpenSlot[] } | { state: 'failed' };
/** A chosen slot, or `callback` for "call me back about any time". */
type Choice = OpenSlot | 'callback' | null;

const IST_OFFSET_MS = 330 * 60 * 1000;
const istToday = () => new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);

export function dayLabel(date: string, today = istToday()): string {
    const d = new Date(`${date}T00:00:00Z`);
    const tomorrow = new Date(`${today}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const dayMonth = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d);
    if (date === today) return `Today, ${dayMonth}`;
    if (date === tomorrow.toISOString().slice(0, 10)) return `Tomorrow, ${dayMonth}`;
    return new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d);
}

/** `4:30 pm on Mon, 20 Oct`, for sentences. */
export function slotSentence(date: string, time: string): string {
    const d = new Date(`${date}T00:00:00Z`);
    return `${timeLabel(time)} on ${new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d)}`;
}

export function timeLabel(time: string): string {
    const [h, m] = time.split(':').map(Number) as [number, number];
    const suffix = h < 12 ? 'am' : 'pm';
    return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${suffix}`;
}

function describeError(error: unknown): string {
    if (!(error instanceof ApiError)) return 'Something went wrong while locking your details. Please try again.';
    switch (error.code) {
        case 'offline': return 'You seem to be offline. Your request was not sent.';
        case 'slot_taken': return 'Someone has just asked for that time. Please pick another.';
        case 'unknown_slot': return 'That time is no longer offered. Please pick another.';
        case 'too_many_open_requests': return 'This phone number already has two requests waiting at this clinic. Please wait for the clinic to call you.';
        case 'unknown_clinic': return 'This clinic has stopped taking online requests.';
        case 'clinic_unavailable': return 'This clinic is setting up a new computer and cannot take online requests yet. Please try again later.';
        default: return 'The request did not go through. Please try again in a moment.';
    }
}

export function BookingDialog({ clinic, onClose }: { clinic: ClinicSummary; onClose: () => void }) {
    const dialogRef = useRef<HTMLDialogElement>(null);
    const titleId = useId();
    const [step, setStep] = useState<Step>('time');
    const [slots, setSlots] = useState<SlotLoad>({ state: 'loading' });
    const [day, setDay] = useState<string | null>(null);
    const [choice, setChoice] = useState<Choice>(null);
    const [error, setError] = useState<string | null>(null);
    const [sentRef, setSentRef] = useState<string | null>(null);

    // No close() on cleanup: closing fires `close`, which would unmount the
    // dialog during StrictMode's effect replay. Unmounting removes it anyway.
    useEffect(() => {
        const dialog = dialogRef.current;
        if (dialog && !dialog.open) dialog.showModal?.();
    }, []);

    const loadSlots = () => {
        setSlots({ state: 'loading' });
        listSlots(clinic.clinicId)
            .then((list) => {
                setSlots({ state: 'ready', slots: list });
                setDay((current) => (current && list.some((s) => s.date === current) ? current : list[0]?.date ?? null));
            })
            .catch(() => setSlots({ state: 'failed' }));
    };
    useEffect(loadSlots, [clinic.clinicId]);

    const days = useMemo(() => {
        if (slots.state !== 'ready') return [];
        return [...new Set(slots.slots.map((s) => s.date))];
    }, [slots]);
    const times = slots.state === 'ready' ? slots.slots.filter((s) => s.date === day) : [];

    const close = () => {
        dialogRef.current?.close?.();
        onClose();
    };

    return (
        <dialog
            ref={dialogRef}
            aria-labelledby={titleId}
            onClose={onClose}
            onCancel={(event) => {
                event.preventDefault();
                close();
            }}
            className="m-0 max-h-none w-full max-w-none bg-surface p-0 text-ink max-sm:h-dvh sm:m-auto sm:max-h-[90dvh] sm:max-w-lg sm:rounded-[10px] sm:shadow-xl"
        >
            <div className="flex h-full max-h-[inherit] flex-col">
                <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
                    <div className="min-w-0">
                        <h2 id={titleId} className="text-headline leading-tight font-semibold">{clinic.name}</h2>
                        <p className="text-sm text-ink-soft">{clinic.specialty} · {clinic.city}</p>
                    </div>
                    <button type="button" onClick={close} className="btn -mr-2 -mt-1 px-3 text-ink-soft" aria-label="Close">
                        <svg aria-hidden="true" viewBox="0 0 20 20" className="size-5"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto px-5 py-5">
                    {error && (
                        <p role="alert" className="mb-4 rounded-[6px] bg-danger-wash px-3 py-2.5 text-danger">{error}</p>
                    )}

                    {step === 'time' && (
                        <TimeStep
                            slots={slots}
                            days={days}
                            day={day}
                            times={times}
                            choice={choice}
                            onDay={setDay}
                            onChoose={setChoice}
                            onRetry={loadSlots}
                            onContinue={() => {
                                setError(null);
                                setStep('details');
                            }}
                        />
                    )}

                    {step === 'details' && choice && (
                        <DetailsStep
                            clinic={clinic}
                            choice={choice}
                            onBack={() => {
                                setError(null);
                                setStep('time');
                            }}
                            onError={(err) => {
                                setError(describeError(err));
                                if (err instanceof ApiError && (err.code === 'slot_taken' || err.code === 'unknown_slot')) {
                                    setChoice(null);
                                    setStep('time');
                                    loadSlots();
                                }
                            }}
                            onSent={(ref) => {
                                setError(null);
                                setSentRef(ref);
                                setStep('sent');
                            }}
                        />
                    )}

                    {step === 'sent' && sentRef && <SentStep clinic={clinic} choice={choice} ref_={sentRef} onDone={close} />}
                </div>
            </div>
        </dialog>
    );
}

function TimeStep(props: {
    slots: SlotLoad;
    days: string[];
    day: string | null;
    times: OpenSlot[];
    choice: Choice;
    onDay: (day: string) => void;
    onChoose: (choice: Choice) => void;
    onRetry: () => void;
    onContinue: () => void;
}) {
    const { slots, days, day, times, choice } = props;
    return (
        <div>
            <h3 className="text-xl font-semibold">Choose a time</h3>

            {slots.state === 'loading' && <p className="py-8 text-ink-soft" role="status">Loading open times…</p>}
            {slots.state === 'failed' && (
                <p className="py-4">
                    Open times did not load.{' '}
                    <button type="button" className="btn-quiet min-h-[44px] font-semibold" onClick={props.onRetry}>Try again</button>
                </p>
            )}
            {slots.state === 'ready' && days.length === 0 && (
                <p className="py-4 text-ink-soft">The clinic has not put any times online for the next two weeks. You can still ask them to call you.</p>
            )}

            {days.length > 0 && (
                <>
                    <div role="group" aria-label="Day" className="-mx-5 mt-4 flex gap-2 overflow-x-auto px-5 pb-1">
                        {days.map((d) => (
                            <button
                                key={d}
                                type="button"
                                aria-pressed={d === day}
                                onClick={() => props.onDay(d)}
                                className={`min-h-[44px] shrink-0 rounded-[6px] border px-3.5 text-[0.9375rem] font-semibold whitespace-nowrap ${
                                    d === day ? 'border-ink bg-ink text-surface' : 'border-line bg-surface text-ink hover:border-ink-soft'
                                }`}
                            >
                                {dayLabel(d)}
                            </button>
                        ))}
                    </div>
                    <div role="group" aria-label="Time" className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4">
                        {times.map((slot) => {
                            const selected = choice !== 'callback' && choice?.slotId === slot.slotId;
                            return (
                                <button
                                    key={slot.slotId}
                                    type="button"
                                    aria-pressed={selected}
                                    onClick={() => props.onChoose(slot)}
                                    className={`min-h-[44px] rounded-[6px] border text-[0.9375rem] font-semibold tabular-nums ${
                                        selected ? 'border-marigold bg-marigold-wash text-ink ring-2 ring-marigold' : 'border-line bg-surface hover:border-ink-soft'
                                    }`}
                                >
                                    {timeLabel(slot.time)}
                                </button>
                            );
                        })}
                    </div>
                </>
            )}

            {slots.state !== 'loading' && (
                <button
                    type="button"
                    aria-pressed={choice === 'callback'}
                    onClick={() => props.onChoose('callback')}
                    className={`mt-6 flex w-full items-start gap-3 rounded-[6px] border px-4 py-3 text-left ${
                        choice === 'callback' ? 'border-marigold bg-marigold-wash ring-2 ring-marigold' : 'border-line bg-surface hover:border-ink-soft'
                    }`}
                >
                    <span className="font-semibold">No time works? Ask for a call back</span>
                </button>
            )}

            <div className="mt-6 flex justify-end">
                <button type="button" className="btn btn-primary w-full sm:w-auto" disabled={!choice} onClick={props.onContinue}>
                    Continue
                </button>
            </div>
        </div>
    );
}

function DetailsStep(props: {
    clinic: ClinicSummary;
    choice: Exclude<Choice, null>;
    onBack: () => void;
    onError: (error: unknown) => void;
    onSent: (ref: string) => void;
}) {
    const { clinic, choice } = props;
    const ids = { name: useId(), phone: useId(), reason: useId(), consent: useId(), phoneHelp: useId() };
    const [name, setName] = useState('');
    const [phone, setPhone] = useState('');
    const [reason, setReason] = useState('');
    const [consent, setConsent] = useState(false);
    const [touched, setTouched] = useState(false);
    const [sending, setSending] = useState(false);

    const cleanName = name.replace(/\s+/g, ' ').trim();
    const cleanPhone = normalisePhone(phone);
    const nameError = touched && !cleanName ? 'Enter the patient’s name.' : null;
    const phoneError = touched && !cleanPhone ? 'Enter a phone number with 10 to 15 digits.' : null;
    const consentError = touched && !consent ? 'Tick the box so we can send your details to the clinic.' : null;

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setTouched(true);
        if (!cleanName || !cleanPhone || !consent || sending) return;
        setSending(true);
        try {
            const slot = choice === 'callback' ? null : choice;
            let sealingKey = clinic.sealingPublicKey;
            let resealed = false;
            // One retry with a fresh reference covers the 1-in-2^60 collision,
            // and one more resealed to the clinic's current key covers a form
            // opened before the clinic changed computers.
            for (let attempt = 0; ; attempt++) {
                const ref = newReference();
                const payload: BookingPayload = {
                    v: 1,
                    ref,
                    clinicId: clinic.clinicId,
                    slotId: slot?.slotId ?? null,
                    slot: slot ? { date: slot.date, time: slot.time } : null,
                    name: cleanName,
                    phone: cleanPhone,
                    reason: reason.trim(),
                    sentAt: new Date().toISOString()
                };
                const sealed = await seal(new TextEncoder().encode(JSON.stringify(payload)), sealingKey, clinic.clinicId);
                try {
                    await submitBooking({ clinicId: clinic.clinicId, ref, slotId: payload.slotId, phoneDigest: await phoneDigest(cleanPhone), sealed, sealedTo: sealingKey });
                    props.onSent(ref);
                    return;
                } catch (error) {
                    if (attempt === 0 && error instanceof ApiError && error.code === 'ref_taken') continue;
                    const current = error instanceof ApiError ? error.body.sealingPublicKey : undefined;
                    if (!resealed && error instanceof ApiError && error.code === 'clinic_key_changed' && typeof current === 'string') {
                        sealingKey = current;
                        resealed = true;
                        continue;
                    }
                    throw error;
                }
            }
        } catch (error) {
            props.onError(error);
        } finally {
            setSending(false);
        }
    };

    return (
        <form onSubmit={submit} noValidate>
            <div className="flex items-baseline justify-between gap-3 rounded-[6px] bg-paper px-3 py-2.5">
                <p className="font-semibold">
                    {choice === 'callback' ? 'Call back about a time' : `${dayLabel(choice.date)} at ${timeLabel(choice.time)}`}
                </p>
                <button type="button" className="btn-quiet min-h-[44px] shrink-0 text-[0.9375rem] font-semibold" onClick={props.onBack}>Change</button>
            </div>

            <div className="mt-5 space-y-4">
                <div>
                    <label htmlFor={ids.name} className="label">Patient’s name</label>
                    <input
                        id={ids.name}
                        className="field"
                        autoComplete="name"
                        maxLength={NAME_MAX}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        aria-invalid={!!nameError}
                        aria-describedby={nameError ? `${ids.name}-error` : undefined}
                    />
                    {nameError && <p id={`${ids.name}-error`} className="mt-1 text-sm text-danger">{nameError}</p>}
                </div>
                <div>
                    <label htmlFor={ids.phone} className="label">Phone number</label>
                    <input
                        id={ids.phone}
                        className="field tabular-nums"
                        type="tel"
                        inputMode="tel"
                        autoComplete="tel"
                        maxLength={20}
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        aria-invalid={!!phoneError}
                        aria-describedby={`${ids.phoneHelp}${phoneError ? ` ${ids.phone}-error` : ''}`}
                    />
                    <p id={ids.phoneHelp} className="mt-1 text-sm text-muted">The clinic calls this number to confirm.</p>
                    {phoneError && <p id={`${ids.phone}-error`} className="mt-1 text-sm text-danger">{phoneError}</p>}
                </div>
                <div>
                    <label htmlFor={ids.reason} className="label">Reason for the visit <span className="font-normal text-muted">(optional)</span></label>
                    <textarea
                        id={ids.reason}
                        className="field min-h-[88px] resize-y"
                        maxLength={REASON_MAX}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                    />
                </div>
                <div>
                    <div className="flex items-start gap-3">
                        <input
                            id={ids.consent}
                            type="checkbox"
                            className="mt-1 size-5 shrink-0 accent-brand"
                            checked={consent}
                            onChange={(e) => setConsent(e.target.checked)}
                            aria-invalid={!!consentError}
                            aria-describedby={consentError ? `${ids.consent}-error` : undefined}
                        />
                        <label htmlFor={ids.consent} className="text-[0.9375rem] text-ink-soft">
                            I agree to share these details with {clinic.name} so they can contact me. They are locked on this device so only the clinic can read them; NalamBook forwards only the locked copy and deletes it after 48 hours if the clinic has not collected it.
                        </label>
                    </div>
                    {consentError && <p id={`${ids.consent}-error`} className="mt-1 text-sm text-danger">{consentError}</p>}
                </div>
            </div>

            <button type="submit" className="btn btn-primary mt-6 w-full" disabled={sending}>
                {sending ? 'Sending…' : 'Send request'}
            </button>
        </form>
    );
}

function SentStep({ clinic, choice, ref_, onDone }: { clinic: ClinicSummary; choice: Choice; ref_: string; onDone: () => void }) {
    const statusPath = `/booking/${ref_}`;
    return (
        <div role="status">
            <h3 className="text-headline-lg leading-tight font-semibold">Request sent</h3>
            <p className="mt-2 text-ink-soft">
                {clinic.name} will call you to confirm {choice && choice !== 'callback' ? slotSentence(choice.date, choice.time) : 'a time'}.
                {!clinic.online && ' They are offline now, so the call may come once they open.'}
            </p>
            <div className="mt-6 rounded-[6px] border border-line bg-paper px-4 py-4">
                <p className="text-sm text-muted">Your reference</p>
                <p className="mt-1 text-headline-lg font-semibold tracking-[0.12em] tabular-nums">{formatReference(ref_)}</p>
            </div>
            <p className="mt-4 text-[0.9375rem] text-ink-soft">
                Keep it to <a href={statusPath} onClick={(e) => { onDone(); onLinkClick(statusPath)(e); }} className="font-semibold text-brand-deep underline underline-offset-4">check the request</a> later.
            </p>
            <button type="button" className="btn btn-primary mt-6 w-full" onClick={onDone}>Done</button>
        </div>
    );
}
