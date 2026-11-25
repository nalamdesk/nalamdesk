/**
 * Front-desk keyboard shortcuts. Alt (Option on a Mac) + a letter, matched on
 * `event.code` because Option+letter types a symbol into `event.key` on macOS.
 * Plain "/" focuses search and "?" opens the list; both are ignored while the
 * user is typing in a field, and so are the Alt shortcuts when a dialog or
 * modifier other than Alt is involved.
 */
export type ShortcutAction =
    | 'new-patient'
    | 'search-patients'
    | 'go-dashboard'
    | 'go-queue'
    | 'go-patients'
    | 'go-visits'
    | 'go-appointments'
    | 'show-help';

export interface ShortcutInfo {
    keys: string;
    label: string;
}

const ALT_CODES: Record<string, ShortcutAction> = {
    KeyN: 'new-patient',
    KeyF: 'search-patients',
    KeyD: 'go-dashboard',
    KeyQ: 'go-queue',
    KeyP: 'go-patients',
    KeyV: 'go-visits',
    KeyA: 'go-appointments',
};

export function shortcutList(isMac: boolean): ShortcutInfo[] {
    const alt = isMac ? '⌥' : 'Alt+';
    return [
        { keys: `${alt}N`, label: 'Register a new patient' },
        { keys: `/ or ${alt}F`, label: 'Search patients' },
        { keys: `${alt}Q`, label: 'Queue' },
        { keys: `${alt}P`, label: 'Patients' },
        { keys: `${alt}V`, label: 'Visits' },
        { keys: `${alt}A`, label: 'Appointments' },
        { keys: `${alt}D`, label: 'Dashboard' },
        { keys: '?', label: 'Show these shortcuts' },
    ];
}

export function isTypingTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || !!el.isContentEditable;
}

export function resolveShortcut(event: Pick<KeyboardEvent, 'key' | 'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'target' | 'repeat'>): ShortcutAction | null {
    if (event.repeat) return null;
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        return ALT_CODES[event.code] ?? null;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return null;
    if (isTypingTarget(event.target)) return null;
    if (event.key === '/') return 'search-patients';
    if (event.key === '?') return 'show-help';
    return null;
}
