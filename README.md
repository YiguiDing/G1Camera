# G1 相机控制

基于 G1 控制协议（`doc/接口控制协议.pdf`）的 Electron 桌面应用。

## 功能

- **连接管理**：TCP 连接相机（默认 `192.168.1.1:8888`，WiFi 模式；网口默认 `192.168.1.64`）
- **快捷指令**：拍照 / 录像 / **设备重启** / 格式化卡 / 开/关 WiFi / 陀螺仪校准 / 放大缩小 / 彩色/黑白模式
  - 「格式化卡」「设备重启」有二次确认
- **参数读写**：一键读取全部参数（照片、录像、系统、字符串），表格内直接修改并设置
- **日志面板**：实时显示主进程操作日志

## 目录结构

```
G1Camera.ts          协议库（CRC8、报文构建/解析、参数与快捷指令 API）
Driver.ts            通用串口/TCP 驱动基类
index.ts             CLI 示例入口（npm start）
electron/main.ts     主进程：持有 G1Camera 实例，注册 IPC
electron/preload.ts  contextBridge 安全暴露 window.api
ui/                  渲染进程（index.html / styles.css / renderer.ts）
scripts/             协议验证脚本（verify-packets / verify-responses）
doc/                 协议文档
```

## 使用

```bash
npm install          # 安装依赖
npm run dev          # 编译并以开发模式启动
npm run smoke        # 冒烟测试：隐藏窗口加载并退出（exit=0 表示正常）
npm start            # 运行 CLI 示例 index.ts
```

## 打包

```bash
npm run dist
```

产物在 `release/`：

- `G1相机控制 Setup 1.0.0.exe` — NSIS 安装包
- `G1相机控制 1.0.0.exe` — 免安装便携版

> 国内网络若下载 electron-builder 工具超时，先设置镜像：
>
> ```powershell
> $env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
> ```

## 注意

- 从 VS Code 集成终端启动时，若继承了 `ELECTRON_RUN_AS_NODE=1`，Electron 会退化以纯 Node 运行导致报错。启动前执行：
  ```powershell
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  ```
- 相机重启后 TCP 连接会断开，属正常现象，约 10 秒后手动重新连接。
- 当前未配置应用图标与代码签名，Windows 可能提示"未知发布者"。
