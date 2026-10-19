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
        list: vi.fn(async () => ({ items: items.slice(0, pageSize), more: items.length > pageSize })),
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

    it('keeps a handler failure in the mailbox for the next pass', async () => {
        const h = setup(() => { throw new Error('disk full'); });
        h.put({ id: 'a', type: 'booking-request', sealed: 's' });
        expect(await h.reader.sync()).toEqual({});
        expect(h.acked).toEqual([]);
        expect(h.synced).toEqual([]);
    });

    it('reads further pages while it makes progress', async () => {
        const h = setup(() => 'saved', 2);
        h.put(...['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, type: 'booking-request', sealed: 's' })));
        expect(await h.reader.sync()).toEqual({ 'booking-request': 5 });
        expect(h.transport.list).toHaveBeenCalledTimes(3);
    });

    it('stops paging when a page has nothing it can acknowledge', async () => {
        const h = setup(() => 'retry', 1);
        h.put({ id: 'a', type: 'booking-request', sealed: 's' }, { id: 'b', type: 'booking-request', sealed: 's' });
        await h.reader.sync();
        expect(h.transport.list).toHaveBeenCalledTimes(1);
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
