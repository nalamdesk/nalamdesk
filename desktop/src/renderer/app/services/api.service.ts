import { Injectable } from '@angular/core';
import { AuthService } from './auth.service';
import { ServerConnectionService } from './server-connection.service';

@Injectable({
    providedIn: 'root'
})
export class DataService {

    constructor(private auth: AuthService, private server: ServerConnectionService) { }

    async invoke<T = any>(method: string, ...args: any[]): Promise<T> {
        if (window.electron) {
            return this.invokeLocal<T>(method, args);
        }
        return this.invokeRemote<T>(method, args);
    }

    private async invokeLocal<T>(method: string, args: any[]): Promise<T> {
        const db = (window.electron.db as any);
        const cloud = (window.electron.cloud as any);

        if (db && db[method]) {
            return await db[method](...args);
        }

        if (method.startsWith('cloud:') && cloud) {
            const pureMethod = method.replace('cloud:', '');
            if (cloud[pureMethod]) {
                return await cloud[pureMethod](...args);
            }
        }

        console.error(`Method ${method} not found in local bridge`);
        throw new Error(`Method ${method} not implemented locally`);
    }

    private invokeRemote<T>(method: string, args: any[]): Promise<T> {
        // Browser client and the app in client mode (#194): tokens, refresh,
        // the handshake and reconnects live in the server connection.
        return this.server.invoke<T>(method, args);
    }
}
