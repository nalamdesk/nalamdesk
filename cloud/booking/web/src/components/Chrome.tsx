import { onLinkClick } from '../navigation';

export function SiteHeader() {
    return (
        <header className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-5 py-5 sm:px-8">
            <a href="/" onClick={onLinkClick('/')} className="flex items-baseline gap-2 rounded-[6px]">
                <span className="font-display text-2xl font-semibold tracking-tight text-ink">NalamDesk</span>
                <span className="text-sm text-muted">Clinic booking</span>
            </a>
            <a href="/booking" onClick={onLinkClick('/booking')} className="rounded-[6px] text-[0.9375rem] font-semibold text-brand-deep underline underline-offset-4">
                Check a request
            </a>
        </header>
    );
}

export function SiteFooter() {
    return (
        <footer className="border-t border-line">
            <div className="mx-auto max-w-3xl px-5 py-8 text-sm text-muted sm:px-8 [&>p]:max-w-[54ch]">
                <p>
                    Your name, phone number and reason are locked to the clinic you choose before they leave this device.
                    NalamDesk passes on only that locked copy and deletes it after 48 hours if the clinic has not collected it.
                </p>
                <p className="mt-3">© 2026 NalamDesk Health Platform</p>
            </div>
        </footer>
    );
}
