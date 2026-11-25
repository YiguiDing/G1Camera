// 参数探测：连接相机，逐 ID 发送 GET，报告哪些参数被固件支持。
// 用法: npx ts-node scripts/probe-params.ts [host] [port]
//   默认 192.168.1.1:8888（WiFi），网口一般 192.168.1.64:8888
import { G1Camera, PARAM_DEFS, ERROR_CODE_TEXT } from '../G1Camera';

const host = process.argv[2] ?? '192.168.1.1';
const port = Number(process.argv[3] ?? 8888);

const idRanges: [number, number][] = [
    [0x00, 0x3F],   // 整型参数
    [0x7F, 0x85],   // 字符串参数
];

(async () => {
    const camera = new G1Camera(1500); // 缩短超时，探测更快
    console.log(`连接 ${host}:${port} …`);
    await camera.connect(host, port);

    try {
        try {
            const version = await camera.getProtocolVersion();
            console.log(`协议版本: ${version}`);
        } catch (err) {
            console.log(`协议版本查询失败: ${err instanceof Error ? err.message : err}`);
        }

        const supported: number[] = [];
        const unsupported: number[] = [];
        const noReply: number[] = [];

        for (const [from, to] of idRanges) {
            for (let id = from; id <= to; id++) {
                const def = PARAM_DEFS[id];
                const label = def ? def.name : '(未在 ID 表中)';
                try {
                    const resp = await camera.getParamRaw(id);
                    if (resp.errorCode === 0x00) {
                        const hex = resp.data.toString('hex').replace(/(..)/g, '$1 ').trim();
                        console.log(`OK    0x${id.toString(16).toUpperCase().padStart(2, '0')}  ${label}  data=[${hex}]`);
                        supported.push(id);
                    } else {
                        const text = ERROR_CODE_TEXT[resp.errorCode] ?? '未知';
                        console.log(`ERR   0x${id.toString(16).toUpperCase().padStart(2, '0')}  ${label}  错误码 0x${resp.errorCode.toString(16)} (${text})`);
                        unsupported.push(id);
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.log(`TIMEOUT 0x${id.toString(16).toUpperCase().padStart(2, '0')}  ${label}  ${msg}`);
                    noReply.push(id);
                }
            }
        }

        const hexList = (ids: number[]): string =>
            ids.map((i) => '0x' + i.toString(16).toUpperCase().padStart(2, '0')).join(' ');

        console.log('\n========== 汇总 ==========');
        console.log(`支持   (${supported.length}): ${hexList(supported)}`);
        console.log(`不支持 (${unsupported.length}): ${hexList(unsupported)}`);
        console.log(`超时   (${noReply.length}): ${hexList(noReply)}`);
    } finally {
        camera.disconnect();
    }
})().catch((err) => {
    console.error('探测失败:', err instanceof Error ? err.message : err);
    process.exit(1);
});
