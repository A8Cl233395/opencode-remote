# opencode-remote

[English](README.md) | 中文

通过
[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
隧道把本机 OpenCode Web UI 暴露到公网，在终端里显示二维码，手机扫码即可打开。
支持随机的 `*.trycloudflare.com` 快速隧道，也支持自己域名下的命名隧道。

```
┌─ remote - tunnel is up ─────────────────────────────┐
│ Public URL: https://random-words-1234.trycloudflare.com
│ Auto-login link: https://.../?auth_token=...        │
│                                                     │
│   ▄▄▄▄▄▄▄ ▄  ▄ ▄▄▄▄▄▄▄                             │
│   █ ▄▄▄ █ ▀▄▀▄█ ▄▄▄ █                             │
│   █ ███ █ ▄▄▀▄█ ███ █                             │
│   ▀▀▀▀▀▀▀ ▀▄▀▄ ▀▀▀▀▀▀▀                             │
│                                                     │
│ Scan with your phone to open this opencode WebUI.   │
└─────────────────────────────────────────────────────┘
```

## 功能

- `/remote`（别名 `/tunnel`）启动隧道，并弹出带公网地址的二维码对话框。
- 服务端设有密码时，二维码编码的是**自动登录链接**（`?auth_token=...`），手机浏览器打开即自动完成登录。
- 快速隧道（`https://<随机>.trycloudflare.com`）或命名隧道 + 自定义域名。
- **自动启动**：随服务端一起启动隧道；打开开关时会立即启动。
- **静默模式**：只弹 toast 提示，不显示二维码对话框。
- 同一台机器上的多个 OpenCode 位置共享一条隧道：第一个实例持有，其它实例接管其记录；发生竞争时 PID 最小者胜出，其余退出。
- TUI + 服务端插件：命令进入命令面板，隧道跑在服务端进程里，通过 RPC 暴露给 TUI。

## 依赖

- 已安装 [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
  并且在 `PATH` 中，或者通过 `options.cloudflared` / `OPENCODE_CLOUDFLARED` /
  `CLOUDFLARED_PATH` 指定可执行文件路径。
- 命名隧道要求 cloudflared 隧道已存在并配置了 DNS 路由；不填隧道名时使用
  `trycloudflare.com` 快速隧道。

## 安装

把整个文件夹复制到 OpenCode 插件目录：

```
~/.config/opencode/plugins/remote/
  index.ts
  tui.ts
  qr.ts
  rpc.ts
```

重启 OpenCode。如果你的版本不会自动发现插件目录，在
`~/.config/opencode/cli.json` 里注册该目录：

```json
{
  "plugins": [
    { "package": "C:/Users/you/.config/opencode/plugins/remote" }
  ]
}
```

## 使用

| 命令（命令面板） | 斜杠命令 | 说明 |
|---|---|---|
| Expose web UI (cloudflared) | `/remote`、`/tunnel` | 启动隧道（已启动则直接显示），弹出二维码对话框。 |
| Stop remote tunnel | `/remote-stop` | 停止运行中的 cloudflared 隧道。 |
| Configure remote tunnel | `/remote-config` | 设置隧道名与主机名（保存在服务端）。留空即清除，回到快速隧道模式。 |
| Toggle auto-start tunnel | `/remote-autostart` | 切换「随服务端启动隧道」；打开时会立即启动。 |
| Toggle silent start | `/remote-silent` | 在二维码对话框与纯 toast 提示之间切换。 |

## 配置

所有选项写在 `cli.json` 的 `plugins` 条目里：

```json
{
  "plugins": [
    {
      "package": "C:/Users/you/.config/opencode/plugins/remote",
      "options": {
        "silent": false,
        "autoStart": false,
        "tunnelName": "",
        "tunnelHostname": ""
      }
    }
  ]
}
```

| 选项 | 默认值 | 环境变量 | 说明 |
|---|---|---|---|
| `url` | _自动推导_ | `OPENCODE_REMOTE_URL` | 强制指定本地目标地址，不再从 `--port` / 服务注册信息推导。 |
| `cloudflared` | `"cloudflared"` | `OPENCODE_CLOUDFLARED`、`CLOUDFLARED_PATH` | cloudflared 可执行文件路径。 |
| `tunnelName` | `""` | `OPENCODE_TUNNEL_NAME` | 要运行的命名隧道（`cloudflared tunnel run <name> ...`）。留空 = 快速隧道。 |
| `tunnelHostname` | `""` | `OPENCODE_TUNNEL_HOSTNAME` | 命名隧道的公网主机名。 |
| `autoStart` | `false` | `OPENCODE_REMOTE_AUTOSTART` | 服务端启动时自动启动隧道。 |
| `silent` | `false` | `OPENCODE_REMOTE_SILENT` | 只提示 toast，不显示二维码（也可用 `/remote-silent` 切换）。 |

每项配置的优先级：环境变量 > 插件选项 > 在 TUI 对话框里保存的值。

## 工作原理

- 本地目标地址取自进程参数里的 `--port` / `--hostname`；当 OpenCode 以
  `opencode serve --service` 运行时，则读取共享的 service 注册文件
  （`service.json`）。`options.url` 可覆盖两者。
- 一台机器一条隧道。各实例会发布共享的 `tunnel` 记录（pid、url、authUrl、
  local、name）；新启动的实例如果发现同一后端的记录，会直接接管，而不是再拉起
  一个连接器。
- 两个实例竞争时 PID 最小者胜出，另一个退出并接管胜者的记录。卸载插件实例
  不会拆掉属于其它位置的隧道。
- 自动登录链接携带 base64 的 `opencode:<password>` token；Web UI 会消费它、
  从地址栏移除并保存该凭据。

## 安全提示

- 任何拿到公网地址的人都能访问 Web UI；自动登录链接 / 二维码等于直接登录。
  两者都要当作机密保管。
- 快速隧道是公网地址且主机名随机；用完后请用 `/remote-stop` 关闭隧道。

## RPC API

其它插件可以通过已注册的 RPC 方法驱动隧道（见 `rpc.ts`）：
`remote.state`、`remote.start`、`remote.stop`、`remote.configure`、
`remote.setAutoStart`。

## License

MIT
