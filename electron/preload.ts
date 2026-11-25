// ============================================================
// Preload — 通过 contextBridge 暴露安全的渲染进程 API
// ============================================================

import { contextBridge, ipcRenderer } from 'electron';

export interface LogEntry {
    time: string;
    level: 'info' | 'success' | 'error';
    message: string;
}

export interface ParamInfo {
    id: number;
    name: string;
    type: 'int' | 'string';
    values?: Record<number, string>;
    byteCount?: number;
    value: number | string | null;
    error?: string;
    /** true = 相机固件不支持该参数（并非故障） */
    unsupported?: boolean;
}

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

const api = {
    connect: (host: string, port: number): Promise<IpcResult<void>> =>
        ipcRenderer.invoke('camera:connect', host, port),

    disconnect: (): Promise<IpcResult<void>> =>
        ipcRenderer.invoke('camera:disconnect'),

    isConnected: (): Promise<boolean> =>
        ipcRenderer.invoke('camera:isConnected'),

    /** 执行快捷指令 (reboot / capturePhoto / …)，见主进程 QUICK_ACTIONS */
    quick: (action: string, arg?: number): Promise<IpcResult<void>> =>
        ipcRenderer.invoke('camera:quick', action, arg),

    getParams: (): Promise<IpcResult<ParamInfo[]>> =>
        ipcRenderer.invoke('camera:getParams'),

    setParam: (id: number, value: number | string): Promise<IpcResult<void>> =>
        ipcRenderer.invoke('camera:setParam', id, value),

    /** 订阅主进程日志，返回取消订阅函数 */
    onLog: (cb: (entry: LogEntry) => void): (() => void) => {
        const listener = (_e: unknown, entry: LogEntry) => cb(entry);
        ipcRenderer.on('camera:log', listener);
        return () => {
            ipcRenderer.removeListener('camera:log', listener);
        };
    },
};

contextBridge.exposeInMainWorld('api', api);
