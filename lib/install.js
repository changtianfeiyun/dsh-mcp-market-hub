// dsh-mcp-market-hub — install layer.
//
// Where an entry lands depends on what the host actually has:
//
//   mcp-manager  DSH's built-in @deepseek-ai/dsh-mcp-manager (ctx.mcpManager,
//                shipped with DSH since 0.2.x). Servers register live — no
//                restart, no third-party plugin — and this package keeps its own
//                store so they come back on the next boot.
//   connector    The optional third-party dsh-mcp-connector plugin. Kept as a
//                fallback for hosts without mcp-manager; it reads
//                ~/.dsh/storages/mcp_connector.json.
//
// Nothing here is specific to one machine: paths derive from DSH_HOME, and the
// endpoint rules follow the target's real transport (mcp-client accepts any
// http(s) URL, so plain-http market endpoints install fine on mcp-manager).

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isIP } from 'node:net'

export const TARGETS = {
  manager: 'mcp-manager',
  connector: 'connector',
}

const MANAGER_STORE_UNIT = { name: 'mcp_market_hub', version: 1 }
const CONNECTION_UNIT = { name: 'mcp_connector', version: 1 }

/** DSH's own server-name rule (dsh-mcp-client SERVER_NAME_PATTERN). */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

/** Our own record of what this plugin installed through mcp-manager. */
export function storeFile() {
  return path.join(dshHome(), 'storages', 'mcp_market_hub.json')
}

/** The third-party connector's file (only used on the fallback path). */
export function connectionsFile() {
  return path.join(dshHome(), 'storages', 'mcp_connector.json')
}

function slug(value, fallback = 'server') {
  const text = String(value ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return text || fallback
}

/** A name mcp-manager will accept: <=32 chars, [A-Za-z0-9_-] only. */
export function serverName(value, fallback = 'server') {
  let text = String(value ?? '').trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!text) text = fallback
  return text.slice(0, 32)
}

function isLoopback(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

function isPrivateNetwork(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  const version = isIP(host)
  if (version === 4) {
    const octets = host.split('.').map(Number)
    return octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168)
  }
  if (version === 6) {
    const first = Number.parseInt(host.split(':')[0], 16)
    return Number.isFinite(first) && (first & 0xfe00) === 0xfc00
  }
  return false
}

/**
 * Judge one format for one target. `mcp-manager` hands the URL straight to
 * StreamableHTTPClientTransport, which accepts any http(s) endpoint, so only the
 * URL's shape matters. `connector` is the stricter third-party plugin: https,
 * loopback http, or an explicitly approved private-network http.
 */
export function validateFormat(format, target = TARGETS.manager) {
  if (!format) return { ok: false, reason: '市场没有提供可用的安装配置（既没有 stdio 命令，也没有 HTTP 地址）。' }
  if (format.transport === 'stdio') {
    if (!format.command) return { ok: false, reason: 'stdio 配置缺少 command。' }
    return { ok: true, allowInsecurePrivateNetwork: false, transport: 'stdio' }
  }
  let url
  try {
    url = new URL(String(format.url || ''))
  } catch {
    return { ok: false, reason: 'HTTP 地址不是合法 URL：' + String(format.url || '') }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: '只支持 http/https 地址，这个条目的是 ' + url.protocol }
  }
  if (target === TARGETS.manager) {
    // DSH's mcp-client does not restrict the scheme; sse is the one real gap,
    // because mcp-manager only knows stdio and streamable-http.
    if (format.transport === 'sse') {
      return {
        ok: false,
        transport: 'sse',
        reason: '这个条目只提供 SSE 地址（' + String(format.url) + '）。DSH 内置的 MCP 管理器只支持 stdio 与 streamable-http，SSE 无法直接注册；可在详情页确认有没有 streamable-http 入口。',
      }
    }
    return { ok: true, allowInsecurePrivateNetwork: false, transport: 'streamable-http' }
  }
  if (url.protocol === 'https:') return { ok: true, allowInsecurePrivateNetwork: false, transport: 'streamable-http' }
  if (isLoopback(url.hostname)) return { ok: true, allowInsecurePrivateNetwork: false, transport: 'streamable-http' }
  if (isPrivateNetwork(url.hostname)) return { ok: true, allowInsecurePrivateNetwork: true, transport: 'streamable-http' }
  return {
    ok: false,
    transport: 'streamable-http',
    reason: '这个服务只提供 http 地址（' + String(format.url) + '）；dsh-mcp-connector 只接受 https、本机回环 http，或已确认的局域网 http。',
  }
}

export function pickFormat(item, preferredServerKey, target = TARGETS.manager) {
  const formats = Array.isArray(item?.formats) ? item.formats : []
  if (!formats.length) return null
  if (preferredServerKey) {
    const exact = formats.find((format) => format.serverKey === preferredServerKey)
    if (exact) return exact
  }
  const usable = formats.filter((format) => validateFormat(format, target).ok)
  return usable.find((format) => format.transport === 'streamable-http')
    || usable.find((format) => format.transport === 'stdio')
    || usable[0]
    || formats[0]
}

/**
 * The entry mcp-manager registers (ServerEntrySchema). Cross-transport fields
 * are omitted rather than blanked: validateEntries rejects a stdio entry that
 * carries a url and an http entry that carries a command.
 */
export function buildServerEntry(item, format = pickFormat(item), target = TARGETS.manager) {
  if (!format) throw new Error('这个条目没有可用的安装配置（市场没给 stdio 命令也没给 HTTP 地址）。')
  const verdict = validateFormat(format, target)
  if (!verdict.ok) throw new Error(verdict.reason)
  if (format.transport === 'stdio') {
    const entry = { transport: 'stdio', command: String(format.command) }
    if (format.args?.length) entry.args = format.args.map(String)
    if (format.env && Object.keys(format.env).length) entry.env = Object.fromEntries(Object.entries(format.env).map(([k, v]) => [k, String(v)]))
    if (format.cwd) entry.cwd = String(format.cwd)
    return entry
  }
  return { transport: 'streamable-http', url: String(format.url) }
}

/** The connector's own record shape (fallback target only). */
function connectorRecord(item, format, previous, verdict) {
  const key = connectorId(item) + ':' + slug(format?.serverKey || item?.name, 'server')
  const now = Date.now()
  const record = {
    key,
    connectorId: connectorId(item),
    kind: 'json',
    name: String(item.title || item.name || key),
    serverName: slug(format?.serverKey || item?.name, 'server'),
    transport: format?.transport === 'sse' ? 'sse' : format?.transport === 'stdio' ? 'stdio' : 'streamable-http',
    enabled: true,
    createdAt: Number(previous?.createdAt) || now,
    updatedAt: now,
  }
  if (record.transport === 'stdio') {
    record.command = String(format.command || '')
    record.args = Array.isArray(format.args) ? format.args.map(String) : []
    record.env = format.env && typeof format.env === 'object' ? { ...format.env } : {}
    record.cwd = String(format.cwd || '')
  } else {
    record.url = String(format.url || '')
    record.headers = {}
    if (verdict?.allowInsecurePrivateNetwork) record.allowInsecurePrivateNetwork = true
  }
  return record
}

function connectorId(item) {
  return 'market-' + slug(item?.source, 'source') + '-' + slug(item?.id, 'entry')
}

/** The mcpServers snippet users can paste into any other MCP client. */
export function buildImportJson(item, format = pickFormat(item)) {
  const name = serverName(format?.serverKey || item?.name, 'server')
  if (format?.transport === 'stdio') {
    const config = { command: String(format.command || '') }
    if (format.args?.length) config.args = format.args.map(String)
    if (format.env && Object.keys(format.env).length) config.env = { ...format.env }
    if (format.cwd) config.cwd = String(format.cwd)
    return { mcpServers: { [name]: config } }
  }
  return { mcpServers: { [name]: { type: format?.transport === 'sse' ? 'sse' : 'streamable-http', url: String(format?.url || '') } } }
}

/**
 * Read-only surfaces (detail drawer, install preview) must never blow up on an
 * entry that cannot be installed. Return the reason instead of throwing.
 */
export function describeInstall(item, format = pickFormat(item), target = TARGETS.manager) {
  const verdict = validateFormat(format, target)
  if (!verdict.ok) return { ok: false, importJson: null, reason: verdict.reason, format: format || null, target }
  try {
    return { ok: true, importJson: buildImportJson(item, format), reason: '', format, target }
  } catch (error) {
    return { ok: false, importJson: null, reason: String(error?.message || error), format: format || null, target }
  }
}

async function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'))
    if (parsed && typeof parsed === 'object') return parsed
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return fallback()
}

async function writeAtomically(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temporary = file + '.' + process.pid + '.' + Date.now() + '.tmp'
  await fsp.writeFile(temporary, text, 'utf8')
  await fsp.rename(temporary, file)
}

/* ── mcp-manager store (primary target) ─────────────────────────────── */

export async function readStore() {
  const file = storeFile()
  const document = await readJson(file, () => ({ unit: { ...MANAGER_STORE_UNIT }, servers: {} }))
  document.unit = document.unit && typeof document.unit === 'object' ? document.unit : { ...MANAGER_STORE_UNIT }
  document.servers = document.servers && typeof document.servers === 'object' ? document.servers : {}
  return { file, document }
}

async function saveStore(document) {
  const file = storeFile()
  await writeAtomically(file, JSON.stringify(document, null, 2) + '\n')
  return file
}

/** Names already taken in our store, so a second install of the same key is an update. */
function nameFor(item, format, document) {
  const base = serverName(format?.serverKey || item?.name, 'server')
  const owner = connectorId(item)
  const existing = document.servers[base]
  if (!existing || existing.owner === owner) return base
  // Different entry wants the same name: keep both by suffixing the source id.
  const suffix = '-' + slug(item?.source, 'src').slice(0, 4) + '-' + String(Math.abs(hash(owner)) % 1000)
  return serverName(base.slice(0, Math.max(1, 32 - suffix.length)) + suffix, base)
}

function hash(text) {
  let value = 0
  for (let index = 0; index < text.length; index += 1) value = (value * 31 + text.charCodeAt(index)) | 0
  return value
}

export async function storeEntry(item, { serverKey, format } = {}) {
  const chosen = format ? { ...format, serverKey: serverKey || format.serverKey } : pickFormat(item, serverKey)
  const verdict = validateFormat(chosen, TARGETS.manager)
  if (!verdict.ok) {
    const error = new Error(verdict.reason)
    error.code = 'MARKET_ENDPOINT_UNUSABLE'
    throw error
  }
  const { document, file } = await readStore()
  const name = nameFor(item, chosen, document)
  const entry = buildServerEntry(item, chosen, TARGETS.manager)
  document.servers[name] = {
    owner: connectorId(item),
    title: String(item?.title || item?.name || name),
    source: String(item?.source || ''),
    id: String(item?.id || ''),
    entry,
    enabled: true,
    updatedAt: Date.now(),
  }
  await saveStore(document)
  return { ok: true, name, entry, file, record: document.servers[name] }
}

export async function forgetEntry(name) {
  const { document } = await readStore()
  if (!document.servers[name]) return { ok: false, reason: '没有这条安装记录：' + name }
  delete document.servers[name]
  await saveStore(document)
  return { ok: true, name }
}

/* ── connector fallback ─────────────────────────────────────────────── */

export async function installConnection(item, { serverKey, format } = {}) {
  const chosen = format ? { ...format, serverKey: serverKey || format.serverKey } : pickFormat(item, serverKey, TARGETS.connector)
  const verdict = validateFormat(chosen, TARGETS.connector)
  if (!verdict.ok) {
    const error = new Error(verdict.reason)
    error.code = 'MARKET_ENDPOINT_UNUSABLE'
    throw error
  }
  const file = connectionsFile()
  const document = await readJson(file, () => ({ unit: { ...CONNECTION_UNIT }, global: null, tables: { connections: {}, grants: {}, catalog: {} } }))
  document.tables = document.tables && typeof document.tables === 'object' ? document.tables : {}
  const table = document.tables.connections && typeof document.tables.connections === 'object'
    ? document.tables.connections
    : (document.tables.connections = {})
  const previous = table[connectorRecord(item, chosen, null, verdict).key]
  const record = connectorRecord(item, chosen, previous, verdict)
  table[record.key] = record
  await writeAtomically(file, JSON.stringify(document, null, 2) + '\n')
  return {
    ok: true,
    key: record.key,
    record,
    importJson: buildImportJson(item, chosen),
    file,
    note: '已写入 dsh-mcp-connector 的连接文件；重载该插件（或重启 DSH）后连接才生效。',
  }
}

export async function listConnections() {
  const store = await readStore()
  const items = Object.entries(store.document.servers).map(([name, raw]) => ({
    key: name,
    name: String(raw?.title || name),
    serverName: name,
    connectorId: String(raw?.owner || ''),
    transport: String(raw?.entry?.transport || ''),
    endpoint: raw?.entry?.transport === 'stdio' ? String(raw?.entry?.command || '') : String(raw?.entry?.url || ''),
    enabled: raw?.enabled !== false,
    updatedAt: Number(raw?.updatedAt) || 0,
  }))
  const legacyFile = connectionsFile()
  const legacy = await readJson(legacyFile, () => null).catch(() => null)
  const table = legacy?.tables?.connections
  const legacyItems = table && typeof table === 'object'
    ? Object.entries(table).map(([key, raw]) => ({
      key,
      name: String(raw?.name ?? key),
      serverName: String(raw?.serverName ?? ''),
      connectorId: String(raw?.connectorId ?? ''),
      transport: String(raw?.transport ?? ''),
      endpoint: raw?.transport === 'stdio' ? String(raw?.command ?? '') : String(raw?.url ?? ''),
      enabled: raw?.enabled !== false,
      updatedAt: Number(raw?.updatedAt) || 0,
      via: 'connector',
    }))
    : []
  return { file: store.file, legacyFile, items, legacyItems }
}
