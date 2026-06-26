# Driver — 通用设备驱动抽象基类

`Driver<TArgs, TResponse>` 抽象了基于 Duplex 流（TCP Socket、串口等）的**请求/响应式协议**的通用 pipeline。子类只需实现三个协议相关方法，即可获得完整的连接管理、超时控制、命令互斥和错误恢复能力。

内置一个基于此基类实现的 **G1 相机** 驱动（`G1Camera`）。

依赖仅需 `net`（Node.js 内置），无第三方运行时依赖。

## 文件结构

```
├── Driver.ts      # 通用抽象基类
├── G1Camera.ts    # 内置实现：G1 相机协议
├── index.ts       # 统一导出 + dumpAll() + main()
├── selfTest.ts    # CRC-8 / 组包拆包自测
├── package.json
├── tsconfig.json
└── README.md
```

## Driver 基类

### 架构

```
sendCommand → buildCommandPacket → setTimeout → pending → write
onData → concat → extractPacket → parseResponsePacket → handleResponse → clearTimeout → resolve
```

- **发送**：`sendCommand` 调用子类的 `buildCommandPacket` 序列化命令 → 写流 → 启动超时 → 将 promise 存入 `pending`
- **接收**：`onData` 追加到 `receiveBuffer` → 循环调用 `extractPacket` 切帧 → `parseResponsePacket` 反序列化 → `handleResponse` 清除超时并 resolve
- **错误**：超时 / write 失败 / 连接断开 → reject；CRC 失败 → 跳过 1 字节自动重同步

### 三个抽象方法

子类**只需要实现这三个方法**：

| 方法 | 职责 | 签名 |
|------|------|------|
| `buildCommandPacket` | 命令参数 → 线格式 Buffer | `(...args: TArgs): Buffer` |
| `parseResponsePacket` | 线格式 Buffer → 类型化响应 | `(packet: Buffer): TResponse` |
| `extractPacket` | 从接收缓冲区中切一帧 | `(): ExtractResult \| null` |

`TArgs` 和 `TResponse` 是泛型参数。`sendCommand` 自动继承 `buildCommandPacket` 的参数类型——声明一次，类型全局一致。

### 为新设备写驱动

```typescript
import { Driver, ExtractResult } from './Driver';
import { Duplex } from 'stream';

// 1. 定义响应类型
interface MyResponse { cmd: number; data: Buffer; }

// 2. 继承 Driver，指定参数元组和响应类型
class MyDevice extends Driver<[cmd: number, payload?: Buffer], MyResponse> {

    // ---------- 三个必须实现的方法 ----------

    protected buildCommandPacket(cmd: number, payload?: Buffer): Buffer {
        // 按你的协议拼出 Buffer
    }

    protected parseResponsePacket(packet: Buffer): MyResponse {
        // 按你的协议解析，校验失败直接 throw
    }

    protected extractPacket(): ExtractResult | null {
        const buf = this.receiveBuffer;
        // 扫描帧头 / 定长 / 分隔符 —— 找出完整帧边界
        // 返回 { packet, consumed }；不够则 return null
    }

    // ---------- 连接（TCP 示例）----------

    connect(host: string, port: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const sock = new net.Socket();
            sock.once('connect', () => {
                this.attachStream(sock as Duplex);  // 交给基类管理
                resolve();
            });
            sock.once('error', reject);
            sock.connect(port, host);
        });
    }

    // ---------- 业务 API ----------

    async getFirmwareVersion(): Promise<string> {
        const resp = await this.sendCommand(0x01);  // 类型安全，IDE 有提示
        return resp.data.toString('ascii');
    }

    async setConfig(reg: number, value: Buffer): Promise<void> {
        await this.sendCommand(0x02, value);
    }
}
```

**`sendCommand` 自动处理**：连接检查 → 命令互斥（同时只能有一个在飞）→ 超时 → write 错误 → 串行化。**`onData` 自动处理**：粘包/半包 → 垃圾跳过 → CRC 失败恢复。

### Driver API 参考

| 成员 | 可见性 | 说明 |
|------|--------|------|
| `stream` | protected | 当前 Duplex 流 |
| `receiveBuffer` | protected | 接收缓冲区（extractPacket 可读取/清理） |
| `pending` | protected | 当前在飞的命令，为 null 时空闲 |
| `timeout` | protected | 命令超时毫秒数 |
| `attachStream(stream)` | protected | 绑定流，注册 data / close / error 监听 |
| `detachStream()` | protected | 解绑流，reject 所有 pending，销毁流 |
| `sendCommand(...args)` | protected | 组包 → 写流 → 等待 → 返回 Promise\<TResponse\> |
| `handleResponse(resp)` | protected | 投递响应给 pending promise（可覆写以处理主动推送） |
| `buildCommandPacket` | abstract | 子类实现：参数 → Buffer |
| `parseResponsePacket` | abstract | 子类实现：Buffer → TResponse |
| `extractPacket` | abstract | 子类实现：从 receiveBuffer 切一帧 |
| `send(data)` | public | 原始写入，不等待响应 |
| `isConnected()` | public | 流是否存活且未销毁 |
| `disconnect()` | public | 断开并清理 |

---

## 内置实现：G1Camera

`G1Camera` 是 Driver 基类在 G1 相机协议上的完整实现，也是一份参考代码。

### 快速开始

```bash
npm install
npx ts-node index.ts          # 连接相机 (192.168.1.65:8888)，打印全部参数
npx ts-node selfTest.ts       # 离线自测 CRC-8 + 组包/拆包
```

```typescript
import { G1Camera } from './G1Camera';

const camera = new G1Camera();
await camera.connect('192.168.1.65');
console.log(await camera.getIp());           // → "192.168.1.65"
console.log(await camera.getCameraTime());   // → "2025-06-26 12:00:00"
await camera.setFrameRate(5);                // 设为 60fps
camera.disconnect();
```

### 协议格式

G1 相机作为 TCP Server 监听 8888 端口，一问一答，串行通信。

#### 命令包 (Host → Camera)

```
AA [len] 07 [rw] [param_id] [data...] [checksum]
│   │     │    │       │          │          └── CRC-8 (poly=0xD5)
│   │     │    │       │          └── 参数值 (SET 时; GET 时为空)
│   │     │    │       └── 参数 ID (1 byte)
│   │     │    └── 0x00=GET, 0x01=SET
│   │     └── 消息类型 0x07
│   └── 总长度 (含校验)
└── 包头 0xAA
```

示例 —— 获取 IP (param 0x83)：`AA 06 07 00 83 50`
示例 —— 设置 IP 为 192.168.1.65：`AA 12 07 01 83 [12 bytes ASCII] E8`

#### 响应包 (Camera → Host)

```
55 [len] 07 [b3] [b4] [data...] [checksum]
│   │     │   │     │      │          └── CRC-8 (poly=0xD5)
│   │     │   │     │      └── 负载
│   │     │   │     └── byte4: 数据类型/值
│   │     │   └── byte3: 响应码 (通常 0x00)
│   │     └── 消息类型 0x07
│   └── 总长度
└── 包头 0x55
```

**byte4 语义（核心）：**

| 场景 | byte4 | data 内容 | 取值 |
|------|-------|----------|------|
| GET 字符串 | `0x00` | `[0x00, str...]` | `data.subarray(1).toString('ascii')` |
| GET 1 字节整数 | 值本身 | `[value]` | `data[0]` |
| GET 2 字节整数 | `0x01` | `[0x01, lo, hi]` | `data.readUInt16LE(1)` |
| SET 确认 | `0x02` | `[0x02, ...]` | `data[0] === 0x02` 表示成功 |

#### CRC-8

多项式 `0xD5`，初始值 `0x00`。计算范围：包头到校验字节之前。

```typescript
export function crc8(data: Buffer | number[]): number {
    let crc = 0x00;
    for (const b of Buffer.isBuffer(data) ? [...data] : data) {
        crc ^= b;
        for (let i = 0; i < 8; i++) {
            crc = (crc & 0x80) ? ((crc << 1) ^ 0xD5) & 0xFF : (crc << 1) & 0xFF;
        }
    }
    return crc;
}
```

已验测试向量：

| 用例 | 输入字节 | CRC |
|------|---------|-----|
| 获取 IP | `AA 06 07 00 83` | `0x50` |
| 获取时间 | `AA 06 07 00 85` | `0xD1` |
| 设置 IP | `AA 12 07 01 83 + "192.168.1.65"` | `0xE8` |
| 设置时间 | `AA 19 07 01 85 + "2024-01-01 05:15:41"` | `0x1A` |
| 响应包 | `55 0D 07 00 02 + "G1Etest"` | `0x53` |

### G1Camera API

```typescript
import { G1Camera } from './G1Camera';

const cam = new G1Camera();
```

| 方法 | 说明 |
|------|------|
| `connect(host, port?)` | TCP 连接，默认 8888 |
| `disconnect()` | 断开（继承自 Driver） |
| `isConnected()` | 是否已连接（继承自 Driver） |
| `send(data)` | 原始写入（继承自 Driver） |
| `getParam(id): Promise<number \| string>` | 按 ID 读参数 |
| `setParam(id, value)` | 按 ID 写参数 |

静态方法（无需实例）：

| 方法 | 说明 |
|------|------|
| `G1Camera.buildCommandPacket(paramId, rw, data?)` | 组命令包 |
| `G1Camera.parseResponsePacket(packet)` | 解响应包，校验失败 throw |

命名 getter/setter（部分）：

```typescript
// 网络
await cam.getIp();              await cam.setIp('192.168.1.66');
await cam.getPortNumber();      await cam.getStaticIP();

// 照片
await cam.getImageSize();       await cam.setImageSize(0);   // 20M

// 录像
await cam.getVideoSize();       await cam.setFrameRate(5);   // 60fps

// 时间
await cam.getCameraTime();      await cam.setCameraTime('2024-06-25 12:00:00');

// ... 共约 50 组
```

### 参数列表（摘要）

整数参数（0x00–0x3F）：照片/录像分辨率、帧率、码率、曝光、白平衡、WiFi 模式、音量等。

字符串参数（0x7F–0x85）：WiFi SSID / 密码、IP 地址、网关、系统时间。

详见源码 `G1Camera.ts` 中 `PARAM_DEFS` 表，或参考文档 `doc/G1控制协议ID.xlsx`。

---

## Driver 流处理细节

`Driver` 自动处理 TCP 字节流的粘包/半包问题：

1. `onData` 收到 chunk → `Buffer.concat` 追加到 `receiveBuffer`
2. 循环调用 `extractPacket()` —— 子类扫描帧头、读长度、判断是否够一帧
3. 够一帧 → `parseResponsePacket()` 校验 CRC 并反序列化
4. 成功 → consume；失败 → 跳过 1 字节重新同步
5. 无帧头（连续垃圾）→ 清空缓冲区，等待新数据

整个过程对子类透明，子类只关心 "怎么找到帧边界" 和 "怎么解析帧内容"。

## 参考文档

- `doc/G1控制协议ID.xlsx` — G1 参数 ID、取值范围、示例命令
- `doc/接口控制协议.pdf` — G1 协议详细规范（扫描件）
