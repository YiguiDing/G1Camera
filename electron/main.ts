// ============================================================
// Electron 主进程 — 持有 G1Camera 实例，通过 IPC 向渲染进程提供服务
// ============================================================

import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import {
    G1Camera,
    G1ProtocolError,
    PARAM_DEFS,
    ParamType,
    ColorMode,
    ZoomDirection,
} from '../G1Camera';

const camera = new G1Camera();
let mainWindow: BrowserWindow | null = null;

// ============================================================
// 日志 — 输出到控制台并推送给渲染进程
// ============================================================

export interface LogEntry {
    time: string;
    level: 'info' | 'success' | 'error';
    message: string;
}

function log(level: LogEntry['level'], message: string): void {
    const entry: LogEntry = {
        time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        level,
        message,
    };
    console.log(`[${entry.level}] ${entry.message}`);
    mainWindow?.webContents.send('camera:log', entry);
}

// ============================================================
// IPC 工具 — 统一的 {ok, data | error} 返回格式
// ============================================================

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

function wrap<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
    return fn()
        .then((data) => ({ ok: true as const, data }))
        .catch((err) => ({
            ok: false as const,
            error: err instanceof Error ? err.message : String(err),
        }));
}

// ============================================================
// IPC 处理器
// ============================================================

/** 快捷指令白名单 — action 名称 → 相机方法 */
const QUICK_ACTIONS: Record<string, (arg?: number) => Promise<void>> = {
    reboot:       () => camera.reboot(),
    toggleWifi:   () => camera.toggleWifi(),
    capturePhoto: () => camera.capturePhoto(),
    toggleRecord: () => camera.toggleRecord(),
    formatSDCard: () => camera.formatSDCard(),
    calibrateGyro: () => camera.calibrateGyro(),
    setColorMode: (arg) => camera.setColorMode(arg ?? ColorMode.Color),
    zoomIn:       () => camera.zoom(ZoomDirection.In),
    zoomOut:      () => camera.zoom(ZoomDirection.Out),
};

export interface ParamInfo {
    id: number;
    name: string;
    type: ParamType;
    values?: Record<number, string>;
    byteCount?: number;
    value: number | string | null;
    error?: string;
    /** true = 相机固件不支持该参数（并非故障） */
    unsupported?: boolean;
}

function registerIpcHandlers(): void {
    ipcMain.handle('camera:connect', async (_e, host: string, port: number) => {
        log('info', `正在连接 ${host}:${port} …`);
        const result = await wrap(async () => {
            await camera.connect(host, port);
            log('success', `已连接相机 ${host}:${port}`);
        });
        if (!result.ok) log('error', `连接失败: ${result.error}`);
        return result;
    });

    ipcMain.handle('camera:disconnect', async () => {
        camera.disconnect();
        log('info', '已断开连接');
        return { ok: true };
    });

    ipcMain.handle('camera:isConnected', () => camera.isConnected());

    ipcMain.handle('camera:quick', async (_e, action: string, arg?: number) => {
        const fn = QUICK_ACTIONS[action];
        if (!fn) {
            log('error', `未知快捷指令: ${action}`);
            return { ok: false, error: `未知快捷指令: ${action}` };
        }
        log('info', `执行快捷指令: ${action}`);
        const result = await wrap(() => fn(arg));
        if (result.ok) {
            log('success', `快捷指令完成: ${action}`);
            if (action === 'reboot') {
                log('info', '相机正在重启，稍后可重新连接');
            }
        } else {
            log('error', `快捷指令失败 (${action}): ${result.error}`);
        }
        return result;
    });

    ipcMain.handle('camera:getParams', async () => {
        log('info', '读取全部参数 …');
        const params: ParamInfo[] = [];
        for (const def of Object.values(PARAM_DEFS)) {
            try {
                const value = await camera.getParam(def.id);
                params.push({ ...def, value });
            } catch (err) {
                if (err instanceof G1ProtocolError && err.unsupported) {
                    params.push({ ...def, value: null, error: err.errorText, unsupported: true });
                } else {
                    const msg = err instanceof Error ? err.message : String(err);
                    params.push({ ...def, value: null, error: msg });
                }
            }
        }
        const unsupported = params.filter((p) => p.unsupported).length;
        const failed = params.filter((p) => p.error !== undefined && !p.unsupported).length;
        if (failed > 0) {
            log('error', `参数读取完成：${failed} 个失败，${unsupported} 个固件不支持（共 ${params.length} 个）`);
        } else if (unsupported > 0) {
            log('info', `参数读取完成，共 ${params.length} 个（${unsupported} 个固件不支持）`);
        } else {
            log('success', `参数读取完成，共 ${params.length} 个参数`);
        }
        return { ok: true, data: params };
    });

    ipcMain.handle('camera:setParam', async (_e, id: number, value: number | string) => {
        const def = PARAM_DEFS[id];
        if (!def) {
            return { ok: false, error: `未知参数 ID: 0x${id.toString(16)}` };
        }
        log('info', `设置参数 ${def.name} = ${value}`);
        const result = await wrap(() => camera.setParam(id, value));
        if (result.ok) {
            log('success', `设置成功: ${def.name} = ${value}`);
        } else {
            log('error', `设置失败 (${def.name}): ${result.error}`);
        }
        return result;
    });
}

// ============================================================
// 窗口
// ============================================================

/** `electron . --smoke` 冒烟测试：隐藏窗口，加载完成后输出 SMOKE_OK 并退出 */
const isSmoke = process.argv.includes('--smoke');

function createWindow(): void {
    mainWindow = new BrowserWindow({
        width: 1024,
        height: 760,
        minWidth: 860,
        minHeight: 600,
        title: 'G1 相机控制',
        autoHideMenuBar: true,
        show: !isSmoke,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    mainWindow.loadFile(path.join(app.getAppPath(), 'ui', 'index.html'));

    if (isSmoke) {
        // 转发渲染进程 console 输出，验证渲染脚本执行
        (mainWindow.webContents as unknown as {
            on: (ev: string, cb: (...args: unknown[]) => void) => void;
        }).on('console-message', (...args: unknown[]) => {
            const ev = args[0] as { level?: string; message?: string } | undefined;
            const level = typeof ev?.level === 'string' ? ev.level : String(args[1] ?? '');
            const message = typeof ev?.message === 'string' ? ev.message : String(args[2] ?? '');
            console.log(`[renderer:${level}] ${message}`);
        });
        (mainWindow.webContents as unknown as {
            on: (ev: string, cb: (...args: unknown[]) => void) => void;
        }).on('preload-error', (...args: unknown[]) => {
            console.error(`PRELOAD_ERROR: ${String(args[1] ?? '')} ${String(args[2] ?? '')}`);
        });
        mainWindow.webContents.once('did-fail-load', (_e, code, desc) => {
            console.error(`SMOKE_FAIL: ${code} ${desc}`);
            app.exit(1);
        });
        mainWindow.webContents.once('did-finish-load', () => {
            console.log('SMOKE_OK');
            setTimeout(() => app.quit(), 200);
        });
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// ============================================================
// 应用生命周期
// ============================================================

app.whenReady().then(() => {
    registerIpcHandlers();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    camera.disconnect();
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    camera.disconnect();
});
