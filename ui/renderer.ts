// ============================================================
// 渲染进程 UI 逻辑 — 通过 window.api 与主进程通信
// （本文件不包含 import/export，编译为经典 script 加载）
// ============================================================

// ---- DOM 引用 ----

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
    const el = document.querySelector<T>(sel);
    if (!el) throw new Error(`element not found: ${sel}`);
    return el;
};

const hostInput       = $<HTMLInputElement>('#host-input');
const portInput       = $<HTMLInputElement>('#port-input');
const connectBtn      = $<HTMLButtonElement>('#connect-btn');
const disconnectBtn   = $<HTMLButtonElement>('#disconnect-btn');
const statusBadge     = $<HTMLSpanElement>('#status-badge');
const refreshBtn      = $<HTMLButtonElement>('#refresh-params-btn');
const paramsTbody     = $<HTMLTableSectionElement>('#params-tbody');
const logBox          = $<HTMLDivElement>('#log-box');
const clearLogBtn     = $<HTMLButtonElement>('#clear-log-btn');
const quickButtons    = document.querySelectorAll<HTMLButtonElement>('.btn.quick');

let busy = false; // 有操作进行中时禁用按钮

// ---- 启动自检（smoke 模式在主进程可见） ----

console.log('renderer loaded, api ready:', typeof window.api === 'object');

// ---- 工具 ----

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function setBusy(b: boolean): void {
    busy = b;
    quickButtons.forEach((btn) => { btn.disabled = b; });
    connectBtn.disabled = b;
    disconnectBtn.disabled = b;
    refreshBtn.disabled = b;
}

// ---- 日志 ----

function appendLog(entry: LogEntry): void {
    const line = document.createElement('div');
    line.className = `log-line ${entry.level}`;
    line.innerHTML =
        `<span class="t">[${escapeHtml(entry.time)}]</span> ` +
        `<span class="m">${escapeHtml(entry.message)}</span>`;
    logBox.appendChild(line);
    logBox.scrollTop = logBox.scrollHeight;
    // 最多保留 500 行
    while (logBox.childElementCount > 500) {
        logBox.removeChild(logBox.firstElementChild!);
    }
}

clearLogBtn.addEventListener('click', () => {
    logBox.innerHTML = '';
});

window.api.onLog(appendLog);

// ---- 连接状态 ----

async function refreshStatus(): Promise<void> {
    try {
        const connected = await window.api.isConnected();
        statusBadge.textContent = connected ? '已连接' : '未连接';
        statusBadge.className = connected ? 'badge on' : 'badge off';
    } catch {
        // 主进程尚未就绪时忽略
    }
}

connectBtn.addEventListener('click', async () => {
    const host = hostInput.value.trim();
    const port = Number(portInput.value);
    if (!host) {
        appendLog({ time: now(), level: 'error', message: '请输入相机 IP 地址' });
        return;
    }
    setBusy(true);
    try {
        const result = await window.api.connect(host, port);
        if (result.ok) {
            await refreshStatus();
            void loadParams(); // 连接成功后自动读取参数
        } else {
            appendLog({ time: now(), level: 'error', message: result.error });
        }
    } finally {
        setBusy(false);
    }
});

disconnectBtn.addEventListener('click', async () => {
    setBusy(true);
    try {
        await window.api.disconnect();
        await refreshStatus();
    } finally {
        setBusy(false);
    }
});

setInterval(refreshStatus, 2000);
refreshStatus();

function now(): string {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

// ---- 快捷指令 ----

quickButtons.forEach((btn) => {
    btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        if (!action || busy) return;

        if (action === 'formatSDCard') {
            const sure = window.confirm('确定要格式化存储卡吗？\n此操作会删除卡内所有文件，且不可恢复！');
            if (!sure) return;
        }
        if (action === 'reboot') {
            const sure = window.confirm('确定要重启相机吗？重启后需要重新连接。');
            if (!sure) return;
        }

        const arg = btn.dataset.arg !== undefined ? Number(btn.dataset.arg) : undefined;

        setBusy(true);
        try {
            const result = await window.api.quick(action, arg);
            if (!result.ok) {
                appendLog({ time: now(), level: 'error', message: result.error });
            }
        } finally {
            setBusy(false);
            void refreshStatus();
        }
    });
});

// ---- 参数表 ----

function valueText(p: ParamInfo): string {
    if (p.unsupported) return `固件不支持 (${p.error})`;
    if (p.error !== undefined) return `读取失败: ${p.error}`;
    if (p.value === null) return '-';
    if (p.type === 'int' && p.values) {
        const label = p.values[p.value as number];
        return label !== undefined ? `${label} (${p.value})` : String(p.value);
    }
    return String(p.value);
}

function buildSetControl(p: ParamInfo): string {
    if (p.error !== undefined) return '';
    const cur = p.value;

    if (p.type === 'int' && p.values) {
        const options = Object.entries(p.values)
            .map(([v, label]) =>
                `<option value="${v}"${Number(v) === cur ? ' selected' : ''}>${escapeHtml(label)} (${v})</option>`)
            .join('');
        return `<select class="set-input" data-kind="int">${options}</select>`;
    }
    if (p.type === 'int') {
        const max = p.byteCount === 2 ? 65535 : 255;
        return `<input class="set-input" data-kind="int" type="number" min="0" max="${max}" value="${cur ?? ''}" />`;
    }
    return `<input class="set-input" data-kind="string" type="text" value="${escapeHtml(cur !== null ? String(cur) : '')}" />`;
}

function renderParams(params: ParamInfo[]): void {
    if (params.length === 0) {
        paramsTbody.innerHTML = '<tr><td colspan="4" class="placeholder">无参数</td></tr>';
        return;
    }
    paramsTbody.innerHTML = params.map((p) => {
        const valueClass = p.unsupported
            ? 'param-value unsupported'
            : p.error !== undefined
                ? 'param-value error'
                : 'param-value';
        return `
        <tr data-id="${p.id}" class="${p.unsupported ? 'row-unsupported' : ''}">
            <td>${escapeHtml(p.name)}</td>
            <td class="param-id">0x${p.id.toString(16).toUpperCase().padStart(2, '0')}</td>
            <td class="${valueClass}">${escapeHtml(valueText(p))}</td>
            <td><div class="set-cell">${buildSetControl(p)}${p.error === undefined ? '<button class="btn small set-btn">设置</button>' : ''}</div></td>
        </tr>
    `;
    }).join('');

    // 绑定设置按钮 — 从所属行读取参数 ID，不依赖下标
    // （固件不支持的参数行没有设置按钮，用下标会整体错位）
    paramsTbody.querySelectorAll<HTMLButtonElement>('.set-btn').forEach((btn) => {
        const row = btn.closest('tr') as HTMLTableRowElement;
        const id = Number(row.dataset.id);
        const control = row.querySelector<HTMLInputElement | HTMLSelectElement>('.set-input');
        btn.addEventListener('click', () => { void applyParam(id, control); });
    });
}

async function loadParams(): Promise<void> {
    refreshBtn.disabled = true;
    try {
        const result = await window.api.getParams();
        if (result.ok) {
            renderParams(result.data);
        } else {
            appendLog({ time: now(), level: 'error', message: result.error });
        }
    } finally {
        refreshBtn.disabled = false;
    }
}

async function applyParam(paramId: number, control: HTMLInputElement | HTMLSelectElement | null): Promise<void> {
    if (!control) return;

    const kind = control.dataset.kind;
    let value: number | string;
    if (kind === 'int') {
        value = Number(control.value);
        if (Number.isNaN(value)) return;
    } else {
        value = control.value;
    }

    setBusy(true);
    try {
        const result = await window.api.setParam(paramId, value);
        if (result.ok) {
            void loadParams();
        } else {
            appendLog({ time: now(), level: 'error', message: result.error });
        }
    } finally {
        setBusy(false);
    }
}

refreshBtn.addEventListener('click', () => { void loadParams(); });
