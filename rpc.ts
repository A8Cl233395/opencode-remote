const emptyInput = { type: "object", properties: {} }

const stateOutput = {
  type: "object",
  properties: {
    url: { anyOf: [{ type: "string" }, { type: "null" }] },
    authUrl: { anyOf: [{ type: "string" }, { type: "null" }] },
    starting: { type: "boolean" },
    tunnelName: { type: "string" },
    tunnelHostname: { type: "string" },
    autoStart: { type: "boolean" },
  },
}

const startOutput = {
  type: "object",
  properties: {
    url: { anyOf: [{ type: "string" }, { type: "null" }] },
    authUrl: { anyOf: [{ type: "string" }, { type: "null" }] },
    error: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
}

const configureInput = {
  type: "object",
  properties: {
    tunnelName: { type: "string" },
    tunnelHostname: { type: "string" },
  },
}

const configureOutput = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    tunnelName: { type: "string" },
    tunnelHostname: { type: "string" },
    error: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
}

const okOutput = {
  type: "object",
  properties: { ok: { type: "boolean" } },
}

const autoStartInput = {
  type: "object",
  properties: { autoStart: { type: "boolean" } },
  required: ["autoStart"],
}

const autoStartOutput = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    url: { anyOf: [{ type: "string" }, { type: "null" }] },
    authUrl: { anyOf: [{ type: "string" }, { type: "null" }] },
    error: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
}

export const RemoteRpc = {
  id: "remote",
  methods: {
    state: { input: emptyInput, output: stateOutput },
    start: { input: emptyInput, output: startOutput },
    stop: { input: emptyInput, output: okOutput },
    configure: { input: configureInput, output: configureOutput },
    setAutoStart: { input: autoStartInput, output: autoStartOutput },
  },
  events: {},
} as const

export type RemoteState = {
  url: string | null
  authUrl: string | null
  starting: boolean
  tunnelName: string
  tunnelHostname: string
  autoStart: boolean
}

export type RemoteStartResult = { url: string | null; authUrl: string | null; error: string | null }
