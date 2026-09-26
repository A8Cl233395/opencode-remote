import { makeQR, renderQR } from "./qr"
import { RemoteRpc } from "./rpc"

type Ctx = {
  options: Readonly<Record<string, any>>
  client: { rpc: (definition: unknown) => any }
  storage: {
    store: <Value extends object>(
      key: string,
      options: { initial: Value },
    ) => readonly [Value, (mutation: (draft: Value) => void) => Promise<void>]
  }
  keymap: { layer: (input: () => any) => void }
  ui: {
    toast: { show: (options: any) => void }
    dialog: {
      alert: (options: { title: string; message: string }) => Promise<void>
      prompt: (options: {
        title: string
        description?: string
        placeholder?: string
        value?: string
      }) => Promise<string | undefined>
      set: (options: { size?: "medium" | "large" | "xlarge"; centered?: boolean }) => void
    }
    slot: (claim: { append: string; render: () => unknown }) => () => void
  }
}

function parseBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value
  if (typeof value === "string") {
    const text = value.trim().toLowerCase()
    if (text === "1" || text === "true" || text === "on" || text === "yes") return true
    if (text === "0" || text === "false" || text === "off" || text === "no") return false
  }
  return undefined
}

export default {
  id: "remote",
  setup: (ctx: Ctx) => {
    const rpc = ctx.client.rpc(RemoteRpc)
    const [settings, setSettings] = ctx.storage.store("settings", { initial: { silent: false } })

    const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") =>
      ctx.ui.toast.show({ title: "remote", message, variant, duration: 4000 })

    const silent = () =>
      parseBool(process.env.OPENCODE_REMOTE_SILENT) ??
      parseBool(ctx.options.silent) ??
      settings.silent === true

    const showQR = (url: string, authUrl: string | null) => {
      let qr = ""
      try {
        qr = renderQR(makeQR(authUrl ?? url))
      } catch (error) {
        qr = `(QR failed: ${error instanceof Error ? error.message : String(error)})`
      }
      const message = [
        `Public URL: ${url}`,
        ...(authUrl
          ? [
              `Auto-login link: ${authUrl}`,
              "The QR and link above sign in automatically and grant server access; keep them private.",
            ]
          : []),
        "",
        qr,
        "",
        "Scan with your phone to open this opencode WebUI.",
        "Press Enter or esc to close.",
      ].join("\n")
      void ctx.ui.dialog.alert({ title: "remote - tunnel is up", message })
      ctx.ui.dialog.set({ size: "large" })
    }

    const runStart = async () => {
      const state = await rpc.state({})
      if (state.url) {
        if (silent()) toast(`already up: ${state.url}`, "success")
        else showQR(state.url, state.authUrl)
        return
      }
      toast("starting tunnel...")
      const result = await rpc.start({})
      if (!result.url) {
        toast(`failed: ${result.error ?? "unknown error"}`, "error")
        return
      }
      if (silent()) toast(`up: ${result.url}`, "success")
      else showQR(result.url, result.authUrl)
    }

    const commands = [
      {
        id: "remote.start",
        title: "Expose web UI (cloudflared)",
        description: "Tunnel this opencode server with cloudflared and show the QR code",
        group: "Network",
        palette: true,
        slash: { name: "remote", aliases: ["tunnel"] },
        async run() {
          await runStart()
        },
      },
      {
        id: "remote.stop",
        title: "Stop remote tunnel",
        description: "Stop the running cloudflared tunnel",
        group: "Network",
        palette: true,
        slash: { name: "remote-stop" },
        async run() {
          await rpc.stop({})
          toast("tunnel stopped")
        },
      },
      {
        id: "remote.config",
        title: "Configure remote tunnel",
        description: "Set tunnel name and hostname (persisted on the server)",
        group: "Network",
        palette: true,
        slash: { name: "remote-config" },
        async run() {
          const state = await rpc.state({})
          const current = state.tunnelName
            ? `${state.tunnelName}${state.tunnelHostname ? ` ${state.tunnelHostname}` : ""}`
            : ""
          const input = await ctx.ui.dialog.prompt({
            title: "remote - config (tunnel name + hostname; empty clears)",
            placeholder: "e.g. opencode remote.example.com",
            value: current,
          })
          if (input === undefined) return
          const parts = input.trim().split(/\s+/).filter(Boolean)
          const result = await rpc.configure({
            tunnelName: parts[0] ?? "",
            tunnelHostname: parts.slice(1).join(" "),
          })
          if (!result.ok) {
            toast(`save failed: ${result.error ?? "unknown error"}`, "error")
            return
          }
          toast(
            result.tunnelName
              ? `saved: ${result.tunnelName} -> ${result.tunnelHostname || "(no hostname)"}`
              : "saved: random hostname mode",
            "success",
          )
        },
      },
      {
        id: "remote.autostart",
        title: "Toggle auto-start tunnel",
        description: "Start the tunnel with the server, and start it now when enabled",
        group: "Network",
        palette: true,
        slash: { name: "remote-autostart" },
        async run() {
          const state = await rpc.state({})
          const next = !state.autoStart
          if (next) toast("auto-start on, starting tunnel...")
          const result = await rpc.setAutoStart({ autoStart: next })
          if (!result.ok) {
            toast(`save failed: ${result.error ?? "unknown error"}`, "error")
            return
          }
          const envNote = process.env.OPENCODE_REMOTE_AUTOSTART
            ? " (note: OPENCODE_REMOTE_AUTOSTART overrides this)"
            : ""
          if (!next) {
            toast(`auto-start off${envNote}`, "success")
            return
          }
          if (!result.url) {
            toast(`auto-start on, but start failed: ${result.error ?? "unknown error"}${envNote}`, "error")
            return
          }
          toast(`auto-start on${envNote}`, "success")
          if (silent()) toast(`up: ${result.url}`, "success")
          else showQR(result.url, result.authUrl)
        },
      },
      {
        id: "remote.silent",
        title: "Toggle silent start",
        description: "Show only a toast instead of the QR dialog",
        group: "Network",
        palette: true,
        slash: { name: "remote-silent" },
        async run() {
          const next = !(silent() === true)
          await setSettings((draft) => {
            draft.silent = next
          })
          const envNote = process.env.OPENCODE_REMOTE_SILENT
            ? " (note: OPENCODE_REMOTE_SILENT overrides this)"
            : parseBool(ctx.options.silent) !== undefined
              ? " (note: options.silent overrides this)"
              : ""
          toast(`silent ${next ? "on" : "off"}${envNote}`, "success")
        },
      },
    ]

    ctx.ui.slot({
      append: "app",
      render() {
        ctx.keymap.layer(() => ({ mode: "global", commands }))
        return null
      },
    })
  },
}
