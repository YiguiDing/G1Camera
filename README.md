# G1 Camera Control SDK

基于 G1 相机串口控制协议，通过 TCP（默认端口 8888）对相机进行远程参数读写。

## 文件结构

```
├── protocol.ts    # 协议层：常量、类型、CRC-8、组包/解包、参数定义表
├── G1Camera.ts    # G1Camera 类：TCP 连接、命令收发、命名 getter/setter
├── index.ts       # 入口：统一 re-export、dumpAll()、main() 示例
├── selfTest.ts    # CRC-8 与组包/解包自测（8 组测试向量）
├── package.json
├── tsconfig.json
└── README.md
```

依赖仅需 `net`（Node.js 内置），无第三方运行时依赖。

## 快速开始

```bash
npm install
npx ts-node index.ts          # 连接相机，打印全部参数
npx ts-node selfTest.ts       # 仅运行 CRC-8 与组包自测
```

## 协议格式

### 物理层

- 相机作为 TCP Server 监听 `8888` 端口
- SDK 作为 TCP Client 连接相机
- 一问一答，串行通信（不支持并发命令）

### 命令包 (Host → Camera)

```
AA [len] 07 [rw] [param_id] [data...] [checksum]
│   │     │    │       │          │          │
│   │     │    │       │          │          └── CRC-8 (poly=0xD5)
│   │     │    │       │          └── 参数值 (SET时; GET时为空)
│   │     │    │       └── 参数ID (1 byte, 整数: 0x00-0x3F, 字符串: 0x7F-0x85)
│   │     │    └── 读写标志: 0x00=GET(读), 0x01=SET(写)
│   │     └── 消息类型: 0x07 (配置参数)
│   └── 总长度 (包含所有字节含校验)
└── 包头 0xAA
```

示例——获取 IP (param 0x83)：
```
AA 06 07 00 83 50
│  │  │  │  │  └── CRC-8
│  │  │  │  └── param_id = 0x83 (netIp)
│  │  │  └── RW = 0x00 (GET)
│  │  └── type = 0x07
│  └── len = 0x06 (6 bytes)
└── header = 0xAA
```

示例——设置 IP 为 192.168.1.65：
```
AA 12 07 01 83 31 39 32 2E 31 36 38 2E 31 2E 36 35 E8
                 └────── "192.168.1.65" ASCII ──────────┘ └── CRC-8
```

### 响应包 (Camera → Host)

```
55 [len] 07 [b3] [b4] [data...] [checksum]
│   │     │   │     │      │          │
│   │     │   │     │      │          └── CRC-8 (poly=0xD5)
│   │     │   │     │      └── 负载数据 (见下表)
│   │     │   │     └── byte4: 数据类型/值 (见下表)
│   │     │   └── byte3: 响应码 (通常 0x00)
│   │     └── 消息类型: 0x07
│   └── 总长度
└── 包头 0x55
```

**`byte4` 语义与 data 布局（核心）：**

| 场景 | byte4 值 | data 内容 | 取值示例 |
|------|---------|----------|---------|
| GET 字符串参数 | `0x00` | `[0x00, string_bytes...]` | `data.subarray(1).toString('ascii')` |
| GET 1字节整数 | 参数值本身 | `[value]` (仅1字节) | `data[0]` |
| GET 2字节整数 | `0x01` | `[0x01, low, high]` | `data.readUInt16LE(1)` |
| SET 确认 | `0x02` | `[0x02, echoed_data...]` | `data[0] === 0x02` 表示成功 |

示例——SET AP WiFi 名称成功响应：
```
55 0D 07 00 02 47 31 45 74 65 73 74 53
│  │  │  │  │  └──── "G1Etest" ─────┘ └── CRC-8
│  │  │  │  └── byte4 = 0x02 (SET ack)
│  │  │  └── byte3 = 0x00
│  │  └── type = 0x07
│  └── len = 0x0D (13 bytes)
└── header = 0x55
```

### CRC-8 校验

- 多项式：`0xD5` (x⁸ + x⁷ + x⁶ + x⁴ + x² + 1)
- 初始值：`0x00`，最终异或：`0x00`
- 计算范围：包头到校验字节之前的所有字节

```typescript
function crc8(data: Buffer | number[]): number {
    let crc = 0x00;
    const bytes = Buffer.isBuffer(data) ? [...data] : data;
    for (const b of bytes) {
        crc ^= b;
        for (let i = 0; i < 8; i++) {
            if (crc & 0x80) crc = ((crc << 1) ^ 0xD5) & 0xFF;
            else crc = (crc << 1) & 0xFF;
        }
    }
    return crc;
}
```

### 已验测试向量

| 用例 | 输入字节 | CRC |
|------|---------|-----|
| 获取IP | `AA 06 07 00 83` | `0x50` |
| 获取时间 | `AA 06 07 00 85` | `0xD1` |
| 设置IP | `AA 12 07 01 83 + "192.168.1.65"` | `0xE8` |
| 设置时间 | `AA 19 07 01 85 + "2024-01-01 05:15:41"` | `0x1A` |
| 响应包 | `55 0D 07 00 02 + "G1Etest"` | `0x53` |

## 参数列表

### 整数类型参数 (0x00 - 0x3F)

| ID | 名称 | 取值 |
|----|------|------|
| 0x00 | imageSize | 0=20M, 1=13M, 2=12M, 3=10M, 4=8M, 5=5M, 6=3M, 7=2M |
| 0x01 | photoDelayTimer | 0=OFF, 1=3S, 2=5S, 3=7S |
| 0x02 | photoLDC | 0=OFF, 1=ON |
| 0x03 | photoTimeLapseInterval | 0=OFF, 1=1S, 2=2S, …, 16=60S |
| 0x04 | timeLapsePhotoShootingTime | 0=Unlimited, 1=1MIN, …, 10=5H |
| 0x05 | stillStampMode | 0=OFF, 1=DATE, 2=DATETIME |
| 0x07 | videoSize | 0=4K, 1=2.7K, 2=1440P, 3=1080P, 4=720P |
| 0x08 | frameRate | 0=24fps, 1=25, 2=30, 3=48, 4=50, 5=60, 6=120, 7=240 |
| 0x09 | slowMotionMode | 0=OFF, 1=2x, 2=4x, 3=8x |
| 0x0A | videoFastMotion | 0=OFF, 1=2X, 2=5X, 3=10X, 4=15X, 5=30X |
| 0x0B | videoTimeLapseInterval | 同 0x03 |
| 0x0C | timeLapseVideoShootingTime | 同 0x04 |
| 0x0D | preRec | 0=OFF, 1=ON |
| 0x0E | videoImageStabilization | 0=OFF, 1=ON |
| 0x10 | videoQuality | 0=Superfine, 1=Fine, 2=Normal |
| 0x11 | rotation | 0=Normal, 1=Vertical, 2=Level, 3=270° |
| 0x13 | ldc | 畸变矫正 |
| 0x14 | metering | 0=Center, 1=Multi, 2=Spot |
| 0x15 | seamless | 0=Unlimited, 1=1MIN, 2=3MIN, 3=5MIN |
| 0x16 | cyclicRec | 0=OFF, 1=ON |
| 0x17 | recVol | 0=Mute, 1=Low, 2=Middle, 3=High |
| 0x18 | videoStampMode | 0=OFF, 1=DATE, 2=DATETIME |
| 0x19 | videoFileFormat | 1=MOV, 2=MP4 |
| 0x1A | videoVFI | 0=OFF, 1=ON (断电保存) |
| 0x1B | screenSaverTime | 0=OFF, 1=1MIN, 2=3MIN, 3=5MIN |
| 0x1C | sleepTime | 0=OFF, 1=1MIN, 2=3MIN, 3=5MIN, 4=10MIN, 5=15MIN |
| 0x1D | autoRecording | 0=OFF, 1=ON |
| 0x1F | lightFreq | 0=OFF, 1=50HZ, 2=60HZ |
| 0x20 | beepSound | 0=OFF, 1=ON |
| 0x21 | volume | 0=OFF, 1=1, 2=2, 3=3 |
| 0x22 | soundChoice | 0=BEEP, 1=SPEAKER |
| 0x23 | audioCodec | 0=Internal, 1=External |
| 0x24 | switchSecondAudio | 0=OFF, 1=ON |
| 0x25 | autoOpenWifi | 0=OFF, 1=ON |
| 0x26 | wifiFrequencyBand | 0=2.4G, 1=5G |
| 0x27 | fillLightA | 0=Close, 1=Open |
| 0x28 | fillLightB | 0=Auto, 1=Close, 2=Open |
| 0x29 | irCut | IR Cut 控制 |
| 0x31 | usbMode | 0=USB, 1=PCCAM |
| 0x32 | autoWifiRec | 0=OFF, 1=ON |
| 0x33 | hdmiSize | 0=AUTO, 1-4=各种分辨率 |
| 0x34 | uvcBitrate | 10-50 Mbps, 默认 20 |
| 0x35 | usbAutoPWROn | 0=Close, 1=Open |
| 0x36 | invertMode | 0=OFF, 1=ON |
| 0x37 | wifiAutoClose | 0=OFF, 1=1MIN, 2=2MIN, 3=3MIN |
| 0x38 | wifiMode | 0=AP, 1=STA |
| 0x39 | iqStamp | 0=CLOSE, 1=OPEN |
| 0x3A | staticIP | 0=Dynamic(DHCP), 1=Static |
| 0x3B | portNumber | **2字节小端序**，默认 8888 |
| 0x3F | capRotation | 照片旋转 |

### 字符串类型参数 (0x7F - 0x85)

| ID | 名称 | 说明 |
|----|------|------|
| 0x7F | wifiSSID | STA WiFi 名称 |
| 0x80 | wifiPassword | STA WiFi 密码 |
| 0x81 | customWifiSSID | AP WiFi 名称 |
| 0x82 | customWifiPassword | AP WiFi 密码 |
| 0x83 | netIp | IP 地址，如 "192.168.1.65" |
| 0x84 | netGateway | 网关地址 |
| 0x85 | cameraTime | 时间，格式 "YYYY-MM-DD HH:MM:SS" |

## API 参考

### G1Camera 类

```typescript
import { G1Camera } from './index';

const camera = new G1Camera();
```

#### 连接管理

| 方法 | 说明 |
|------|------|
| `connect(host: string, port?: number)` | 建立 TCP 连接，默认端口 8888，返回 Promise |
| `disconnect()` | 断开连接 |
| `isConnected(): boolean` | 是否已连接 |
| `send(data: Buffer \| number[])` | 底层发送原始数据 |

#### 通用读写

| 方法 | 说明 |
|------|------|
| `getParam(paramId: number): Promise<number \| string>` | 按 ID 读取参数 |
| `setParam(paramId: number, value: number \| string): Promise<void>` | 按 ID 设置参数 |

#### 命名方法（部分示例）

每个参数都有一对 `getXxx()` / `setXxx()` 方法：

```typescript
// 网络
await camera.getIp();             // → "192.168.1.65"
await camera.setIp("192.168.1.66");
await camera.getPortNumber();     // → 8888
await camera.getStaticIP();       // → 1 (Static)

// 照片
await camera.getImageSize();      // → 2
await camera.setImageSize(0);     // 设为 20M

// 录像
await camera.getVideoSize();      // → 0 (4K)
await camera.getFrameRate();      // → 2 (30fps)
await camera.setFrameRate(5);     // 设为 60fps

// WiFi
await camera.getWifiMode();       // → 0 (AP)
await camera.getWifiSSID();       // → "G1F"

// 时间
await camera.getCameraTime();     // → "2022-01-01 00:10:25"
await camera.setCameraTime("2024-06-25 12:00:00");

// ... 共约 50 组 getter/setter
```

### dumpAll(camera)

```typescript
import { G1Camera } from './index';

const camera = new G1Camera();
await camera.connect('192.168.1.64');
await dumpAll(camera);  // 打印全部参数
camera.disconnect();
```

输出示例：
```
--- 照片参数 ---
  ImageSize: 2
  PhotoDelayTimer: 0
  ...
--- 录像参数 ---
  VideoSize: 0
  FrameRate: 2
  ...
--- 系统设置 ---
  StaticIP: 1
  PortNumber: 8888
  ...
--- 字符串参数 ---
  Ip: 192.168.1.65
  CameraTime: 2022-01-01 00:10:25
  ...
```

## TCP 流处理

TCP 是字节流，需处理粘包/半包：

1. 收到数据追加到 `receiveBuffer`
2. 扫描 `0x55` 响应头
3. 读取长度字段，等待足够数据
4. CRC-8 校验，提取完整响应包
5. 从 `receiveBuffer` 中移除已处理的字节
6. 继续循环直到 buffer 不够一个完整包

## 参考文档

- `doc/G1控制协议ID.xlsx` — 参数 ID、取值范围、示例命令
- `doc/接口控制协议.pdf` — 协议详细规范（扫描件）
