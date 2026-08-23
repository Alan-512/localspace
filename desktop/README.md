# LocalSpace Desktop

LocalSpace 的桌面伴侣应用：一键启动/停止 MCP 服务、集中展示 MCP 地址与 Owner
密码，让不使用终端的用户也能完成安装、配置和日常使用。

桌面端**只是进程管家 + 配置编辑器 + 信息面板**——所有安全门禁（目录白名单、
OAuth Owner 审批、敏感路径保护）仍然完全由 LocalSpace 核心服务端执行，
本应用不提供任何绕过它们的开关。

## 架构决策

### 为什么是 Electron + 独立 Node sidecar

- LocalSpace 核心要求 Node `>=22.19 <27` 且依赖原生模块 `better-sqlite3`。
  Electron 内嵌 Node 版本不受控、原生模块需要按 Electron ABI 重编译，均不可靠。
- 因此打包时附带**官方 Node 二进制**（`resources/bin/node.exe`），Electron 主进程
  以子进程方式运行 `node dist/cli.js serve`。`better-sqlite3` 直接使用标准 Node
  prebuilt 二进制，与 `npm install -g @alan512/localspace` 行为完全一致。
- 曾评估 Tauri：壳体积小，但服务端仍需完整 Node 运行时作为 sidecar，总体积优势
  被抵消且引入 Rust 工具链，故未采用。

### 与核心仓库的边界

- 桌面端**只读** `~/.localspace/config.json` 与 `auth.json`（这是核心仓库
  `src/user-config.ts` 定义的稳定存储契约；`desktop/src/main/config-store.ts`
  镜像了同一套目录解析规则，含 `.devspace` 兼容回退）。
- 所有**写入**通过 CLI 完成：配置向导调用 `localspace init --non-interactive ...`，
  校验逻辑单点保留在核心仓库。
- 服务健康探测使用核心自带的 `/healthz` HTTP 端点。

## 开发

前置条件：

1. 仓库根目录完成一次构建：`npm install && npm run build`（产出 `dist/cli.js`）。
2. 安装桌面依赖：`cd desktop && npm install`。

常用命令（均在 `desktop/` 下执行）：

```bash
npm run dev          # 构建 renderer+main 并启动 Electron
npm run typecheck    # 全量 TS 类型检查
npm test             # 单元测试（config-store / service-manager / wizard）
npm run dist:win     # 打包 Windows NSIS 安装包（先运行 prepare-server）
```

## 打包发布

```bash
# 1) 组装自包含服务端运行时 + Node sidecar（可加 --skip-node-download）
node scripts/prepare-server.mjs

# 2) 生成图标（已提交生成物，仅改动过脚本时需要重跑）
node scripts/make-icons.mjs

# 3) 构建 + 打包
npm run build
npm run dist:win     # 输出到 desktop/release/
```

`prepare-server.mjs` 会把根目录 `dist/`、`skills/` 复制到
`desktop/resources/server/` 并在其中执行 `npm ci --omit=dev`，随后下载与当前平台
匹配的 Node v22 到 `resources/bin/`。国内网络可用环境变量调整源：

- `LOCALSPACE_NODE_MIRROR`：Node 二进制镜像（默认 `https://nodejs.org/dist`）
- `LOCALSPACE_DESKTOP_NODE_BIN`：直接指定已下载好的 Node 可执行文件路径

## 安全设计红线

1. 密码默认打码显示，明文仅在用户点击“显示/复制”时经 IPC 取回；
2. 渲染进程开启 `contextIsolation`、禁用 `nodeIntegration`，IPC 通道白名单见
   `src/shared/channels.ts`；
3. `openExternal` 仅放行 http(s)；剪贴板写入限制长度；
4. 新增秘密（未来隧道的 token 等）存放在 userData 下 0600 文件，规划迁移 OS Keychain。

## 路线图

- **M1（当前）**：Windows 向导/面板/日志/设置、手动填写公网地址、NSIS 安装包。
- **M2**：cloudflared 快速隧道一键接入（Provider 接口化，预留 frp/cpolar 等本土方案）、
  托盘常驻完善、自动更新（electron-updater + GitHub Releases）。
- **M3**：客户端管理（`localspace clients list/revoke`）、接入审批系统通知、
  macOS/Linux 包与签名公证、英文界面。
