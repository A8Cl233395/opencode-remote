# opencode-remote

English | [中文](README.zh-CN.md)

Expose your local OpenCode Web UI through a
[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
tunnel and open it from any device by scanning a QR code in the TUI. Works with
quick `*.trycloudflare.com` URLs and with named tunnels on your own domain.

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

## Features

- `/remote` (alias `/tunnel`) starts the tunnel and shows a QR dialog with the public URL.
- When the server has a password, the QR encodes an **auto-login link** (`?auth_token=...`) so the phone browser signs in automatically.
- Quick tunnel (`https://<random>.trycloudflare.com`) or a named tunnel + hostname.
- **Auto-start**: start the tunnel with the server, and start it immediately when you flip the switch.
- **Silent mode**: toast notifications instead of the QR dialog.
- Multiple OpenCode locations on one machine share a single tunnel: the first instance owns it, others adopt its record; in a race the lowest PID wins and the others withdraw.
- TUI + server plugin: the commands live in the palette, the tunnel lives in the server process and is exposed to the TUI over RPC.

## Requirements

- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
  installed and on `PATH`, or the binary path passed via
  `options.cloudflared` / `OPENCODE_CLOUDFLARED` / `CLOUDFLARED_PATH`.
- A named tunnel requires a cloudflared tunnel that already exists and has a DNS
  route. Without a tunnel name, a quick `trycloudflare.com` tunnel is used.

## Install

Copy the folder into your OpenCode plugin directory:

```
~/.config/opencode/plugins/remote/
  tui.ts
  qr.ts
  rpc.ts

~/.config/opencode/plugin/remote/
  index.ts
```

Restart OpenCode. If your build does not auto-discover plugin folders, register
the folder in `~/.config/opencode/cli.json`:

```json
{
  "plugins": [
    { "package": "C:/Users/you/.config/opencode/plugins/remote" }
  ]
}
```

## Usage

| Command (palette) | Slash | Description |
|---|---|---|
| Expose web UI (cloudflared) | `/remote`, `/tunnel` | Start the tunnel (or show the already-running one) and display the QR dialog. |
| Stop remote tunnel | `/remote-stop` | Stop the running cloudflared tunnel. |
| Configure remote tunnel | `/remote-config` | Set the tunnel name and hostname (persisted on the server). Empty input clears both and returns to quick-tunnel mode. |
| Toggle auto-start tunnel | `/remote-autostart` | Toggle starting the tunnel with the server; enabling it starts the tunnel now. |
| Toggle silent start | `/remote-silent` | Toggle between the QR dialog and a toast-only notification. |

## Configuration

All options go into the `plugins` entry in `cli.json`:

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

| Option | Default | Environment | Description |
|---|---|---|---|
| `url` | _derived_ | `OPENCODE_REMOTE_URL` | Force the local target URL instead of deriving it from `--port` / the service registration. |
| `cloudflared` | `"cloudflared"` | `OPENCODE_CLOUDFLARED`, `CLOUDFLARED_PATH` | Path to the cloudflared binary. |
| `tunnelName` | `""` | `OPENCODE_TUNNEL_NAME` | Named tunnel to run (`cloudflared tunnel run <name> ...`). Empty = quick tunnel. |
| `tunnelHostname` | `""` | `OPENCODE_TUNNEL_HOSTNAME` | Public hostname of the named tunnel. |
| `autoStart` | `false` | `OPENCODE_REMOTE_AUTOSTART` | Start the tunnel when the server starts. |
| `silent` | `false` | `OPENCODE_REMOTE_SILENT` | Only toast instead of the QR dialog (also toggleable with `/remote-silent`). |

Precedence per setting: environment variable > plugin option > value saved from
the TUI dialogs.

## How it works

- The local target is derived from `--port` / `--hostname` in the process argv,
  or from the shared service registration (`service.json`) when OpenCode runs as
  `opencode serve --service`. `options.url` overrides both.
- One tunnel serves the whole machine. Instances publish a shared `tunnel`
  record (pid, url, authUrl, local, name); a starting instance adopts a record
  for the same backend instead of spawning a duplicate connector.
- If two instances race, the lowest PID wins; the other withdraws and adopts the
  winner's record. Disposing a plugin instance never tears down a tunnel that
  another location owns.
- The auto-login link carries a base64 `opencode:<password>` token; the Web UI
  consumes it, strips it from the address bar and persists the credential.

## Security

- Anyone with the public URL can reach the Web UI, and the auth link/QR signs
  them in. Treat both as secrets.
- Quick tunnels are public and use random hostnames; stop the tunnel with
  `/remote-stop` when you are done.

## RPC API

Other plugins can drive the tunnel through the registered RPC methods
(see `rpc.ts`): `remote.state`, `remote.start`, `remote.stop`,
`remote.configure`, `remote.setAutoStart`.

## License

MIT
