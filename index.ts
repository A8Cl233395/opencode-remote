import { spawn, type ChildProcess } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { RemoteRpc, type RemoteStartResult, type RemoteState } from "./rpc"

type PluginContext = {
  app?: { version?: string; channel?: string }
  options?: Record<string, unknown>
  storage: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
  }
  rpc: {
    register: (
      definition: unknown,
      handlers: Record<string, (input: any, context: { signal: AbortSignal }) => Promise<unknown>>,
    ) => Promise<{ dispose: () => Promise<void> }>
  }
}

const URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/
const REGISTERED_RE = /Registered tunnel connection|Connection registered|connection.*registered/i
const TIMEOUT_MS = 30000
const CONFIG_KEY = "config"
const SETTINGS_KEY = "settings"
const RECORD_KEY = "tunnel"
const AUTO_START_DELAY_MS = 1000
// How long a starting instance waits for a concurrent instance to publish its
// tunnel record before reporting the tunnel as occupied by something else.
const OCCUPANT_WAIT_MS = 8000

const PS_SCRIPT =
  "ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | Select-Object ProcessId, Name, CommandLine)"

function parseBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value
  if (typeof value === "string") {
    const text = value.trim().toLowerCase()
    if (text === "1" || text === "true" || text === "on" || text === "yes") return true
    if (text === "0" || text === "false" || text === "off" || text === "no") return false
  }
  return undefined
}

function argvValue(flag: string): string | undefined {
  const args = process.argv
  for (let index = 0; index < args.length; index++) {
    const value = args[index]
    if (value === flag && index + 1 < args.length) return args[index + 1]
    if (value.startsWith(`${flag}=`)) return value.slice(flag.length + 1)
  }
  return undefined
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "")
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

type LocalTarget = { url: string; password?: string }

// Browser links can authenticate with ?auth_token=<base64("user:password")>;
// the Web UI consumes it, strips it from the address bar, and persists the credential.
function authenticatedUrl(url: string, password: string): string {
  const token = Buffer.from(`opencode:${password}`, "utf8").toString("base64")
  return `${url}/?auth_token=${encodeURIComponent(token)}`
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// One tunnel serves the whole machine, but every location loads its own plugin
// instance. The shared record lets instances adopt a running tunnel instead of
// spawning duplicate connectors for the same named tunnel.
type TunnelRecord = {
  pid: number
  url: string
  authUrl: string | null
  local: string
  name: string
  startedAt: number
}

function deriveLocalTarget(channel: string): LocalTarget | undefined {
  const port = argvValue("--port")
  if (port && /^\d+$/.test(port) && port !== "0") {
    const rawHost = argvValue("--hostname") ?? "127.0.0.1"
    const host =
      rawHost === "0.0.0.0" || rawHost === "::" || rawHost === "[::]" || rawHost === "" ? "127.0.0.1" : rawHost
    return { url: `http://${host.includes(":") ? `[${host}]` : host}:${port}` }
  }
  // The shared background service runs as `opencode serve --service` without
  // --port, so its argv carries no address. Its registration record is the only
  // place the actual listening URL is discoverable; accept it only when the PID
  // matches this process so a foreign or stale registration is never tunneled.
  return registeredService(channel)
}

function registeredService(channel: string): LocalTarget | undefined {
  const stateDirectory = process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state")
  const filename =
    channel === "latest" || channel === "dev" || channel === "beta" || channel === "next"
      ? "service.json"
      : `service-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`
  let record: { pid?: unknown; url?: unknown; password?: unknown }
  try {
    record = JSON.parse(readFileSync(path.join(stateDirectory, "opencode", filename), "utf8"))
  } catch {
    return undefined
  }
  if (Number(record?.pid) !== process.pid) return undefined
  const url = String(record?.url ?? "").trim()
  if (!/^https?:\/\//i.test(url)) return undefined
  const parsed = new URL(url)
  if (parsed.hostname === "0.0.0.0" || parsed.hostname === "::" || parsed.hostname === "[::]") {
    parsed.hostname = "127.0.0.1"
  }
  const serviceUrl = parsed.toString().replace(/\/+$/, "")
  const password = typeof record?.password === "string" && record.password ? record.password : undefined
  return password ? { url: serviceUrl, password } : { url: serviceUrl }
}

function capture(command: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let output = ""
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (value: string) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(value)
    }
    let proc: ChildProcess
    try {
      proc = spawn(command[0], command.slice(1), { stdio: ["ignore", "pipe", "ignore"], windowsHide: true })
    } catch {
      resolve("")
      return
    }
    timer = setTimeout(() => {
      proc.kill()
      finish(output)
    }, timeoutMs)
    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8")
    })
    proc.once("error", () => finish(""))
    proc.once("exit", () => finish(output))
  })
}

async function listProcesses(): Promise<Array<{ pid: number; name: string; cmd: string }>> {
  if (process.platform === "win32") {
    let out = await capture(["powershell", "-NoProfile", "-NonInteractive", "-Command", PS_SCRIPT], 8000)
    if (!out.trim()) out = await capture(["pwsh", "-NoProfile", "-NonInteractive", "-Command", PS_SCRIPT], 8000)
    try {
      const parsed = JSON.parse(out)
      const items = Array.isArray(parsed) ? parsed : [parsed]
      return items
        .map((item: any) => ({
          pid: Number(item?.ProcessId),
          name: String(item?.Name ?? ""),
          cmd: String(item?.CommandLine ?? ""),
        }))
        .filter((item) => Number.isInteger(item.pid) && item.pid > 0 && item.cmd)
    } catch {
      return []
    }
  }
  const out = await capture(["ps", "-eo", "pid=,comm=,args="], 5000)
  const processes: Array<{ pid: number; name: string; cmd: string }> = []
  for (const line of out.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.+)$/)
    if (match) processes.push({ pid: Number(match[1]), name: match[2].split(/[\\/]/).pop() ?? match[2], cmd: match[3] })
  }
  return processes
}

function cmdLineMatches(cmd: string, local: string, name: string): boolean {
  const tokens = cmd.split(/\s+/).map((token) => token.replace(/^["']|["']$/g, ""))
  if (name && tokens.some((token) => token.toLowerCase() === name.toLowerCase())) return true
  const norm = (value: string) => value.replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase()
  const wanted = norm(local)
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] === "--url" && tokens[index + 1] && norm(tokens[index + 1]) === wanted) return true
    if (tokens[index].toLowerCase().startsWith("--url=") && norm(tokens[index].slice(6)) === wanted) return true
  }
  return false
}

export default {
  id: "remote",
  setup: async (ctx: PluginContext) => {
    const options = ctx.options ?? {}
    const optionText = (key: string) => (typeof options[key] === "string" ? String(options[key]).trim() : "")

    let child: { proc: ChildProcess; kill: () => void } | null = null
    let activeUrl = ""
    let activeAuthUrl: string | null = null
    let starting = false
    let inflight: Promise<RemoteStartResult> | null = null
    let opGen = 0
    let lastKilledPid = 0
    let lastKilledAt = 0
    let disposed = false

    const cloudflared = () =>
      String(
        options.cloudflared ?? process.env.OPENCODE_CLOUDFLARED ?? process.env.CLOUDFLARED_PATH ?? "cloudflared",
      ).trim()

    async function tunnelConfig(): Promise<{ name: string; hostname: string }> {
      const stored = (await ctx.storage.get(CONFIG_KEY).catch(() => undefined)) as
        | { tunnelName?: string; tunnelHostname?: string }
        | undefined
      const envName = (process.env.OPENCODE_TUNNEL_NAME ?? "").trim()
      const envHost = (process.env.OPENCODE_TUNNEL_HOSTNAME ?? "").trim()
      return {
        name: String(envName || optionText("tunnelName") || stored?.tunnelName || "").trim(),
        hostname: String(envHost || optionText("tunnelHostname") || stored?.tunnelHostname || "").trim(),
      }
    }

    async function autoStartEnabled(): Promise<boolean> {
      const stored = (await ctx.storage.get(SETTINGS_KEY).catch(() => undefined)) as { autoStart?: boolean } | undefined
      return (
        parseBool(process.env.OPENCODE_REMOTE_AUTOSTART) ??
        parseBool(options.autoStart) ??
        parseBool(stored?.autoStart) ??
        false
      )
    }

    function localTarget(): LocalTarget | undefined {
      const forced = String(optionText("url") || (process.env.OPENCODE_REMOTE_URL ?? "").trim()).trim()
      if (forced) return { url: normalizeUrl(forced) }
      return deriveLocalTarget(String(ctx.app?.channel ?? "latest"))
    }

    function tunnelURL(cfg: { hostname: string }): string | null {
      const hostname = cfg.hostname.trim()
      if (!hostname) return null
      return normalizeUrl(hostname)
    }

    function noteKilledPid(pid: number) {
      if (Number.isInteger(pid) && pid > 0) {
        lastKilledPid = pid
        lastKilledAt = Date.now()
      }
    }

    function noteKilled(proc: ChildProcess) {
      noteKilledPid(Number(proc.pid))
    }

    async function readRecord(): Promise<TunnelRecord | undefined> {
      const value = await ctx.storage.get(RECORD_KEY).catch(() => undefined)
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
      const stored = value as Partial<TunnelRecord>
      const pid = Number(stored.pid)
      if (!Number.isInteger(pid) || pid <= 0) return undefined
      if (!processAlive(pid)) {
        await ctx.storage.remove(RECORD_KEY).catch(() => {})
        return undefined
      }
      if (typeof stored.url !== "string" || !stored.url) return undefined
      return {
        pid,
        url: stored.url,
        authUrl: typeof stored.authUrl === "string" ? stored.authUrl : null,
        local: typeof stored.local === "string" ? stored.local : "",
        name: typeof stored.name === "string" ? stored.name : "",
        startedAt: Number(stored.startedAt) || 0,
      }
    }

    async function removeRecord(pid?: number) {
      if (pid !== undefined) {
        const record = (await ctx.storage.get(RECORD_KEY).catch(() => undefined)) as Partial<TunnelRecord> | undefined
        if (!record || Number(record.pid) !== pid) return
      }
      await ctx.storage.remove(RECORD_KEY).catch(() => {})
    }

    async function waitForRecord(pids: number[], ms: number): Promise<TunnelRecord | undefined> {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        const record = await readRecord()
        if (record && pids.includes(record.pid)) return record
        if (pids.length > 0 && !pids.some(processAlive)) return undefined
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      return undefined
    }

    function spawnTunnel(local: string, name: string): ChildProcess {
      const args = name
        ? ["tunnel", "run", "--url", local, name]
        : ["tunnel", "--no-autoupdate", "--url", local]
      return spawn(cloudflared(), args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true })
    }

    function waitForLog(
      proc: ChildProcess,
      ms: number,
      pattern: RegExp,
      extract?: RegExp,
    ): Promise<string | null> {
      return new Promise((resolve) => {
        let buffer = ""
        let settled = false
        const finish = (value: string | null) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(value)
        }
        const timer = setTimeout(() => finish(null), ms)
        proc.stderr?.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf-8")
          if (extract) {
            const match = buffer.match(extract)
            if (match) return finish(match[0])
            return
          }
          if (pattern.test(buffer)) finish("")
        })
        proc.once("error", () => finish(null))
        proc.once("exit", () => finish(null))
      })
    }

    async function findOccupantPids(local: string, name: string): Promise<number[]> {
      const binaries = ["cloudflared"]
      const base = cloudflared().split(/[\\/]/).pop()?.toLowerCase() ?? ""
      if (base && !binaries.includes(base)) binaries.push(base)
      const pids: number[] = []
      for (const processInfo of await listProcesses()) {
        if (processInfo.pid === process.pid) continue
        if (processInfo.pid === lastKilledPid && Date.now() - lastKilledAt < 10000) continue
        // Match the executable, not command-line text: unrelated shells that
        // merely mention cloudflared and the tunnel name must not count.
        const binary = processInfo.name.toLowerCase()
        if (!binary.includes("cloudflared") && !binaries.includes(binary)) continue
        if (cmdLineMatches(processInfo.cmd, local, name)) pids.push(processInfo.pid)
      }
      return pids
    }

    async function startInternal(): Promise<RemoteStartResult> {
      starting = true
      const myGen = ++opGen
      try {
        const cfg = await tunnelConfig()
        const target = localTarget()
        if (!target) {
          return {
            url: null,
            authUrl: null,
            error:
              "backend is not listening on a TCP port; start opencode with --port, or set options.url / OPENCODE_REMOTE_URL",
          }
        }
        const existing = await readRecord()
        if (opGen !== myGen) return { url: null, authUrl: null, error: null }
        if (existing && (!existing.local || existing.local === target.url)) {
          activeUrl = existing.url
          activeAuthUrl = existing.authUrl
          return { url: existing.url, authUrl: existing.authUrl, error: null }
        }
        const occupants = await findOccupantPids(target.url, cfg.name)
        if (opGen !== myGen) return { url: null, authUrl: null, error: null }
        if (occupants.length > 0) {
          // Another plugin instance may be mid-start; give it a moment to publish
          // its record so both instances converge on the same process.
          const adopted = await waitForRecord(occupants, OCCUPANT_WAIT_MS)
          if (opGen !== myGen) return { url: null, authUrl: null, error: null }
          if (adopted) {
            activeUrl = adopted.url
            activeAuthUrl = adopted.authUrl
            return { url: adopted.url, authUrl: adopted.authUrl, error: null }
          }
          return {
            url: null,
            authUrl: null,
            error: `tunnel already in use: system already has a cloudflared process (PID ${occupants[0]}) using the same tunnel/backend`,
          }
        }

        let proc: ChildProcess
        try {
          proc = spawnTunnel(target.url, cfg.name)
        } catch {
          return {
            url: null,
            authUrl: null,
            error: "could not start cloudflared; install it or set OPENCODE_CLOUDFLARED",
          }
        }
        const pid = Number(proc.pid)
        const handle = {
          proc,
          kill: () => {
            noteKilledPid(pid)
            try {
              proc.kill()
            } catch {}
          },
        }
        child = handle
        const clear = () => {
          if (child === handle) {
            child = null
            activeUrl = ""
            activeAuthUrl = null
          }
          if (Number.isInteger(pid) && pid > 0) void removeRecord(pid)
        }
        proc.once("exit", clear)
        proc.once("error", clear)

        const expected = tunnelURL(cfg)
        const url = expected
          ? (await waitForLog(proc, TIMEOUT_MS, REGISTERED_RE)) !== null
            ? expected
            : null
          : await waitForLog(proc, TIMEOUT_MS, URL_RE, URL_RE)

        if (opGen !== myGen) {
          handle.kill()
          return { url: null, authUrl: null, error: null }
        }
        if (!url) {
          handle.kill()
          clear()
          return {
            url: null,
            authUrl: null,
            error: expected
              ? `named tunnel "${cfg.name}" failed to connect; check that it exists and has a DNS route`
              : "could not obtain the public URL; check the network and retry",
          }
        }
        // Two instances can pass the occupant scan before either process exists.
        // The lowest PID wins; every other spawner withdraws and adopts the
        // winner's record instead of leaving duplicate connectors behind.
        const rivals = (await findOccupantPids(target.url, cfg.name)).filter((candidate) => candidate !== pid)
        if (rivals.length > 0) {
          const winnerPid = Math.min(pid, ...rivals)
          if (pid !== winnerPid) {
            handle.kill()
            clear()
            const winner = await waitForRecord([winnerPid], OCCUPANT_WAIT_MS)
            if (winner) {
              activeUrl = winner.url
              activeAuthUrl = winner.authUrl
              return { url: winner.url, authUrl: winner.authUrl, error: null }
            }
            return { url: null, authUrl: null, error: "tunnel start raced another instance; retry" }
          }
        }
        activeUrl = url
        activeAuthUrl = target.password ? authenticatedUrl(url, target.password) : null
        await ctx.storage
          .set(RECORD_KEY, {
            pid,
            url,
            authUrl: activeAuthUrl,
            local: target.url,
            name: cfg.name,
            startedAt: Date.now(),
          } satisfies TunnelRecord)
          .catch(() => {})
        return { url, authUrl: activeAuthUrl, error: null }
      } finally {
        starting = false
      }
    }

    function start(): Promise<RemoteStartResult> {
      if (activeUrl) return Promise.resolve({ url: activeUrl, authUrl: activeAuthUrl, error: null })
      if (inflight) return inflight
      inflight = startInternal().finally(() => {
        inflight = null
      })
      return inflight
    }

    async function stop(): Promise<{ ok: boolean }> {
      opGen++
      const record = await readRecord()
      if (record) {
        noteKilledPid(record.pid)
        try {
          process.kill(record.pid)
        } catch {}
        await removeRecord(record.pid)
      }
      child?.kill()
      child = null
      activeUrl = ""
      activeAuthUrl = null
      return { ok: true }
    }

    async function state(): Promise<RemoteState> {
      const cfg = await tunnelConfig()
      const record = await readRecord()
      const ownPid = Number(child?.proc.pid)
      const ownAlive = Number.isInteger(ownPid) && ownPid > 0 && processAlive(ownPid)
      // An adopted tunnel has no local child process; if its shared record is
      // gone the process is gone too, so drop the stale view.
      if (activeUrl && !record && !ownAlive) {
        activeUrl = ""
        activeAuthUrl = null
      }
      return {
        url: activeUrl || record?.url || null,
        authUrl: activeUrl ? activeAuthUrl : (record?.authUrl ?? null),
        starting: starting || inflight !== null,
        tunnelName: cfg.name,
        tunnelHostname: cfg.hostname,
        autoStart: await autoStartEnabled(),
      }
    }

    async function configure(input: { tunnelName?: string; tunnelHostname?: string }) {
      const next = {
        tunnelName: String(input?.tunnelName ?? "").trim(),
        tunnelHostname: String(input?.tunnelHostname ?? "").trim(),
      }
      await ctx.storage.set(CONFIG_KEY, next)
      const saved = (await ctx.storage.get(CONFIG_KEY).catch(() => undefined)) as
        | { tunnelName?: string; tunnelHostname?: string }
        | undefined
      const ok =
        String(saved?.tunnelName ?? "") === next.tunnelName &&
        String(saved?.tunnelHostname ?? "") === next.tunnelHostname
      return {
        ok,
        tunnelName: next.tunnelName,
        tunnelHostname: next.tunnelHostname,
        error: ok ? null : "saved configuration did not read back",
      }
    }

    async function setAutoStart(input: { autoStart?: boolean }) {
      const next = { autoStart: input?.autoStart === true }
      await ctx.storage.set(SETTINGS_KEY, next)
      const saved = (await ctx.storage.get(SETTINGS_KEY).catch(() => undefined)) as { autoStart?: boolean } | undefined
      const ok = saved?.autoStart === next.autoStart
      if (!ok) return { ok, url: null, authUrl: null, error: "saved configuration did not read back" }
      if (!next.autoStart) return { ok, url: null, authUrl: null, error: null }
      // Enabling auto-start starts the tunnel now too: the shared service is
      // long-lived, so waiting for the next server boot would make the switch
      // look inert until the service restarts.
      const result = await start()
      return { ok, url: result.url, authUrl: result.authUrl, error: result.error }
    }

    const registration = await ctx.rpc.register(RemoteRpc, {
      state: () => state(),
      start: () => start(),
      stop: () => stop(),
      configure: (input: { tunnelName?: string; tunnelHostname?: string }) => configure(input),
      setAutoStart: (input: { autoStart?: boolean }) => setAutoStart(input),
    })

    if (!disposed && (await autoStartEnabled())) {
      const timer = setTimeout(() => {
        void start().catch((error) => console.error("remote: auto-start failed", error))
      }, AUTO_START_DELAY_MS)
      timer.unref?.()
    }

    return async () => {
      disposed = true
      opGen++
      // Unloading this instance must not tear down a tunnel another location
      // owns; only the process this instance spawned is ours to kill.
      child?.kill()
      child = null
      activeUrl = ""
      activeAuthUrl = null
      await registration.dispose()
    }
  },
}
