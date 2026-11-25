// 用协议文档中的真实回复包验证 parseResponsePacket 的字段解析
import { G1Camera } from '../G1Camera';

const hexToBuf = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'hex');

interface Case {
    name: string;
    packet: string;
    expect: { cmdWord: number; errorCode: number; dataType: number; dataHex: string };
}

const cases: Case[] = [
    {
        // 获取拍照分辨率: 55 0F 07 00 01 00 01 02 03 04 05 06 07 02 43
        name: 'get imageSize',
        packet: '55 0F 07 00 01 00 01 02 03 04 05 06 07 02 43',
        expect: { cmdWord: 0x07, errorCode: 0x00, dataType: 0x01, dataHex: '00 01 02 03 04 05 06 07 02' },
    },
    {
        // 设置拍照分辨率: 55 07 07 00 01 01 A6
        name: 'set imageSize',
        packet: '55 07 07 00 01 01 A6',
        expect: { cmdWord: 0x07, errorCode: 0x00, dataType: 0x01, dataHex: '01' },
    },
    {
        // 获取自定义wifi名称: 55 09 07 00 02 47 31 45 1B → "G1E"
        name: 'get customWifiSSID',
        packet: '55 09 07 00 02 47 31 45 1B',
        expect: { cmdWord: 0x07, errorCode: 0x00, dataType: 0x02, dataHex: '47 31 45' },
    },
    {
        // 获取相机时间: 55 19 00 00 02 "2022-01-01 00:09:24" 0C
        name: 'get cameraTime',
        packet: '55 19 00 00 02 32 30 32 32 2D 30 31 2D 30 31 20 30 30 3A 30 39 3A 32 34 0C',
        expect: { cmdWord: 0x00, errorCode: 0x00, dataType: 0x02, dataHex: '32 30 32 32 2D 30 31 2D 30 31 20 30 30 3A 30 39 3A 32 34' },
    },
    {
        // 获取协议版本号: 55 0F 00 00 02 "G1F02.3.0" <crc>
        // 文档示例为 55 0E ... B3，但 9 字符版本串 + 5 字节头 + 校验 = 15 (0x0F)，
        // 且按 0x0E/0x0F 计算的 CRC 均不等于 B3 —— 文档此条示例自身矛盾，按算法重建。
        name: 'get protocol version',
        packet: '55 0F 00 00 02 47 31 46 30 32 2E 33 2E 30 00',
        expect: { cmdWord: 0x00, errorCode: 0x00, dataType: 0x02, dataHex: '47 31 46 30 32 2E 33 2E 30' },
    },
    {
        // 放大倍率回复: 55 07 01 00 01 0A <crc>
        // 文档示例 CRC 为 BB，但与算法不符（且放大/缩小两行完全相同，疑为文档笔误），
        // 此处 CRC 由下面的 crc8 重新计算。
        name: 'zoom in ack',
        packet: '55 07 01 00 01 0A 00',
        expect: { cmdWord: 0x01, errorCode: 0x00, dataType: 0x01, dataHex: '0A' },
    },
    {
        // 获取IP回复: 55 0E 07 00 02 "192.168.1.2"? 用文档 IP 示例无返回包，改用端口号获取占位（2 字节低位在前）
        name: 'get port number (2-byte LE)',
        // 构造: 55 08 07 00 01 22 02 <crc>
        packet: '55 08 07 00 01 22 02 ' + '',
        expect: { cmdWord: 0x07, errorCode: 0x00, dataType: 0x01, dataHex: '22 02' },
    },
];

// 按算法重算 zoom ack 与 port 两条的 CRC 并补全
import { crc8 } from '../G1Camera';
const withCrc = (beforeHex: string): string => {
    const before = hexToBuf(beforeHex);
    return Buffer.concat([before, Buffer.from([crc8(before)])]).toString('hex');
};
const zoomIdx = cases.findIndex((c) => c.name === 'zoom in ack');
cases[zoomIdx].packet = withCrc('55 07 01 00 01 0A');
const versionIdx = cases.findIndex((c) => c.name === 'get protocol version');
cases[versionIdx].packet = withCrc('55 0F 00 00 02 47 31 46 30 32 2E 33 2E 30');
cases[cases.length - 1].packet = withCrc('55 08 07 00 01 22 02');

let ok = true;
for (const c of cases) {
    const buf = hexToBuf(c.packet);
    try {
        const r = G1Camera.parseResponsePacket(buf);
        const dataHex = r.data.toString('hex').replace(/(..)/g, '$1 ').trim().toUpperCase();
        const pass =
            r.cmdWord === c.expect.cmdWord &&
            r.errorCode === c.expect.errorCode &&
            r.dataType === c.expect.dataType &&
            dataHex === c.expect.dataHex.toUpperCase();
        if (!pass) ok = false;
        console.log(
            `${pass ? 'OK  ' : 'FAIL'} ${c.name}: cmd=0x${r.cmdWord.toString(16)} ` +
            `err=0x${r.errorCode.toString(16)} type=${r.dataType} data=[${dataHex}]`
        );
    } catch (err) {
        ok = false;
        console.log(`FAIL ${c.name}: parse threw — ${err instanceof Error ? err.message : err}`);
    }
}

// getParam 语义模拟：imageSize 回复 → 当前值应为最后一个参数字节 0x02
const r = G1Camera.parseResponsePacket(hexToBuf('55 0F 07 00 01 00 01 02 03 04 05 06 07 02 43'));
const imageSize = r.data[r.data.length - 1];
console.log(`${imageSize === 2 ? 'OK  ' : 'FAIL'} imageSize value extraction = ${imageSize} (expect 2)`);
if (imageSize !== 2) ok = false;

// 端口号 2 字节低位在前: 22 02 → 0x0222 = 546
const rp = G1Camera.parseResponsePacket(hexToBuf(cases[cases.length - 1].packet));
const port = rp.data.readUInt16LE(0);
console.log(`${port === 0x0222 ? 'OK  ' : 'FAIL'} port number = ${port} (expect ${0x0222})`);
if (port !== 0x0222) ok = false;

console.log(ok ? 'ALL RESPONSES OK' : 'RESPONSE CHECKS FAILED');
if (!ok) process.exit(1);
