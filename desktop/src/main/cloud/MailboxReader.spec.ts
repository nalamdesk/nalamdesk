import { describe, expect, it, vi } from 'vitest';
import { MailboxReader, type ListedItem, type MailboxHandler } from './MailboxReader';

vi.mock('electron-log', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

function setup(handler: MailboxHandler['handle'] = () => 'saved', pageSize = 50) {
    let items: ListedItem[] = [];
    const acked: string[][] = [];
    const downloads: string[] = [];
    const handled: string[] = [];
    const synced: Record<string, number>[] = [];
    const transport = {
        list: vi.fn(async (after?: string) => {
            const rest = after === undefined ? items : items.filter((item) => item.id > after);
            return { items: rest.slice(0, pageSize), more: rest.length > pageSize };
        }),
        download: vi.fn(async (url: string) => {
            downloads.push(url);
            if (url.includes('broken')) throw new Error('403');
            return 'sealed-from-link';
        }),
        ack: vi.fn(async (ids: string[]) => {
            acked.push(ids);
            items = items.filter((item) => !ids.includes(item.id));
        })
    };
    const reader = new MailboxReader({
        transport,
        handlers: {
            'booking-request': { handle: (item) => { handled.push(`${item.id}:${item.sealed}`); return handler(item); } }
        },
        onSynced: (saved) => synced.push(saved)
    });
    return { reader, transport, acked, downloads, handled, synced, put: (...next: ListedItem[]) => { items.push(...next); } };
}

describe('MailboxReader', () => {
    it('hands each item to its handler and acknowledges saved and dropped ones', async () => {
        const results: Record<string, 'saved' | 'dropped' | 'retry'> = { a: 'saved', b: 'dropped', c: 'retry' };
        const h = setup((item) => results[item.id]!);
        h.put({ id: 'a', type: 'booking-request', sealed: 's' }, { id: 'b', type: 'booking-request', sealed: 's' },
            { id: 'c', type: 'booking-request', sealed: 's' }, { id: 'd', type: 'someday', sealed: 's' });
        expect(await h.reader.sync()).toEqual({ 'booking-request': 1 });
        expect(h.acked).toEqual([['a', 'b']]);
        expect(h.synced).toEqual([{ 'booking-request': 1 }]);
        expect(h.reader.lastCheckedAt()).not.toBeNull();
    });

    it('downloads large items from their link, and leaves one whose link fails', async () => {
        const h = setup();
        h.put({ id: 'a', type: 'booking-request', url: 'https://s3.test/a' }, { id: 'b', type: 'booking-request', url: 'https://s3.test/broken' });
        await h.reader.sync();
        expect(h.handled).toEqual(['a:sealed-from-link']);
        expect(h.acked).toEqual([['a']]);
    });

    it('lists the rest of a page again when slow downloads leave its links near expiry', async () => {
        let clock = 0;
        const items: ListedItem[] = ['a', 'b', 'c'].map((id) => ({ id, type: 'booking-request', url: `https://s3.test/${id}` }));
        const lists: (string | undefined)[] = [];
        const downloads: string[] = [];
        const reader = new MailboxReader({
            transport: {
                list: async (after?: string) => {
                    lists.push(after);
                    return { items: items.filter((item) => after === undefined || item.id > after), more: false };
                },
                // Each download hits its 3-minute stall.
                download: async (url: string) => { downloads.push(url); clock += 3 * 60_000; return 'sealed'; },
                ack: async () => undefined
            },
            handlers: { 'booking-request': { handle: () => 'saved' } },
            nowMs: () => clock
        });
        expect(await reader.sync()).toEqual({ 'booking-request': 3 });
        expect(lists).toEqual([undefined, 'b']);
        expect(downloads).toEqual(['https://s3.test/a', 'https://s3.test/b', 'https://s3.test/c']);
    });

    it('does not spend the page budget on link refreshes', async () => {
        let clock = 0;
        // 150 slow large items, then a booking behind them.
        const items: ListedItem[] = Array.from({ length: 150 }, (_, i) => ({ id: `a${String(i).padStart(3, '0')}`, type: 'booking-request', url: 'https://s3.test/slow' }));
        items.push({ id: 'b000', type: 'booking-request', sealed: 's' });
        const handled: string[] = [];
        const reader = new MailboxReader({
            transport: {
                list: async (after?: string) => {
                    const rest = items.filter((item) => after === undefined || item.id > after);
                    return { items: rest.slice(0, 50), more: rest.length > 50 };
                },
                download: async () => { clock += 60_000; throw new Error('timeout'); },
                ack: async () => undefined
            },
            handlers: { 'booking-request': { handle: (item) => { handled.push(item.id); return 'saved'; } } },
            nowMs: () => clock
        });
        await reader.sync();
        expect(handled).toEqual(['b000']);
    });

    it('keeps a handler failure in the mailbox for the next pass', async () => {
        const h = setup(() => { throw new Error('disk full'); });
        h.put({ id: 'a', type: 'booking-request', sealed: 's' });
        expect(await h.reader.sync()).toEqual({});
        expect(h.acked).toEqual([]);
        expect(h.synced).toEqual([{}]);
    });

    it('reads further pages while it makes progress', async () => {
        const h = setup(() => 'saved', 2);
        h.put(...['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, type: 'booking-request', sealed: 's' })));
        expect(await h.reader.sync()).toEqual({ 'booking-request': 5 });
        expect(h.transport.list).toHaveBeenCalledTimes(3);
    });

    it('pages past items it keeps for a retry, so newer mail is not starved', async () => {
        const h = setup((item) => (item.id === 'a' || item.id === 'b' ? 'retry' : 'saved'), 2);
        h.put(...['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, type: 'booking-request', sealed: 's' })));
        expect(await h.reader.sync()).toEqual({ 'booking-request': 3 });
        expect(h.transport.list.mock.calls.map((call) => call[0])).toEqual([undefined, 'b', 'd']);
        expect(h.acked).toEqual([['c', 'd'], ['e']]);
        // The next pass starts from the oldest again and retries what was kept.
        h.transport.list.mockClear();
        await h.reader.sync();
        expect(h.transport.list.mock.calls[0]![0]).toBeUndefined();
        expect(h.handled.filter((entry) => entry.startsWith('a:'))).toHaveLength(2);
    });

    it('stops paging at the last page, and after a bounded number of pages', async () => {
        const h = setup(() => 'retry', 1);
        h.put(...Array.from({ length: 30 }, (_, i) => ({ id: `i${String(i).padStart(2, '0')}`, type: 'booking-request', sealed: 's' })));
        await h.reader.sync();
        expect(h.transport.list).toHaveBeenCalledTimes(20);
        expect(h.acked).toEqual([]);
    });

    it('folds a doorbell that rings mid-fetch into one more pass', async () => {
        const h = setup();
        h.put({ id: 'a', type: 'booking-request', sealed: 's' });
        const first = h.reader.sync();
        h.put({ id: 'b', type: 'booking-request', sealed: 's' });
        h.reader.onDoorbell();
        expect(await first).toEqual({ 'booking-request': 2 });
        expect(h.transport.list).toHaveBeenCalledTimes(2);
    });
});
