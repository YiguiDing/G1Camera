// 端到端测试：启动一个模拟 G1 相机 TCP 服务，验证 setParam → getParam 链路
// 运行: npx ts-node scripts/mock-camera-test.ts
import * as net from 'net';
import { G1Camera, crc8, HEADER_COMMAND, HEADER_RESPONSE } from '../G1Camera';

// ---- 模拟相机的参数存储 ----
const store = new Map<number, number>([
    [0x00, 2], // imageSize
    [0x07, 0], // videoSize
]);

function buildResponse(cmdWord: number, dataType: number, data: number[]): Buffer {
    const bytes = [HEADER_RESPONSE, 0, cmdWord, 0x00, dataType, ...data];
    bytes[1] = bytes.length + 1; // 含校验位
    const before = Buffer.from(bytes);
    return Buffer.concat([before, Buffer.from([crc8(before)])]);
}

const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
            if (buf[0] !== HEADER_COMMAND) { buf = buf.subarray(1); continue; }
            const len = buf[1];
            if (buf.length < len) break;
            const packet = buf.subarray(0, len);
            buf = buf.subarray(len);

            const cmdWord = packet[2];
            const rw = packet[3];
            const paramId = packet[4];
            const value = packet[5];

            if (cmdWord !== 0x07) {
                // 不支持的命令字
                sock.write(buildResponse(0xff, 0x01, [0x02]));
                continue;
            }
            if (!store.has(paramId)) {
                // 模拟"参数不存在"错误：命令字 0xff，错误码 0x02
                const bytes = [HEADER_RESPONSE, 0, 0xff, 0x02, 0x01];
                bytes[1] = bytes.length + 1;
                const before = Buffer.from(bytes);
                sock.write(Buffer.concat([before, Buffer.from([crc8(before)])]));
                continue;
            }
            if (rw === 0x01) {
                store.set(paramId, value); // 设置
            }
            sock.write(buildResponse(cmdWord, 0x01, [store.get(paramId)!]));
        }
    });
});

function assert(cond: boolean, msg: string): void {
    if (!cond) {
        console.error(`FAIL ${msg}`);
        process.exitCode = 1;
    } else {
        console.log(`OK   ${msg}`);
    }
}

server.listen(0, '127.0.0.1', async () => {
    const addr = server.address() as net.AddressInfo;
    console.log(`mock camera listening on 127.0.0.1:${addr.port}`);

    const camera = new G1Camera(3000);
    try {
        await camera.connect('127.0.0.1', addr.port);

        // 读取初始值
        assert((await camera.getParam(0x00)) === 2, 'getParam(0x00) initial = 2');

        // 设置后读回
        await camera.setParam(0x00, 5);
        assert((await camera.getParam(0x00)) === 5, 'setParam(0x00, 5) then read back = 5');

        // 再设置另一个参数，确认互不影响
        await camera.setParam(0x07, 3);
        assert((await camera.getParam(0x07)) === 3, 'setParam(0x07, 3) then read back = 3');
        assert((await camera.getParam(0x00)) === 5, 'param 0x00 still = 5');

        // 不存在的参数应被识别为「固件不支持」
        try {
            await camera.getParamRaw(0x3f).then((r) => {
                assert(r.errorCode === 0x02, `getParamRaw(0x3F) errorCode = 0x02 (got 0x${r.errorCode.toString(16)})`);
            });
        } catch (err) {
            assert(false, `getParamRaw(0x3F) threw: ${err instanceof Error ? err.message : err}`);
        }

        // ID 表中不存在的参数由客户端直接拦截，不应发到相机
        try {
            await camera.setParam(0x3c, 1); // 0x3C 未在 PARAM_DEFS 中定义
            assert(false, 'setParam(0x3C) should throw');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            assert(/Unknown param ID/i.test(msg), `setParam(0x3C) blocked client-side: "${msg}"`);
        }

        // 相机返回 0x02 时应抛 G1ProtocolError 且 unsupported=true
        try {
            const raw = await camera.getParamRaw(0x3f);
            const { G1ProtocolError } = await import('../G1Camera');
            const e = new G1ProtocolError(raw.errorCode, raw.cmdWord, 'test');
            assert(e.unsupported === true, 'G1ProtocolError(0x02).unsupported = true');
        } catch (err) {
            assert(false, `G1ProtocolError check threw: ${err instanceof Error ? err.message : err}`);
        }
    } catch (err) {
        console.error('TEST ERROR:', err instanceof Error ? err.message : err);
        process.exitCode = 1;
    } finally {
        camera.disconnect();
        server.close();
        if (process.exitCode === undefined) {
            console.log('ALL MOCK CAMERA TESTS PASSED');
        }
    }
});
