// Verify generated packets against doc examples (协议 2.3.2 / 6.0 / xlsx)
import { G1Camera, QuickCmd } from '../G1Camera';

const hex = (b: Buffer): string => b.toString('hex').replace(/(..)/g, '$1 ').trim().toLowerCase();

const cases: [string, Buffer, string][] = [
    ['SwitchMode 切换模式', G1Camera.buildQuickCommandPacket(QuickCmd.SwitchMode), 'aa 05 01 01 21'],
    ['ToggleWifi 开/关wifi', G1Camera.buildQuickCommandPacket(QuickCmd.ToggleWifi), 'aa 05 01 03 5e'],
    ['Capture 快捷拍照', G1Camera.buildQuickCommandPacket(QuickCmd.Capture), 'aa 05 01 04 0a'],
    ['Record 快捷录像', G1Camera.buildQuickCommandPacket(QuickCmd.Record), 'aa 05 01 05 df'],
    ['FormatSD 格式化卡', G1Camera.buildQuickCommandPacket(QuickCmd.FormatSD), 'aa 05 01 06 75'],
    ['ColorMode 彩色', G1Camera.buildQuickCommandPacket(QuickCmd.ColorMode, 0x01), 'aa 06 01 07 01 51'],
    ['ColorMode 黑白', G1Camera.buildQuickCommandPacket(QuickCmd.ColorMode, 0x02), 'aa 06 01 07 02 fb'],
    ['GyroCalib 陀螺仪校准', G1Camera.buildQuickCommandPacket(QuickCmd.GyroCalib), 'aa 05 01 08 dd'],
    ['Reboot 设备重启', G1Camera.buildQuickCommandPacket(QuickCmd.Reboot), 'aa 05 01 09 08'],
    ['Zoom 放大', G1Camera.buildQuickCommandPacket(QuickCmd.Zoom, 0x01), 'aa 06 01 0a 01 2e'],
    ['Zoom 缩小', G1Camera.buildQuickCommandPacket(QuickCmd.Zoom, 0x02), 'aa 06 01 0a 02 84'],
    // 回归: 原有配置参数包不受影响 (xlsx 示例)
    ['getIp 获取IP', G1Camera.buildCommandPacket(0x83, 0x00), 'aa 06 07 00 83 50'],
    ['setTime 设置时间', G1Camera.buildCommandPacket(0x85, 0x01, Buffer.from('2024-01-01 05:15:41', 'ascii')), 'aa 19 07 01 85 32 30 32 34 2d 30 31 2d 30 31 20 30 35 3a 31 35 3a 34 31 1a'],
    // 设备信息 (协议 2.3.1)
    ['getCameraVersion 相机版本', G1Camera.buildDeviceInfoPacket(0x01), 'aa 05 00 01 2a'],
    ['getProtocolVersion 协议版本', G1Camera.buildDeviceInfoPacket(0x02), 'aa 05 00 02 80'],
];

let ok = true;
for (const [name, got, want] of cases) {
    const gotHex = hex(got);
    const pass = gotHex === want;
    if (!pass) ok = false;
    console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}: ${gotHex}${pass ? '' : ` (expect ${want})`}`);
}
if (ok) console.log('ALL PACKETS MATCH DOC');
else process.exit(1);
