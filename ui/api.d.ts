// ============================================================
// 渲染进程可用的 window.api 类型声明（与 electron/preload.ts 保持一致）
// ============================================================

interface LogEntry {
    time: string;
    level: 'info' | 'success' | 'error';
    message: string;
}

interface ParamInfo {
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

interface G1Api {
    connect(host: string, port: number): Promise<IpcResult<void>>;
    disconnect(): Promise<IpcResult<void>>;
    isConnected(): Promise<boolean>;
    quick(action: string, arg?: number): Promise<IpcResult<void>>;
    getParams(): Promise<IpcResult<ParamInfo[]>>;
    setParam(id: number, value: number | string): Promise<IpcResult<void>>;
    onLog(cb: (entry: LogEntry) => void): () => void;
}

interface Window {
    api: G1Api;
}
