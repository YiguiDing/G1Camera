import * as net from 'net';
import {
    HEADER_RESPONSE,
    DEFAULT_PORT,
    DEFAULT_TIMEOUT,
    ParamType,
    ParsedResponse,
    PendingCommand,
    buildCommandPacket,
    parseResponsePacket,
    PARAM_DEFS,
    RW_GET,
    RW_SET,
} from './protocol';

// ============================================================
// G1Camera Class
// ============================================================

export class G1Camera {
    private socket: net.Socket | null = null;
    private receiveBuffer: Buffer = Buffer.alloc(0);
    private pending: PendingCommand | null = null;
    private host: string = '';
    private port: number = DEFAULT_PORT;
    private timeout: number = DEFAULT_TIMEOUT;

    // ---- Connection ----

    /**
     * 连接到 G1 相机
     * @param host 相机 IP 地址
     * @param port 相机端口，默认 8888
     */
    connect(host: string, port: number = DEFAULT_PORT): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.socket) {
                this.disconnect();
            }

            this.host = host;
            this.port = port;
            this.receiveBuffer = Buffer.alloc(0);

            const sock = new net.Socket();
            this.socket = sock;

            const onError = (err: Error) => {
                sock.removeListener('connect', onConnect);
                reject(err);
            };

            const onConnect = () => {
                sock.removeListener('error', onError);
                resolve();
            };

            sock.once('error', onError);
            sock.once('connect', onConnect);

            sock.on('data', (chunk: Buffer) => this.onData(chunk));
            sock.on('close', () => this.onClose());
            sock.on('error', (err: Error) => this.onError(err));

            sock.connect(port, host);
        });
    }

    /**
     * 断开与相机的连接
     */
    disconnect(): void {
        if (this.pending) {
            clearTimeout(this.pending.timer);
            this.pending.reject(new Error('Disconnected'));
            this.pending = null;
        }
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
    }

    /**
     * 是否已连接
     */
    isConnected(): boolean {
        return this.socket !== null && !this.socket.destroyed;
    }

    // ---- Low-level Send ----

    /**
     * 直接发送原始数据到相机（底层接口）
     * @param data 要发送的数据
     */
    send(data: Buffer | number[]): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.socket || this.socket.destroyed) {
                return reject(new Error('Not connected'));
            }
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
            this.socket.write(buf, (err) => {
                if (err) return reject(err);
                resolve();
            });
        });
    }

    // ---- Core Protocol ----

    /**
     * 发送命令并等待响应
     */
    private sendCommand(paramId: number, rw: number, data?: Buffer): Promise<ParsedResponse> {
        return new Promise((resolve, reject) => {
            if (!this.socket || this.socket.destroyed) {
                return reject(new Error('Not connected'));
            }
            if (this.pending) {
                return reject(new Error('Command already in progress'));
            }

            const packet = buildCommandPacket(paramId, rw, data);

            const timer = setTimeout(() => {
                this.pending = null;
                reject(new Error(`Command timeout (${this.timeout}ms)`));
            }, this.timeout);

            this.pending = { resolve, reject, timer };

            this.socket.write(packet, (err) => {
                if (err) {
                    clearTimeout(timer);
                    this.pending = null;
                    reject(err);
                }
            });
        });
    }

    /**
     * 读取参数值
     * @param paramId 参数 ID
     * @returns 整数值或字符串
     */
    async getParam(paramId: number): Promise<number | string> {
        const def = PARAM_DEFS[paramId];
        if (!def) throw new Error(`Unknown param ID: 0x${paramId.toString(16).toUpperCase()}`);

        const resp = await this.sendCommand(paramId, RW_GET);
        // CRC already validates packet integrity; byte4 indicates payload type:
        // 0 = GET返回字符串, 1 = GET返回整数, 2 = SET确认
        // For GET, byte4 IS the value for int params, so we don't check it as status

        if (def.type === ParamType.String) {
            // data = [0x00, string_bytes...], skip the leading type byte
            return resp.data.length > 1 ? resp.data.subarray(1).toString('ascii') : '';
        }

        // Int type
        if (def.byteCount === 2) {
            // 2字节参数响应: data = [0x01, low, high], 跳过 type byte
            return resp.data.length >= 3 ? resp.data.readUInt16LE(1) : resp.data.readUInt16LE(0);
        }
        // 1字节参数: data = [value], 无 type byte 前缀
        return resp.data.length > 0 ? resp.data[0] : 0;
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
        // SET 响应 data[0]=0x02 表示成功，其他值表示失败
        if (resp.data.length === 0 || (resp.data[0] !== 0x00 && resp.data[0] !== 0x02)) {
            throw new Error(`SET param 0x${paramId.toString(16)} failed: ack=${resp.data.length > 0 ? resp.data[0] : 'none'}`);
        }
    }

    // ---- Stream Handling ----

    private onData(chunk: Buffer): void {
        this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
        this.tryExtractResponse();
    }

    private tryExtractResponse(): void {
        while (this.receiveBuffer.length >= 2) {
            // Scan for response header 0x55
            const headerIdx = this.receiveBuffer.indexOf(HEADER_RESPONSE);
            if (headerIdx === -1) {
                this.receiveBuffer = Buffer.alloc(0);
                return;
            }
            if (headerIdx > 0) {
                this.receiveBuffer = this.receiveBuffer.subarray(headerIdx);
            }

            if (this.receiveBuffer.length < 2) return;

            const len = this.receiveBuffer[1];
            if (this.receiveBuffer.length < len) return;

            const packet = this.receiveBuffer.subarray(0, len);
            try {
                const parsed = parseResponsePacket(packet);
                if (!parsed) {
                    return;
                }
                this.receiveBuffer = this.receiveBuffer.subarray(len);
                this.handleResponse(parsed);
            } catch (err: unknown) {
                this.receiveBuffer = this.receiveBuffer.subarray(1);
                if (this.pending) {
                    clearTimeout(this.pending.timer);
                    this.pending.reject(err as Error);
                    this.pending = null;
                }
            }
        }
    }

    private handleResponse(parsed: ParsedResponse): void {
        if (this.pending) {
            clearTimeout(this.pending.timer);
            const p = this.pending;
            this.pending = null;
            p.resolve(parsed);
        }
    }

    private onClose(): void {
        if (this.pending) {
            clearTimeout(this.pending.timer);
            this.pending.reject(new Error('Connection closed'));
            this.pending = null;
        }
        this.socket = null;
    }

    private onError(err: Error): void {
        if (this.pending) {
            clearTimeout(this.pending.timer);
            this.pending.reject(err);
            this.pending = null;
        }
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
}
