// Preload for client mode (#194). Deliberately no `window.electron`: the UI
// then takes its server path, the same one browsers use, with requests sent
// through the main process (pinned HTTPS plus the device credential).

import { contextBridge, ipcRenderer } from 'electron';

type ChunkListener = (id: string, text: string) => void;
type EndListener = (id: string, result: { status: number; body?: string; error?: string }) => void;

contextBridge.exposeInMainWorld('nalamdeskClient', {
    info: () => ipcRenderer.invoke('client:info'),
    request: (req: unknown) => ipcRenderer.invoke('client:request', req),
    openStream: (id: string, req: unknown) => ipcRenderer.invoke('client:streamOpen', id, req),
    closeStream: (id: string) => ipcRenderer.invoke('client:streamClose', id),
    onStreamChunk: (listener: ChunkListener) => {
        const handler = (_event: unknown, id: string, text: string) => listener(id, text);
        ipcRenderer.on('client:streamChunk', handler);
        return () => ipcRenderer.removeListener('client:streamChunk', handler);
    },
    onStreamEnd: (listener: EndListener) => {
        const handler = (_event: unknown, id: string, result: any) => listener(id, result);
        ipcRenderer.on('client:streamEnd', handler);
        return () => ipcRenderer.removeListener('client:streamEnd', handler);
    },
    disconnect: () => ipcRenderer.invoke('client:disconnect'),
    openExternal: (url: string) => ipcRenderer.invoke('client:openExternal', url)
});
