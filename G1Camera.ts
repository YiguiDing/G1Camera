import * as net from 'net';
import { Duplex } from 'stream';
import { Driver, ExtractResult } from './Driver';

// ============================================================
// G1 Protocol Constants
// ============================================================

export const HEADER_COMMAND  = 0xAA;
export const HEADER_RESPONSE = 0x55;
const TYPE_CONFIG            = 0x07;
/** 命令字0: 设备信息 (协议 2.3.1) */
export const TYPE_DEVICE_INFO = 0x00;
/** 命令字0: 快捷操作 (协议 2.3.2) */
export const TYPE_QUICK      = 0x01;
export const RW_GET          = 0x00;
export const RW_SET          = 0x01;

/** 相机错误码说明（协议 2.2.1） */
export const ERROR_CODE_TEXT: Record<number, string> = {
    0x00: '无错误',
    0x01: '没有0xaa头字节',
    0x02: '相机不支持该命令/参数',
    0x03: '输入参数不等于计算总字节数',
    0x04: '校验错误',
    0xff: '忽略这条指令',
};

const CRC_POLY = 0xD5;

export const DEFAULT_PORT    = 8888;
export const DEFAULT_TIMEOUT = 5000;

// ============================================================
// G1 Protocol Types
// ============================================================

export enum ParamType {
    Int    = 'int',
    String = 'string',
}

export interface ParamDef {
    id: number;
    name: string;
    type: ParamType;
    /** Human-readable value labels (int params) */
    values?: Record<number, string>;
    defaultValue?: number | string;
    /** Byte count for int params (1 or 2, default 1) */
    byteCount?: number;
}

/**
 * 相机回复包解析结果。回复格式（协议 2.2）：
 *   [0x55][总字节数][命令字][错误码][数据类型][参数...][CRC]
 * 例：55 07 07 00 01 01 A6
 *       命令字=07 错误码=00(无错误) 数据类型=01(整型) 参数=01
 */
export interface ParsedResponse {
    /** 命令字（错误时为 0xff，否则回显发送的命令字） */
    cmdWord: number;
    /** 错误码：0x00 无错误；0x01 无头；0x02 命令错；0x03 长度错；0x04 校验错；0xff 忽略 */
    errorCode: number;
    /** 数据类型：0x01 整型 / 0x02 字符型 */
    dataType: number;
    /** 参数数据（不含数据类型字节） */
    data: Buffer;
    /** @deprecated 同 errorCode，保留以兼容旧代码 */
    rw: number;
    /** @deprecated 同 dataType，保留以兼容旧代码 */
    status: number;
}

/** 相机返回非 0 错误码时抛出的协议错误 */
export class G1ProtocolError extends Error {
    constructor(
        /** 相机错误码（见 ERROR_CODE_TEXT） */
        public readonly errorCode: number,
        /** 命令字（错误回复为 0xff） */
        public readonly cmdWord: number,
        message: string,
    ) {
        super(message);
        this.name = 'G1ProtocolError';
    }

    /** 该错误是否表示相机固件不支持此命令/参数 */
    get unsupported(): boolean {
        return this.errorCode === 0x02 || this.errorCode === 0x03 || this.errorCode === 0xff;
    }

    /** 人类可读的错误码说明 */
    get errorText(): string {
        return ERROR_CODE_TEXT[this.errorCode] ?? `未知错误码 0x${this.errorCode.toString(16)}`;
    }
}

// ============================================================
// CRC-8 Checksum  (poly = 0xD5)
// ============================================================

export function crc8(data: Buffer | number[]): number {
    let crc = 0x00;
    const bytes = Buffer.isBuffer(data) ? [...data] : data;
    for (const b of bytes) {
        crc ^= b;
        for (let i = 0; i < 8; i++) {
            if (crc & 0x80) {
                crc = ((crc << 1) ^ CRC_POLY) & 0xFF;
            } else {
                crc = (crc << 1) & 0xFF;
            }
        }
    }
    return crc;
}

// ============================================================
// Parameter Definitions Table
// ============================================================

export const PARAM_DEFS: Record<number, ParamDef> = {
    // ---- 照片参数 ----
    0x00: { id: 0x00, name: 'imageSize',                    type: ParamType.Int, values: { 0: '20M', 1: '13M', 2: '12M', 3: '10M', 4: '8M', 5: '5M', 6: '3M', 7: '2M' }, defaultValue: 2 },
    0x01: { id: 0x01, name: 'photoDelayTimer',              type: ParamType.Int, values: { 0: 'OFF', 1: '3S', 2: '5S', 3: '7S' }, defaultValue: 0 },
    0x02: { id: 0x02, name: 'photoLDC',                     type: ParamType.Int, values: { 0: 'OFF', 1: 'ON' }, defaultValue: 0 },
    0x03: { id: 0x03, name: 'photoTimeLapseInterval',       type: ParamType.Int, values: { 0: 'OFF', 1: '1S', 2: '2S', 3: '3S', 4: '4S', 5: '5S', 6: '6S', 7: '7S', 8: '8S', 9: '10S', 10: '13S', 11: '15S', 12: '20S', 13: '25S', 14: '30S', 15: '40S', 16: '60S' }, defaultValue: 0 },
    0x04: { id: 0x04, name: 'timeLapsePhotoShootingTime',   type: ParamType.Int, values: { 0: 'Unlimited', 1: '1MIN', 2: '3MIN', 3: '5MIN', 4: '10MIN', 5: '20MIN', 6: '30MIN', 7: '1H', 8: '2H', 9: '3H', 10: '5H' }, defaultValue: 0 },
    0x05: { id: 0x05, name: 'stillStampMode',               type: ParamType.Int, values: { 0: 'OFF', 1: 'DATE', 2: 'DATETIME' }, defaultValue: 0 },
    0x3F: { id: 0x3F, name: 'capRotation',                  type: ParamType.Int },

    // ---- 录像参数 ----
    0x07: { id: 0x07, name: 'videoSize',                    type: ParamType.Int, values: { 0: '4K', 1: '2.7K', 2: '1440P', 3: '1080P', 4: '720P' }, defaultValue: 0 },
    0x08: { id: 0x08, name: 'frameRate',                    type: ParamType.Int, values: { 0: '24fps', 1: '25fps', 2: '30fps', 3: '48fps', 4: '50fps', 5: '60fps', 6: '120fps', 7: '240fps' }, defaultValue: 2 },
    0x09: { id: 0x09, name: 'slowMotionMode',               type: ParamType.Int, values: { 0: 'OFF', 1: '2x slow', 2: '4x slow', 3: '8x slow' }, defaultValue: 0 },
    0x0A: { id: 0x0A, name: 'videoFastMotion',              type: ParamType.Int, values: { 0: 'OFF', 1: '2X', 2: '5X', 3: '10X', 4: '15X', 5: '30X' }, defaultValue: 0 },
    0x0B: { id: 0x0B, name: 'videoTimeLapseInterval',       type: ParamType.Int, values: { 0: 'OFF', 1: '1S', 2: '2S', 3: '3S', 4: '4S', 5: '5S', 6: '6S', 7: '7S', 8: '8S', 9: '10S', 10: '13S', 11: '15S', 12: '20S', 13: '25S', 14: '30S', 15: '40S', 16: '60S' }, defaultValue: 0 },
    0x0C: { id: 0x0C, name: 'timeLapseVideoShootingTime',   type: ParamType.Int, values: { 0: 'Unlimited', 1: '1MIN', 2: '3MIN', 3: '5MIN', 4: '10MIN', 5: '20MIN', 6: '30MIN', 7: '1H', 8: '2H', 9: '3H', 10: '5H' }, defaultValue: 0 },
    0x0D: { id: 0x0D, name: 'preRec',                       type: ParamType.Int, values: { 0: 'OFF', 1: 'ON' }, defaultValue: 0 },
    0x0E: { id: 0x0E, name: 'videoImageStabilization',      type: ParamType.Int, values: { 0: 'OFF', 1: 'ON' }, defaultValue: 0 },
    0x10: { id: 0x10, name: 'videoQuality',                 type: ParamType.Int, values: { 0: 'Superfine', 1: 'Fine', 2: 'Normal' }, defaultValue: 2 },
    0x11: { id: 0x11, name: 'rotation',                     type: ParamType.Int, values: { 0: 'Normal', 1: 'Vertical', 2: 'Level', 3: '270°' }, defaultValue: 0 },
    0x13: { id: 0x13, name: 'ldc',                          type: ParamType.Int },
    0x14: { id: 0x14, name: 'metering',                     type: ParamType.Int, values: { 0: 'Center', 1: 'Multi', 2: 'Spot' }, defaultValue: 1 },
    0x15: { id: 0x15, name: 'seamless',                     type: ParamType.Int, values: { 0: 'Unlimited', 1: '1MIN', 2: '3MIN', 3: '5MIN' }, defaultValue: 0 },
    0x16: { id: 0x16, name: 'cyclicRec',                    type: ParamType.Int, values: { 0: 'OFF', 1: 'ON' }, defaultValue: 0 },
    0x17: { id: 0x17, name: 'recVol',                       type: ParamType.Int, values: { 0: 'Mute', 1: 'Low', 2: 'Middle', 3: 'High' }, defaultValue: 2 },
    0x18: { id: 0x18, name: 'videoStampMode',               type: ParamType.Int, values: { 0: 'OFF', 1: 'DATE', 2: 'DATETIME' }, defaultValue: 0 },
    0x19: { id: 0x19, name: 'videoFileFormat',              type: ParamType.Int, values: { 1: 'MOV', 2: 'MP4' }, defaultValue: 1 },
    0x1A: { id: 0x1A, name: 'videoVFI',                     type: ParamType.Int, values: { 0: 'OFF', 1: 'ON' }, defaultValue: 0 },

    // ---- 系统设置 ----
    0x1B: { id: 0x1B, name: 'screenSaverTime',              type: ParamType.Int, values: { 0: 'OFF', 1: '1MIN', 2: '3MIN', 3: '5MIN' }, defaultValue: 0 },
    0x1C: { id: 0x1C, name: 'sleepTime',                    type: ParamType.Int, values: { 0: 'OFF', 1: '1MIN', 2: '3MIN', 3: '5MIN', 4: '10MIN', 5: '15MIN' }, defaultValue: 0 },
    0x1D: { id: 0x1D, name: 'autoRecording',                type: ParamType.Int, values: { 0: 'OFF', 1: 'ON' }, defaultValue: 0 },
    0x1F: { id: 0x1F, name: 'lightFreq',                    type: ParamType.Int, values: { 0: 'OFF', 1: '50HZ', 2: '60HZ' }, defaultValue: 0 },
    0x20: { id: 0x20, name: 'beepSound',                    type: ParamType.Int, values: { 0: 'OFF', 1: 'ON' }, defaultValue: 0 },
    0x21: { id: 0x21, name: 'volume',                       type: ParamType.Int, values: { 0: 'OFF', 1: '1', 2: '2', 3: '3' }, defaultValue: 2 },
    0x22: { id: 0x22, name: 'soundChoice',                  type: ParamType.Int, values: { 0: 'BEEP', 1: 'SPEAKER' }, defaultValue: 0 },
    0x23: { id: 0x23, name: 'audioCodec',                   type: ParamType.Int, values: { 0: 'Internal', 1: 'External' }, defaultValue: 0 },
    0x24: { id: 0x24, name: 'switchSecondAudio',            type: ParamType.Int, values: { 0: 'OFF', 1: 'ON' }, defaultValue: 0 },
    0x25: { id: 0x25, name: 'autoOpenWifi',                 type: ParamType.Int, values: { 0: 'OFF', 1: 'ON' }, defaultValue: 0 },
    0x26: { id: 0x26, name: 'wifiFrequencyBand',            type: ParamType.Int, values: { 0: '2.4G', 1: '5G' }, defaultValue: 1 },
    0x27: { id: 0x27, name: 'fillLightA',                   type: ParamType.Int, values: { 0: 'Close', 1: 'Open' }, defaultValue: 0 },
    0x28: { id: 0x28, name: 'fillLightB',                   type: ParamType.Int, values: { 0: 'Auto', 1: 'Close', 2: 'Open' }, defaultValue: 0 },
    0x29: { id: 0x29, name: 'irCut',                        type: ParamType.Int },
    0x31: { id: 0x31, name: 'usbMode',                      type: ParamType.Int, values: { 0: 'USB', 1: 'PCCAM' }, defaultValue: 0 },
    0x32: { id: 0x32, name: 'autoWifiRec',                  type: ParamType.Int, values: { 0: 'OFF', 1: 'ON' }, defaultValue: 0 },
    0x33: { id: 0x33, name: 'hdmiSize',                     type: ParamType.Int, values: { 0: 'AUTO', 1: '3840x2160P_30HZ', 2: '1920x1080P_60HZ', 3: '1920x1080P_30HZ', 4: '1280x720P_60HZ' }, defaultValue: 0 },
    0x34: { id: 0x34, name: 'uvcBitrate',                   type: ParamType.Int, defaultValue: 20 },
    0x35: { id: 0x35, name: 'usbAutoPWROn',                 type: ParamType.Int, values: { 0: 'Close', 1: 'Open' }, defaultValue: 1 },
    0x36: { id: 0x36, name: 'invertMode',                   type: ParamType.Int, values: { 0: 'OFF', 1: 'ON' }, defaultValue: 0 },
    0x37: { id: 0x37, name: 'wifiAutoClose',                type: ParamType.Int, values: { 0: 'OFF', 1: '1MIN', 2: '2MIN', 3: '3MIN' }, defaultValue: 0 },
    0x38: { id: 0x38, name: 'wifiMode',                     type: ParamType.Int, values: { 0: 'AP', 1: 'STA' }, defaultValue: 0 },
    0x39: { id: 0x39, name: 'iqStamp',                      type: ParamType.Int, values: { 0: 'CLOSE', 1: 'OPEN' }, defaultValue: 0 },
    0x3A: { id: 0x3A, name: 'staticIP',                     type: ParamType.Int, values: { 0: 'Dynamic', 1: 'Static' }, defaultValue: 1 },
    0x3B: { id: 0x3B, name: 'portNumber',                   type: ParamType.Int, byteCount: 2 },

    // ---- 字符串参数 ----
    0x7F: { id: 0x7F, name: 'wifiSSID',                     type: ParamType.String },
    0x80: { id: 0x80, name: 'wifiPassword',                 type: ParamType.String },
    0x81: { id: 0x81, name: 'customWifiSSID',               type: ParamType.String },
    0x82: { id: 0x82, name: 'customWifiPassword',           type: ParamType.String },
    0x83: { id: 0x83, name: 'netIp',                        type: ParamType.String },
    0x84: { id: 0x84, name: 'netGateway',                   type: ParamType.String },
    0x85: { id: 0x85, name: 'cameraTime',                   type: ParamType.String },
};

// ============================================================
// Quick-Command Definitions (协议 2.3.2 快捷操作)
// ============================================================

/**
 * 快捷指令 ID — 命令字0 = 0x01，参数1 = 指令 ID
 * 包格式: [0xAA][len][0x01][cmdId][subParam?][CRC] (len 为 5 或 6)
 */
export enum QuickCmd {
    /**
     * 切换模式 — 仅出现在协议 6.0 校验码示例 (aa 05 01 01 21)，
     * 2.3.2 表格未列出，使用时请与相机实际行为核对。
     */
    SwitchMode = 0x01,
    /** 开/关 WiFi（关闭 WiFi 时连接会断开） */
    ToggleWifi = 0x03,
    /** 快捷拍照 — 不管在哪种模式下都执行拍照 */
    Capture    = 0x04,
    /** 快捷录像 — 不管在哪种模式下都执行录像 */
    Record     = 0x05,
    /** 格式化存储卡 */
    FormatSD   = 0x06,
    /** 彩色/黑白模式 — 需要子参数 (ColorMode) */
    ColorMode  = 0x07,
    /** 相机陀螺仪校准 */
    GyroCalib  = 0x08,
    /** 设备重启 — 重启后 TCP 连接会断开 */
    Reboot     = 0x09,
    /** 放大/缩小倍率 — 需要子参数 (ZoomDirection) */
    Zoom       = 0x0A,
}

/** ColorMode 快捷指令 (0x07) 的子参数 */
export enum ColorMode {
    /** 彩色模式 */
    Color = 0x01,
    /** 黑白模式 */
    Bw    = 0x02,
}

/** Zoom 快捷指令 (0x0A) 的子参数 */
export enum ZoomDirection {
    /** 放大倍率 */
    In  = 0x01,
    /** 缩小倍率 */
    Out = 0x02,
}

// ============================================================
// G1Camera — typed command args shared by buildCommandPacket & sendCommand
// ============================================================

/** Tuple type for G1 command parameters — inferred by both `buildCommandPacket` and `sendCommand`. */
export type G1CommandArgs = [paramId: number, rw: number, data?: Buffer, cmdWord?: number];

// ============================================================
// G1Camera Class — extends generic Driver for G1-camera protocol
// ============================================================

export class G1Camera extends Driver<G1CommandArgs, ParsedResponse> {
    private host: string = '';
    private port: number = DEFAULT_PORT;

    constructor(timeout: number = DEFAULT_TIMEOUT) {
        super(undefined, timeout);
    }

    // ---- Connection ----

    /**
     * 连接到 G1 相机
     * @param host 相机 IP 地址
     * @param port 相机端口，默认 8888
     */
    connect(host: string, port: number = DEFAULT_PORT): Promise<void> {
        return new Promise((resolve, reject) => {
            // Detach any previous connection
            this.detachStream();

            this.host = host;
            this.port = port;

            const sock = new net.Socket();

            const onError = (err: Error) => {
                sock.removeListener('connect', onConnect);
                reject(err);
            };

            const onConnect = () => {
                sock.removeListener('error', onError);
                this.attachStream(sock as Duplex);
                resolve();
            };

            sock.once('error', onError);
            sock.once('connect', onConnect);

            sock.connect(port, host);
        });
    }

    // ============================================================
    // Static helpers — usable without an instance (e.g. selfTest)
    // ============================================================

    /**
     * Build a G1 command packet.
     * @param cmdWord 命令字0 — 默认 0x07 (UI 参数获取/设置)，快捷操作为 0x01
     */
    static buildCommandPacket(paramId: number, rw: number, data?: Buffer, cmdWord: number = TYPE_CONFIG): Buffer {
        const dataLen = data ? data.length : 0;
        const totalLen = 5 + dataLen + 1; // header(1)+len(1)+type(1)+rw(1)+paramId(1) + data + checksum(1)

        const header = Buffer.from([HEADER_COMMAND, totalLen, cmdWord, rw, paramId]);
        const beforeCrc = data ? Buffer.concat([header, data]) : header;

        const c = crc8(beforeCrc);
        return Buffer.concat([beforeCrc, Buffer.from([c])]);
    }

    /**
     * Build a device-info request packet (协议 2.3.1).
     * Layout: [0xAA][len][0x00][param][subParam?][CRC]
     * 例：获取协议版本号 → aa 05 00 02 80
     */
    static buildDeviceInfoPacket(param: number, subParam?: number): Buffer {
        const bytes = [HEADER_COMMAND, 0, TYPE_DEVICE_INFO, param];
        if (subParam !== undefined) {
            bytes.push(subParam);
        }
        bytes[1] = bytes.length + 1; // 包含校验位
        const beforeCrc = Buffer.from(bytes);
        return Buffer.concat([beforeCrc, Buffer.from([crc8(beforeCrc)])]);
    }

    /**
     * Build a G1 quick-command packet (协议 2.3.2 快捷操作).
     * Layout: [0xAA][len][0x01][cmdId][subParam?][CRC] — len 为 5 (无子参数) 或 6.
     */
    static buildQuickCommandPacket(cmdId: number, subParam?: number): Buffer {
        const bytes = [HEADER_COMMAND, 0, TYPE_QUICK, cmdId];
        if (subParam !== undefined) {
            bytes.push(subParam);
        }
        bytes[1] = bytes.length + 1; // total length includes the checksum byte

        const beforeCrc = Buffer.from(bytes);
        const c = crc8(beforeCrc);
        return Buffer.concat([beforeCrc, Buffer.from([c])]);
    }

    /** Parse a raw G1 response packet.  Throws on any format / CRC failure. */
    static parseResponsePacket(packet: Buffer): ParsedResponse {
        if (packet.length < 2) {
            throw new Error('Response packet too short');
        }

        const header = packet[0];
        if (header !== HEADER_RESPONSE) {
            throw new Error(`Invalid response header: 0x${header.toString(16)}`);
        }

        const len = packet[1];
        if (packet.length < len) {
            throw new Error(`Incomplete response: expected ${len} bytes, got ${packet.length}`);
        }

        // CRC-8 over all bytes except the checksum itself
        const expectedCrc = crc8(packet.subarray(0, len - 1));
        if (expectedCrc !== packet[len - 1]) {
            throw new Error(
                `CRC mismatch: expected 0x${expectedCrc.toString(16).padStart(2, '0')}, ` +
                `got 0x${packet[len - 1].toString(16).padStart(2, '0')}`
            );
        }

        const cmdWord   = packet[2];
        const errorCode = packet[3];
        const dataType  = packet.length > 4 ? packet[4] : 0;
        const data      = packet.subarray(5, len - 1); // 参数数据（跳过数据类型字节）

        return { cmdWord, errorCode, dataType, data, rw: errorCode, status: dataType };
    }

    // ============================================================
    // Driver abstract method implementations (delegate to statics)
    // ============================================================

    protected buildCommandPacket(paramId: number, rw: number, data?: Buffer, cmdWord?: number): Buffer {
        if (cmdWord === TYPE_QUICK) {
            // 快捷操作: paramId = 指令 ID, data[0] = 可选子参数
            const sub = data && data.length > 0 ? data[0] : undefined;
            return G1Camera.buildQuickCommandPacket(paramId, sub);
        }
        if (cmdWord === TYPE_DEVICE_INFO) {
            // 设备信息: paramId = 参数, data[0] = 可选子参数
            const sub = data && data.length > 0 ? data[0] : undefined;
            return G1Camera.buildDeviceInfoPacket(paramId, sub);
        }
        return G1Camera.buildCommandPacket(paramId, rw, data, cmdWord);
    }

    protected parseResponsePacket(packet: Buffer): ParsedResponse {
        return G1Camera.parseResponsePacket(packet);
    }

    /**
     * Extract one complete G1 response packet from the receive buffer.
     *
     * G1 packets start with header 0x55, byte 1 is total length.
     * Garbage before the header is silently skipped.
     * If no header is found at all the entire buffer is cleared.
     */
    protected extractPacket(): ExtractResult | null {
        const buf = this.receiveBuffer;
        if (buf.length < 2) return null;

        const headerIdx = buf.indexOf(HEADER_RESPONSE);
        if (headerIdx === -1) {
            // No valid start marker — clear everything
            this.receiveBuffer = Buffer.alloc(0);
            return null;
        }

        const len = buf[headerIdx + 1];
        if (buf.length < headerIdx + len) return null; // incomplete packet

        const packet = buf.subarray(headerIdx, headerIdx + len);
        return { packet, consumed: headerIdx + len };
    }

    // ============================================================
    // High-level Param API
    // ============================================================

    /**
     * 读取参数值
     * @param paramId 参数 ID
     * @returns 整数值或字符串
     */
    async getParam(paramId: number): Promise<number | string> {
        const def = PARAM_DEFS[paramId];
        if (!def) throw new Error(`Unknown param ID: 0x${paramId.toString(16).toUpperCase()}`);

        const resp = await this.sendCommand(paramId, RW_GET);

        if (resp.errorCode !== 0x00) {
            throw new G1ProtocolError(
                resp.errorCode,
                resp.cmdWord,
                `GET param 0x${paramId.toString(16).toUpperCase()} failed: ` +
                `error code 0x${resp.errorCode.toString(16)} (${ERROR_CODE_TEXT[resp.errorCode] ?? '未知'})`
            );
        }

        if (def.type === ParamType.String) {
            return resp.data.toString('ascii');
        }

        // Int type — 参数数据以字节 0 开始（dataType 已被剔除）
        // 部分参数（如 0x00 照片分辨率）先返回全部可设值，当前值在最后一个字节
        if (def.byteCount === 2) {
            return resp.data.length >= 2 ? resp.data.readUInt16LE(0) : 0;
        }
        return resp.data.length > 0 ? resp.data[resp.data.length - 1] : 0;
    }

    /**
     * 设置参数值
     * @param paramId 参数 ID
     * @param value 整数值或字符串
     */
    async setParam(paramId: number, value: number | string): Promise<void> {
        const def = PARAM_DEFS[paramId];
        if (!def) throw new Error(`Unknown param ID: 0x${paramId.toString(16).toUpperCase()}`);

        let data: Buffer;
        if (def.type === ParamType.String) {
            data = Buffer.from(String(value), 'ascii');
        } else {
            const num = Number(value);
            if (def.byteCount === 2) {
                data = Buffer.alloc(2);
                data.writeUInt16LE(num, 0);
            } else {
                data = Buffer.from([num]);
            }
        }

        const resp = await this.sendCommand(paramId, RW_SET, data);
        if (resp.errorCode !== 0x00) {
            throw new G1ProtocolError(
                resp.errorCode,
                resp.cmdWord,
                `SET param 0x${paramId.toString(16).toUpperCase()} failed: ` +
                `error code 0x${resp.errorCode.toString(16)} (${ERROR_CODE_TEXT[resp.errorCode] ?? '未知'})`
            );
        }
    }

    /**
     * 原始 GET 请求 — 不依赖 PARAM_DEFS，用于探测/诊断相机支持哪些参数 ID。
     * 不检查错误码，直接返回解析结果。
     */
    async getParamRaw(paramId: number): Promise<ParsedResponse> {
        return this.sendCommand(paramId, RW_GET);
    }

    /**
     * 获取协议版本号（设备信息命令 0x00/0x02），如 "G1F02.3.0"
     */
    async getProtocolVersion(): Promise<string> {
        const resp = await this.sendCommand(0x02, 0x00, undefined, TYPE_DEVICE_INFO);
        if (resp.errorCode !== 0x00) {
            throw new G1ProtocolError(resp.errorCode, resp.cmdWord, `获取协议版本号失败: ${ERROR_CODE_TEXT[resp.errorCode] ?? '未知'}`);
        }
        return resp.data.toString('ascii');
    }

    /**
     * 获取相机版本号（设备信息命令 0x00/0x01）
     */
    async getCameraVersion(): Promise<string> {
        const resp = await this.sendCommand(0x01, 0x00, undefined, TYPE_DEVICE_INFO);
        if (resp.errorCode !== 0x00) {
            throw new G1ProtocolError(resp.errorCode, resp.cmdWord, `获取相机版本号失败: ${ERROR_CODE_TEXT[resp.errorCode] ?? '未知'}`);
        }
        return resp.data.toString('ascii');
    }

    // ============================================================
    // High-level Named API — 照片参数
    // ============================================================

    async getImageSize(): Promise<number>                    { return this.getParam(0x00) as Promise<number>; }
    async setImageSize(value: number): Promise<void>         { return this.setParam(0x00, value); }

    async getPhotoDelayTimer(): Promise<number>              { return this.getParam(0x01) as Promise<number>; }
    async setPhotoDelayTimer(value: number): Promise<void>   { return this.setParam(0x01, value); }

    async getPhotoLDC(): Promise<number>                     { return this.getParam(0x02) as Promise<number>; }
    async setPhotoLDC(value: number): Promise<void>          { return this.setParam(0x02, value); }

    async getPhotoTimeLapseInterval(): Promise<number>       { return this.getParam(0x03) as Promise<number>; }
    async setPhotoTimeLapseInterval(value: number): Promise<void> { return this.setParam(0x03, value); }

    async getTimeLapsePhotoShootingTime(): Promise<number>   { return this.getParam(0x04) as Promise<number>; }
    async setTimeLapsePhotoShootingTime(value: number): Promise<void> { return this.setParam(0x04, value); }

    async getStillStampMode(): Promise<number>               { return this.getParam(0x05) as Promise<number>; }
    async setStillStampMode(value: number): Promise<void>    { return this.setParam(0x05, value); }

    async getCapRotation(): Promise<number>                  { return this.getParam(0x3F) as Promise<number>; }
    async setCapRotation(value: number): Promise<void>       { return this.setParam(0x3F, value); }

    // ---- 录像参数 ----

    async getVideoSize(): Promise<number>                    { return this.getParam(0x07) as Promise<number>; }
    async setVideoSize(value: number): Promise<void>         { return this.setParam(0x07, value); }

    async getFrameRate(): Promise<number>                    { return this.getParam(0x08) as Promise<number>; }
    async setFrameRate(value: number): Promise<void>         { return this.setParam(0x08, value); }

    async getSlowMotionMode(): Promise<number>               { return this.getParam(0x09) as Promise<number>; }
    async setSlowMotionMode(value: number): Promise<void>    { return this.setParam(0x09, value); }

    async getVideoFastMotion(): Promise<number>              { return this.getParam(0x0A) as Promise<number>; }
    async setVideoFastMotion(value: number): Promise<void>   { return this.setParam(0x0A, value); }

    async getVideoTimeLapseInterval(): Promise<number>       { return this.getParam(0x0B) as Promise<number>; }
    async setVideoTimeLapseInterval(value: number): Promise<void> { return this.setParam(0x0B, value); }

    async getTimeLapseVideoShootingTime(): Promise<number>   { return this.getParam(0x0C) as Promise<number>; }
    async setTimeLapseVideoShootingTime(value: number): Promise<void> { return this.setParam(0x0C, value); }

    async getPreRec(): Promise<number>                       { return this.getParam(0x0D) as Promise<number>; }
    async setPreRec(value: number): Promise<void>            { return this.setParam(0x0D, value); }

    async getVideoImageStabilization(): Promise<number>      { return this.getParam(0x0E) as Promise<number>; }
    async setVideoImageStabilization(value: number): Promise<void> { return this.setParam(0x0E, value); }

    async getVideoQuality(): Promise<number>                 { return this.getParam(0x10) as Promise<number>; }
    async setVideoQuality(value: number): Promise<void>      { return this.setParam(0x10, value); }

    async getRotation(): Promise<number>                     { return this.getParam(0x11) as Promise<number>; }
    async setRotation(value: number): Promise<void>          { return this.setParam(0x11, value); }

    async getLdc(): Promise<number>                          { return this.getParam(0x13) as Promise<number>; }
    async setLdc(value: number): Promise<void>               { return this.setParam(0x13, value); }

    async getMetering(): Promise<number>                     { return this.getParam(0x14) as Promise<number>; }
    async setMetering(value: number): Promise<void>          { return this.setParam(0x14, value); }

    async getSeamless(): Promise<number>                     { return this.getParam(0x15) as Promise<number>; }
    async setSeamless(value: number): Promise<void>          { return this.setParam(0x15, value); }

    async getCyclicRec(): Promise<number>                    { return this.getParam(0x16) as Promise<number>; }
    async setCyclicRec(value: number): Promise<void>         { return this.setParam(0x16, value); }

    async getRecVol(): Promise<number>                       { return this.getParam(0x17) as Promise<number>; }
    async setRecVol(value: number): Promise<void>            { return this.setParam(0x17, value); }

    async getVideoStampMode(): Promise<number>               { return this.getParam(0x18) as Promise<number>; }
    async setVideoStampMode(value: number): Promise<void>    { return this.setParam(0x18, value); }

    async getVideoFileFormat(): Promise<number>              { return this.getParam(0x19) as Promise<number>; }
    async setVideoFileFormat(value: number): Promise<void>   { return this.setParam(0x19, value); }

    async getVideoVFI(): Promise<number>                     { return this.getParam(0x1A) as Promise<number>; }
    async setVideoVFI(value: number): Promise<void>          { return this.setParam(0x1A, value); }

    // ---- 系统设置 ----

    async getScreenSaverTime(): Promise<number>              { return this.getParam(0x1B) as Promise<number>; }
    async setScreenSaverTime(value: number): Promise<void>   { return this.setParam(0x1B, value); }

    async getSleepTime(): Promise<number>                    { return this.getParam(0x1C) as Promise<number>; }
    async setSleepTime(value: number): Promise<void>         { return this.setParam(0x1C, value); }

    async getAutoRecording(): Promise<number>                { return this.getParam(0x1D) as Promise<number>; }
    async setAutoRecording(value: number): Promise<void>     { return this.setParam(0x1D, value); }

    async getLightFreq(): Promise<number>                    { return this.getParam(0x1F) as Promise<number>; }
    async setLightFreq(value: number): Promise<void>         { return this.setParam(0x1F, value); }

    async getBeepSound(): Promise<number>                    { return this.getParam(0x20) as Promise<number>; }
    async setBeepSound(value: number): Promise<void>         { return this.setParam(0x20, value); }

    async getVolume(): Promise<number>                       { return this.getParam(0x21) as Promise<number>; }
    async setVolume(value: number): Promise<void>            { return this.setParam(0x21, value); }

    async getSoundChoice(): Promise<number>                  { return this.getParam(0x22) as Promise<number>; }
    async setSoundChoice(value: number): Promise<void>       { return this.setParam(0x22, value); }

    async getAudioCodec(): Promise<number>                   { return this.getParam(0x23) as Promise<number>; }
    async setAudioCodec(value: number): Promise<void>        { return this.setParam(0x23, value); }

    async getSwitchSecondAudio(): Promise<number>            { return this.getParam(0x24) as Promise<number>; }
    async setSwitchSecondAudio(value: number): Promise<void> { return this.setParam(0x24, value); }

    async getAutoOpenWifi(): Promise<number>                 { return this.getParam(0x25) as Promise<number>; }
    async setAutoOpenWifi(value: number): Promise<void>      { return this.setParam(0x25, value); }

    async getWifiFrequencyBand(): Promise<number>            { return this.getParam(0x26) as Promise<number>; }
    async setWifiFrequencyBand(value: number): Promise<void> { return this.setParam(0x26, value); }

    async getFillLightA(): Promise<number>                   { return this.getParam(0x27) as Promise<number>; }
    async setFillLightA(value: number): Promise<void>        { return this.setParam(0x27, value); }

    async getFillLightB(): Promise<number>                   { return this.getParam(0x28) as Promise<number>; }
    async setFillLightB(value: number): Promise<void>        { return this.setParam(0x28, value); }

    async getIrCut(): Promise<number>                        { return this.getParam(0x29) as Promise<number>; }
    async setIrCut(value: number): Promise<void>             { return this.setParam(0x29, value); }

    async getUsbMode(): Promise<number>                      { return this.getParam(0x31) as Promise<number>; }
    async setUsbMode(value: number): Promise<void>           { return this.setParam(0x31, value); }

    async getAutoWifiRec(): Promise<number>                  { return this.getParam(0x32) as Promise<number>; }
    async setAutoWifiRec(value: number): Promise<void>       { return this.setParam(0x32, value); }

    async getHdmiSize(): Promise<number>                     { return this.getParam(0x33) as Promise<number>; }
    async setHdmiSize(value: number): Promise<void>          { return this.setParam(0x33, value); }

    async getUvcBitrate(): Promise<number>                   { return this.getParam(0x34) as Promise<number>; }
    async setUvcBitrate(value: number): Promise<void>        { return this.setParam(0x34, value); }

    async getUsbAutoPWROn(): Promise<number>                 { return this.getParam(0x35) as Promise<number>; }
    async setUsbAutoPWROn(value: number): Promise<void>      { return this.setParam(0x35, value); }

    async getInvertMode(): Promise<number>                   { return this.getParam(0x36) as Promise<number>; }
    async setInvertMode(value: number): Promise<void>        { return this.setParam(0x36, value); }

    async getWifiAutoClose(): Promise<number>                { return this.getParam(0x37) as Promise<number>; }
    async setWifiAutoClose(value: number): Promise<void>     { return this.setParam(0x37, value); }

    async getWifiMode(): Promise<number>                     { return this.getParam(0x38) as Promise<number>; }
    async setWifiMode(value: number): Promise<void>          { return this.setParam(0x38, value); }

    async getIqStamp(): Promise<number>                      { return this.getParam(0x39) as Promise<number>; }
    async setIqStamp(value: number): Promise<void>           { return this.setParam(0x39, value); }

    async getStaticIP(): Promise<number>                     { return this.getParam(0x3A) as Promise<number>; }
    async setStaticIP(value: number): Promise<void>          { return this.setParam(0x3A, value); }

    async getPortNumber(): Promise<number>                   { return this.getParam(0x3B) as Promise<number>; }
    async setPortNumber(value: number): Promise<void>        { return this.setParam(0x3B, value); }

    // ---- 字符串参数 ----

    async getWifiSSID(): Promise<string>                     { return this.getParam(0x7F) as Promise<string>; }
    async setWifiSSID(value: string): Promise<void>          { return this.setParam(0x7F, value); }

    async getWifiPassword(): Promise<string>                 { return this.getParam(0x80) as Promise<string>; }
    async setWifiPassword(value: string): Promise<void>      { return this.setParam(0x80, value); }

    async getCustomWifiSSID(): Promise<string>               { return this.getParam(0x81) as Promise<string>; }
    async setCustomWifiSSID(value: string): Promise<void>    { return this.setParam(0x81, value); }

    async getCustomWifiPassword(): Promise<string>           { return this.getParam(0x82) as Promise<string>; }
    async setCustomWifiPassword(value: string): Promise<void> { return this.setParam(0x82, value); }

    /**
     * 获取相机 IP 地址
     */
    async getIp(): Promise<string>                           { return this.getParam(0x83) as Promise<string>; }
    /**
     * 设置相机 IP 地址（设置后相机可能重启网络，连接会断开）
     */
    async setIp(ip: string): Promise<void>                   { return this.setParam(0x83, ip); }

    async getNetGateway(): Promise<string>                   { return this.getParam(0x84) as Promise<string>; }
    async setNetGateway(gateway: string): Promise<void>      { return this.setParam(0x84, gateway); }

    /**
     * 获取相机时间（格式: YYYY-MM-DD HH:MM:SS）
     */
    async getCameraTime(): Promise<string>                   { return this.getParam(0x85) as Promise<string>; }
    /**
     * 设置相机时间（格式: YYYY-MM-DD HH:MM:SS，需大于当前时间）
     */
    async setCameraTime(time: string): Promise<void>         { return this.setParam(0x85, time); }

    // ============================================================
    // High-level Quick-Command API — 快捷操作 (协议 2.3.2)
    // ============================================================

    /**
     * 发送快捷操作指令（命令字0 = 0x01）。
     * 响应错误码为 0x00 视为成功，否则抛出错误。
     * @param cmdId     指令 ID（见 QuickCmd）
     * @param subParam  可选子参数（ColorMode / ZoomDirection）
     */
    async quickCommand(cmdId: number, subParam?: number): Promise<void> {
        const resp = await this.sendCommand(
            cmdId,
            RW_SET,
            subParam === undefined ? undefined : Buffer.from([subParam]),
            TYPE_QUICK,
        );
        if (resp.errorCode !== 0x00) {
            throw new G1ProtocolError(
                resp.errorCode,
                resp.cmdWord,
                `Quick command 0x${cmdId.toString(16).padStart(2, '0')} failed: ` +
                `error code 0x${resp.errorCode.toString(16).padStart(2, '0')} (${ERROR_CODE_TEXT[resp.errorCode] ?? '未知'})`
            );
        }
    }

    /**
     * 发送可能导致连接断开的快捷指令（重启 / 关 WiFi 等）。
     * 指令发出后相机主动断开 TCP 属于预期行为，此时视为成功。
     */
    private async sendQuickCommandAllowDrop(cmdId: number, subParam?: number): Promise<void> {
        try {
            await this.quickCommand(cmdId, subParam);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // 相机重启/关闭WiFi 会主动断开连接，属预期行为
            if (/(connection closed|disconnected|econnreset|connection reset|socket hang up)/i.test(msg)) {
                return;
            }
            throw err;
        }
    }

    /** 开/关 WiFi — 关闭 WiFi 时连接会断开（断开视为成功） */
    async toggleWifi(): Promise<void>          { return this.sendQuickCommandAllowDrop(QuickCmd.ToggleWifi); }

    /** 快捷拍照 — 不管在哪种模式下都执行拍照 */
    async capturePhoto(): Promise<void>        { return this.quickCommand(QuickCmd.Capture); }

    /** 快捷录像 — 不管在哪种模式下都执行录像（再次发送同指令停止录像） */
    async toggleRecord(): Promise<void>        { return this.quickCommand(QuickCmd.Record); }

    /** 格式化存储卡 */
    async formatSDCard(): Promise<void>        { return this.quickCommand(QuickCmd.FormatSD); }

    /** 设置彩色/黑白模式 */
    async setColorMode(mode: ColorMode): Promise<void> { return this.quickCommand(QuickCmd.ColorMode, mode); }

    /** 相机陀螺仪校准 */
    async calibrateGyro(): Promise<void>       { return this.quickCommand(QuickCmd.GyroCalib); }

    /**
     * 设备重启 — 相机重启后 TCP 连接会断开（断开视为成功）。
     * 重启完成后需要重新 connect() 才能继续控制相机。
     */
    async reboot(): Promise<void>              { return this.sendQuickCommandAllowDrop(QuickCmd.Reboot); }

    /** 变焦 — 放大/缩小倍率 */
    async zoom(direction: ZoomDirection): Promise<void> { return this.quickCommand(QuickCmd.Zoom, direction); }
}
