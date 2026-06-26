import {
    HEADER_COMMAND,
    HEADER_RESPONSE,
    RW_GET,
    RW_SET,
    ParamType,
    ParamDef,
    ParsedResponse,
    PARAM_DEFS,
    crc8,
    buildCommandPacket,
    parseResponsePacket,
    G1Camera,
} from './G1Camera';
import { Driver, ExtractResult, PendingCommand, DEFAULT_TIMEOUT as DRIVER_DEFAULT_TIMEOUT } from './Driver';

// ============================================================
// Export public API
// ============================================================

export {
    // Generic driver base class
    Driver,
    ExtractResult,
    PendingCommand,
    DRIVER_DEFAULT_TIMEOUT,
    // G1-specific protocol
    crc8,
    buildCommandPacket,
    parseResponsePacket,
    HEADER_COMMAND,
    HEADER_RESPONSE,
    RW_GET,
    RW_SET,
    ParamType,
    ParamDef,
    ParsedResponse,
    PARAM_DEFS,
    G1Camera,
};

// ============================================================
// Dump all params
// ============================================================

async function dumpAll(camera: G1Camera): Promise<void> {
    // 照片参数
    const photoParams: [string, () => Promise<number | string>][] = [
        ['ImageSize', () => camera.getImageSize()],
        ['PhotoDelayTimer', () => camera.getPhotoDelayTimer()],
        ['PhotoLDC', () => camera.getPhotoLDC()],
        ['PhotoTimeLapseInterval', () => camera.getPhotoTimeLapseInterval()],
        ['TimeLapsePhotoShootingTime', () => camera.getTimeLapsePhotoShootingTime()],
        ['StillStampMode', () => camera.getStillStampMode()],
        ['CapRotation', () => camera.getCapRotation()],
    ];

    // 录像参数
    const videoParams: [string, () => Promise<number | string>][] = [
        ['VideoSize', () => camera.getVideoSize()],
        ['FrameRate', () => camera.getFrameRate()],
        ['SlowMotionMode', () => camera.getSlowMotionMode()],
        ['VideoFastMotion', () => camera.getVideoFastMotion()],
        ['VideoTimeLapseInterval', () => camera.getVideoTimeLapseInterval()],
        ['TimeLapseVideoShootingTime', () => camera.getTimeLapseVideoShootingTime()],
        ['PreRec', () => camera.getPreRec()],
        ['VideoImageStabilization', () => camera.getVideoImageStabilization()],
        ['VideoQuality', () => camera.getVideoQuality()],
        ['Rotation', () => camera.getRotation()],
        ['Ldc', () => camera.getLdc()],
        ['Metering', () => camera.getMetering()],
        ['Seamless', () => camera.getSeamless()],
        ['CyclicRec', () => camera.getCyclicRec()],
        ['RecVol', () => camera.getRecVol()],
        ['VideoStampMode', () => camera.getVideoStampMode()],
        ['VideoFileFormat', () => camera.getVideoFileFormat()],
        ['VideoVFI', () => camera.getVideoVFI()],
    ];

    // 系统设置
    const sysParams: [string, () => Promise<number | string>][] = [
        ['ScreenSaverTime', () => camera.getScreenSaverTime()],
        ['SleepTime', () => camera.getSleepTime()],
        ['AutoRecording', () => camera.getAutoRecording()],
        ['LightFreq', () => camera.getLightFreq()],
        ['BeepSound', () => camera.getBeepSound()],
        ['Volume', () => camera.getVolume()],
        ['SoundChoice', () => camera.getSoundChoice()],
        ['AudioCodec', () => camera.getAudioCodec()],
        ['SwitchSecondAudio', () => camera.getSwitchSecondAudio()],
        ['AutoOpenWifi', () => camera.getAutoOpenWifi()],
        ['WifiFrequencyBand', () => camera.getWifiFrequencyBand()],
        ['FillLightA', () => camera.getFillLightA()],
        ['FillLightB', () => camera.getFillLightB()],
        ['IrCut', () => camera.getIrCut()],
        ['UsbMode', () => camera.getUsbMode()],
        ['AutoWifiRec', () => camera.getAutoWifiRec()],
        ['HdmiSize', () => camera.getHdmiSize()],
        ['UvcBitrate', () => camera.getUvcBitrate()],
        ['UsbAutoPWROn', () => camera.getUsbAutoPWROn()],
        ['InvertMode', () => camera.getInvertMode()],
        ['WifiAutoClose', () => camera.getWifiAutoClose()],
        ['WifiMode', () => camera.getWifiMode()],
        ['IqStamp', () => camera.getIqStamp()],
        ['StaticIP', () => camera.getStaticIP()],
        ['PortNumber', () => camera.getPortNumber()],
    ];

    // 字符串参数
    const strParams: [string, () => Promise<number | string>][] = [
        ['WifiSSID', () => camera.getWifiSSID()],
        ['WifiPassword', () => camera.getWifiPassword()],
        ['CustomWifiSSID', () => camera.getCustomWifiSSID()],
        ['CustomWifiPassword', () => camera.getCustomWifiPassword()],
        ['Ip', () => camera.getIp()],
        ['NetGateway', () => camera.getNetGateway()],
        ['CameraTime', () => camera.getCameraTime()],
    ];

    const sections: [string, [string, () => Promise<number | string>][]][] = [
        ['照片参数', photoParams],
        ['录像参数', videoParams],
        ['系统设置', sysParams],
        ['字符串参数', strParams],
    ];

    for (const [title, params] of sections) {
        console.log(`\n--- ${title} ---`);
        for (const [name, fn] of params) {
            try {
                const val = await fn();
                console.log(`  ${name}: ${val}`);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                console.log(`  ${name}: ERROR — ${msg}`);
            }
        }
    }
}

// ============================================================
// main() — 示例入口
// ============================================================

export async function main() {
    const camera = new G1Camera();

    // 通过 TCP 连接相机（默认端口 8888）
    await camera.connect('192.168.1.65', 8888);
    console.log('Connected to camera');

    // 设置相机IP地址
    // await camera.setIp('192.168.1.65')

    // 打印所有参数
    await dumpAll(camera);

    camera.disconnect();
}

main()
