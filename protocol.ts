// ============================================================
// Constants
// ============================================================

export const HEADER_COMMAND  = 0xAA;
export const HEADER_RESPONSE = 0x55;
export const TYPE_CONFIG     = 0x07;
export const RW_GET          = 0x00;
export const RW_SET          = 0x01;

const CRC_POLY = 0xD5;

export const DEFAULT_PORT    = 8888;
export const DEFAULT_TIMEOUT = 5000;

// ============================================================
// Types & Interfaces
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

export interface ParsedResponse {
    rw: number;
    status: number;
    data: Buffer;
}

export interface PendingCommand {
    resolve: (value: ParsedResponse) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
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
// Packet Build / Parse
// ============================================================

export function buildCommandPacket(paramId: number, rw: number, data?: Buffer): Buffer {
    const dataLen = data ? data.length : 0;
    const totalLen = 5 + dataLen + 1; // header + len + type + rw + paramId + data + checksum

    const header = Buffer.from([HEADER_COMMAND, totalLen, TYPE_CONFIG, rw, paramId]);
    const beforeCrc = data ? Buffer.concat([header, data]) : header;

    const c = crc8(beforeCrc);
    const packet = Buffer.concat([beforeCrc, Buffer.from([c])]);
    return packet;
}

export function parseResponsePacket(buffer: Buffer): ParsedResponse | null {
    if (buffer.length < 2) return null;           // need header + length

    const header = buffer[0];
    if (header !== HEADER_RESPONSE) return null;  // not a valid response start

    const len = buffer[1];
    if (buffer.length < len) return null;          // incomplete packet

    const packet = buffer.subarray(0, len);

    // Verify CRC-8 over all bytes except the checksum itself
    const expectedCrc = crc8(packet.subarray(0, len - 1));
    if (expectedCrc !== packet[len - 1]) {
        throw new Error(
            `CRC mismatch: expected 0x${expectedCrc.toString(16).padStart(2, '0')}, ` +
            `got 0x${packet[len - 1].toString(16).padStart(2, '0')}`
        );
    }

    const rw     = packet[3];
    // byte 4+ is the payload: for GET-int it's [value], for GET-str it's [0x00, string...], for SET it's [0x02, echoed...]
    const status = packet.length > 4 ? packet[4] : 0;
    const data   = packet.subarray(4, len - 1); // data starts at byte 4

    return { rw, status, data };
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
