/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DataService } from './api.service';
import { AuthService } from './auth.service';

describe('DataService', () => {
    let service: DataService;
    let mockAuthService: any;

    beforeEach(() => {
        mockAuthService = {
            getToken: vi.fn(),
            getUser: vi.fn()
        };
        service = new DataService(mockAuthService, {} as any);
        vi.restoreAllMocks();
    });

    afterEach(() => {
        delete (window as any).electron;
    });

    describe('invoke (Electron Mode)', () => {
        it('should call local electron db method', async () => {
            const mockFn = vi.fn().mockResolvedValue('success');
            (window as any).electron = {
                db: { testMethod: mockFn }
            };

            const result = await service.invoke('testMethod', 'arg1');
            expect(result).toBe('success');
            expect(mockFn).toHaveBeenCalledWith('arg1');
        });

        it('should throw if method not found locally', async () => {
            (window as any).electron = { db: {} };
            await expect(service.invoke('missing')).rejects.toThrow('Method missing not implemented locally');
        });
    });

    describe('invoke (server client)', () => {
        it('sends data calls through the server connection', async () => {
            const server = { invoke: vi.fn().mockResolvedValue({ lastInsertRowid: 1 }) };
            service = new DataService(mockAuthService, server as any);
            await expect(service.invoke('addToQueue', { patientId: 42, priority: 2 })).resolves.toEqual({ lastInsertRowid: 1 });
            expect(server.invoke).toHaveBeenCalledWith('addToQueue', [{ patientId: 42, priority: 2 }]);
        });

        it('passes server errors on', async () => {
            const server = { invoke: vi.fn().mockRejectedValue(new Error('Server Boom')) };
            service = new DataService(mockAuthService, server as any);
            await expect(service.invoke('crash')).rejects.toThrow('Server Boom');
        });
    });
});
