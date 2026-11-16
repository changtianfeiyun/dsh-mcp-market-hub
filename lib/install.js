// Installing a market entry into DSH: validate the endpoint against DSH's own URL
// rules, build the mcpServers snippet the connector understands, and write a
// connection record into its storage unit so the server shows up after the next
// plugin reload.

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isIP } from 'node:net'

const CONNECTION_UNIT = { name: 'mcp_connector', version: 1 }

export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

export function connectionsFile() {
  return path.join(dshHome(), 'storages', 'mcp_connector.json')
}

function slug(value, fallback = 'server') {
  const text = String(value ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return text || fallback
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
 * DSH only connects to https, loopback http, or explicitly approved private-network
 * http. A market entry with plain http on a public host cannot be installed — say so
 * here instead of writing a record the connector will silently drop.
 */
export function validateFormat(format) {
  if (!format) return { ok: false, reason: '市场没有提供可用的安装配置（既没有 stdio 命令，也没有 HTTP 地址）。' }
  if (format.transport === 'stdio') {
    if (!format.command) return { ok: false, reason: 'stdio 配置缺少 command。' }
    return { ok: true, allowInsecurePrivateNetwork: false }
  }
  let url
  try {
    url = new URL(String(format.url || ''))
  } catch {
    return { ok: false, reason: 'HTTP 地址不是合法 URL：' + String(format.url || '') }
  }
  if (url.protocol === 'https:') return { ok: true, allowInsecurePrivateNetwork: false }
  if (url.protocol === 'http:' && isLoopback(url.hostname)) return { ok: true, allowInsecurePrivateNetwork: false }
  if (url.protocol === 'http:' && isPrivateNetwork(url.hostname)) return { ok: true, allowInsecurePrivateNetwork: true }
  return {
    ok: false,
    reason: '这个服务只提供 http 地址（' + String(format.url) + '）；DSH 连接器只接受 https、本机回环 http，或已确认的局域网 http，所以它无法直接接入。可在市场页面确认是否有 https 入口。',
  }
}

export function pickFormat(item, preferredServerKey) {
  const formats = Array.isArray(item?.formats) ? item.formats : []
  if (!formats.length) return null
  if (preferredServerKey) {
    const exact = formats.find((format) => format.serverKey === preferredServerKey)
    if (exact) return exact
  }
  // An https/loopback endpoint installs without a local runtime, so prefer one.
  const usable = formats.filter((format) => validateFormat(format).ok)
  return usable.find((format) => format.transport === 'streamable-http')
    || usable.find((format) => format.transport === 'sse')
    || usable[0]
    || formats[0]
}

export function buildServerConfig(item, format = pickFormat(item)) {
  if (!format) throw new Error('这个条目没有可用的安装配置（市场没给 stdio 命令也没给 HTTP 地址）。')
  const verdict = validateFormat(format)
  if (!verdict.ok) throw new Error(verdict.reason)
  if (format.transport === 'stdio') {
    const config = { type: 'stdio', command: format.command }
    if (format.args?.length) config.args = [...format.args]
    if (format.env && Object.keys(format.env).length) config.env = { ...format.env }
    if (format.cwd) config.cwd = format.cwd
    return config
  }
  const config = { type: format.transport === 'sse' ? 'sse' : 'streamable_http', url: format.url }
  if (verdict.allowInsecurePrivateNetwork) config.allowInsecurePrivateNetwork = true
  return config
}

export function buildImportJson(item, format = pickFormat(item)) {
  const serverKey = slug(format?.serverKey || item?.name, 'server')
  return { mcpServers: { [serverKey]: buildServerConfig(item, format) } }
}

function connectionRecord(item, format, previous, verdict) {
  const serverKey = slug(format?.serverKey || item?.name, 'server')
  const connectorId = 'market-' + slug(item.source, 'source') + '-' + slug(item.id, 'entry')
  const key = connectorId + ':' + serverKey
  const now = Date.now()
  const record = {
    key,
    connectorId,
    kind: 'json',
    name: String(item.title || item.name || serverKey),
    serverName: serverKey,
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

async function readDocument(file) {
  try {
    const text = await fsp.readFile(file, 'utf8')
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') return parsed
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return { unit: { ...CONNECTION_UNIT }, global: null, tables: { connections: {}, grants: {}, catalog: {} } }
}

async function writeAtomically(file, text) {
  const directory = path.dirname(file)
  await fsp.mkdir(directory, { recursive: true })
  const temporary = file + '.' + process.pid + '.' + Date.now() + '.tmp'
  await fsp.writeFile(temporary, text, 'utf8')
  await fsp.rename(temporary, file)
}

export async function installConnection(item, { serverKey, format } = {}) {
  const chosen = format ? { ...format, serverKey: serverKey || format.serverKey } : pickFormat(item, serverKey)
  const verdict = validateFormat(chosen)
  if (!verdict.ok) {
    const error = new Error(verdict.reason)
    error.code = 'MARKET_ENDPOINT_UNUSABLE'
    throw error
  }
  const config = buildImportJson(item, chosen)
  const file = connectionsFile()
  const document = await readDocument(file)
  document.tables = document.tables && typeof document.tables === 'object' ? document.tables : {}
  const table = document.tables.connections && typeof document.tables.connections === 'object'
    ? document.tables.connections
    : (document.tables.connections = {})
  const serverKeySafe = slug(chosen?.serverKey || item?.name, 'server')
  const previous = table[connectionRecord(item, chosen, null, verdict).key]
  const record = connectionRecord(item, chosen, previous, verdict)
  table[record.key] = record
  await writeAtomically(file, JSON.stringify(document, null, 2) + '\n')
  return {
    ok: true,
    key: record.key,
    record,
    importJson: config,
    file,
    note: '已写入 DSH 连接器存储；重载插件（或重启 DSH）后「MCP 连接器」里就能看到并连接。',
  }
}

export async function listConnections() {
  const file = connectionsFile()
  const document = await readDocument(file)
  const table = document.tables?.connections
  if (!table || typeof table !== 'object') return { file, items: [] }
  const items = Object.entries(table).map(([key, raw]) => ({
    key,
    name: String(raw?.name ?? key),
    serverName: String(raw?.serverName ?? ''),
    connectorId: String(raw?.connectorId ?? ''),
    transport: String(raw?.transport ?? ''),
    endpoint: raw?.transport === 'stdio' ? String(raw?.command ?? '') : String(raw?.url ?? ''),
    enabled: raw?.enabled !== false,
    updatedAt: Number(raw?.updatedAt) || 0,
  }))
  return { file, items }
}
