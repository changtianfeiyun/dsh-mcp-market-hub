// Market source adapters: mcpmarket.cn (aggregated GitHub MCP directory) and
// ModelScope / 魔搭 MCP square. Both are public read-only JSON APIs, so the panel
// can aggregate them without credentials. Everything is normalized to one shape:
//   { source, id, name, title, author, description, categories, tags, stars, hot,
//     featured, hosted, url, icon, formats: [{ serverKey, transport, ... }] }
// so the UI never needs to care which market a card came from.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) dsh-mcp-market-hub/0.1'
const TIMEOUT_MS = 20000

export const SOURCES = [
  { id: 'mcpmarket', label: 'MCP Market', home: 'https://mcpmarket.cn', note: '聚合 GitHub 上的 MCP 服务' },
  { id: 'modelscope', label: '魔搭 ModelScope', home: 'https://modelscope.cn/mcp', note: '魔搭 MCP 广场' },
]

async function getJson(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': UA },
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200)}`)
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`返回的不是 JSON（前 200 字符）：${text.slice(0, 200)}`)
    }
  } finally {
    clearTimeout(timer)
  }
}

function absolute(base, value) {
  if (!value) return ''
  try {
    return new URL(String(value), base).toString()
  } catch {
    return ''
  }
}

/** Pull every "mcpServers" block out of a market record into installable formats. */
function collectFormats(blocks, out = []) {
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    const servers = block.mcpServers ?? block
    if (!servers || typeof servers !== 'object') continue
    for (const [serverKey, entry] of Object.entries(servers)) {
      if (!entry || typeof entry !== 'object') continue
      const rawType = String(entry.type ?? '').toLowerCase()
      const url = typeof entry.url === 'string' ? entry.url.trim() : ''
      const command = typeof entry.command === 'string' ? entry.command.trim() : ''
      let format = null
      if (url) {
        const transport = rawType === 'sse' ? 'sse' : 'streamable-http'
        format = { serverKey, transport, url }
      } else if (command) {
        format = {
          serverKey,
          transport: 'stdio',
          command,
          args: Array.isArray(entry.args) ? entry.args.map(String) : [],
          env: entry.env && typeof entry.env === 'object'
            ? Object.fromEntries(Object.entries(entry.env).map(([k, v]) => [k, String(v)]))
            : {},
          cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
        }
      }
      if (format && !out.some((f) => f.serverKey === format.serverKey && f.transport === format.transport
        && f.url === format.url && f.command === format.command)) out.push(format)
    }
  }
  return out
}

/* ── mcpmarket.cn ───────────────────────────────────────────────────── */

const MCM_HOME = 'https://mcpmarket.cn'

function normalizeMcmListRow(row) {
  const id = String(row?._id ?? row?.id ?? '')
  return {
    source: 'mcpmarket',
    id,
    name: String(row?.name || row?.alias || 'unnamed'),
    title: String(row?.alias || row?.name || 'unnamed'),
    subtitle: String(row?.alias_en || ''),
    author: String(row?.by || ''),
    description: typeof row?.description === 'string' ? row.description : '',
    categories: Array.isArray(row?.categories) ? row.categories.map(String) : [],
    tags: Array.isArray(row?.mcp_type) ? row.mcp_type.map(String) : [],
    stars: Number(row?.stars) || 0,
    hot: Number(row?.recent_stars_increase) || 0,
    featured: row?.featured === true,
    hosted: row?.hosted === true,
    url: absolute(MCM_HOME, row?.url) || MCM_HOME,
    icon: absolute(MCM_HOME, row?.logo) || '',
    formats: [],
  }
}

function normalizeMcmDetail(raw) {
  const base = normalizeMcmListRow(raw)
  const zh = typeof raw?.description === 'object' ? raw.description?.zh : ''
  const en = typeof raw?.description === 'object' ? raw.description?.en : ''
  const formats = []
  collectFormats(Array.isArray(raw?.mcp_config) ? raw.mcp_config : [raw?.mcp_config], formats)
  if (raw?.mcp_url?.streamable_http_url) {
    formats.push({ serverKey: base.name, transport: 'streamable-http', url: String(raw.mcp_url.streamable_http_url) })
  }
  return {
    ...base,
    description: String(zh || en || base.description || ''),
    descriptionEn: String(en || ''),
    overview: typeof raw?.overview === 'string' ? raw.overview : '',
    authType: typeof raw?.auth_type === 'string' ? raw.auth_type : '',
    formats: formats.length ? formats : base.formats,
    raw,
  }
}

export async function mcmCategories() {
  const data = await getJson(`${MCM_HOME}/api/categories`)
  const rows = Array.isArray(data) ? data : Array.isArray(data?.categories) ? data.categories : []
  return rows.map((row) => ({
    source: 'mcpmarket',
    id: String(row?.id ?? row?.name ?? ''),
    name: String(row?.name ?? row?.id ?? ''),
    count: Number(row?.count) || 0,
  }))
}

export async function mcmSearch({ query = '', category = '', page = 1 } = {}) {
  const params = new URLSearchParams({ page: String(page) })
  if (query) params.set('search', query)
  if (category && category !== '全部') params.set('category', category)
  const data = await getJson(`${MCM_HOME}/api/servers?${params.toString()}`)
  const rows = Array.isArray(data?.servers) ? data.servers : []
  return {
    source: 'mcpmarket',
    items: rows.map(normalizeMcmListRow),
    total: Number(data?.total_servers) || rows.length,
    page: Number(data?.current_page) || page,
    pageCount: Number(data?.total_pages) || 1,
  }
}

export async function mcmDetail(id) {
  const raw = await getJson(`${MCM_HOME}/api/servers/${encodeURIComponent(id)}`)
  return normalizeMcmDetail(raw)
}

/* ── ModelScope / 魔搭 ──────────────────────────────────────────────── */

const MS_HOME = 'https://modelscope.cn'
const MS_API = `${MS_HOME}/api/v1/mcpServers/list`

function normalizeMsRow(row) {
  const formats = []
  collectFormats([
    ...(Array.isArray(row?.ServerConfig) ? row.ServerConfig : []),
    ...(Array.isArray(row?.StreamableHTTPServerConfig) ? row.StreamableHTTPServerConfig : []),
    ...(Array.isArray(row?.SSEServerConfig) ? row.SSEServerConfig : []),
  ], formats)
  if (row?.DeployedUrl) {
    const transport = String(row?.DeployedUrlTransportType || '').toLowerCase().includes('sse') ? 'sse' : 'streamable-http'
    formats.push({ serverKey: String(row?.Name || 'server'), transport, url: String(row.DeployedUrl) })
  }
  const name = String(row?.Name ?? 'unnamed')
  const owner = String(row?.Path ?? '')
  return {
    source: 'modelscope',
    id: String(row?.Id ?? name),
    name,
    title: String(row?.ChineseName || name),
    subtitle: name,
    author: owner,
    description: String(row?.Abstract || ''),
    categories: Array.isArray(row?.Category) ? row.Category.map(String) : [],
    tags: Array.isArray(row?.Tags) ? row.Tags.map(String) : [],
    stars: Number(row?.Stars) || 0,
    hot: Number(row?.CallVolume) || 0,
    featured: row?.Hosted === true,
    hosted: row?.Hosted === true,
    url: owner ? `${MS_HOME}/mcp/servers/${owner}/${name}` : MS_HOME,
    icon: absolute(MS_HOME, row?.FromSiteIcon) || '',
    readme: String(row?.Readme || row?.OriginalReadme || ''),
    envSchema: row?.EnvSchema ?? null,
    tools: Array.isArray(row?.Tools) ? row.Tools.map((tool) => String(tool?.Name ?? tool)) : [],
    formats,
  }
}

/**
 * The square API ignores every search/category parameter except an exact Name
 * (verified: Category/Keyword/Search/Q are ignored, Name=<exact> filters), so
 * filtering has to happen locally after paging.
 */
export async function msSearch({ query = '', category = '', page = 1, pageSize = 50 } = {}) {
  const params = new URLSearchParams({ PageNumber: '1', PageSize: String(pageSize) })
  const data = await getJson(`${MS_API}?${params.toString()}`)
  const rows = data?.Data?.Result?.McpServers
  if (!Array.isArray(rows)) throw new Error('魔搭返回结构不认识：缺少 Data.Result.McpServers')
  let items = rows.map(normalizeMsRow)
  const total = Number(data?.Data?.Result?.TotalCount) || items.length
  if (category) items = items.filter((item) => item.categories.includes(category))
  if (query) {
    const needle = query.trim().toLowerCase()
    if (needle) {
      items = items.filter((item) => [item.name, item.title, item.subtitle, item.description, ...item.tags, ...item.categories]
        .some((field) => String(field || '').toLowerCase().includes(needle)))
    }
  }
  return { source: 'modelscope', items, total, page: 1, pageCount: 1 }
}

export async function msCategories() {
  const { items } = await msSearch({ pageSize: 100 })
  const counts = new Map()
  for (const item of items) {
    for (const category of item.categories) counts.set(category, (counts.get(category) || 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ source: 'modelscope', id: name, name, count }))
}

export async function msDetail(id) {
  const { items } = await msSearch({ pageSize: 100 })
  const found = items.find((item) => item.id === String(id) || item.name === String(id))
  if (!found) throw new Error(`魔搭 MCP 列表里没有 ${id}`)
  return found
}

/* ── unified entry points ───────────────────────────────────────────── */

const IMPLEMENTATIONS = {
  mcpmarket: { search: mcmSearch, detail: mcmDetail, categories: mcmCategories },
  modelscope: { search: msSearch, detail: msDetail, categories: msCategories },
}

export function normalizeSource(source) {
  const value = String(source || 'all').toLowerCase()
  return value === 'mcpmarket' || value === 'modelscope' ? value : 'all'
}

/** Search one source or both; a failing source never sinks the other one. */
export async function search({ source = 'all', query = '', category = '', page = 1 } = {}) {
  const wanted = normalizeSource(source)
  const ids = wanted === 'all' ? Object.keys(IMPLEMENTATIONS) : [wanted]
  const settled = await Promise.all(ids.map(async (id) => {
    try {
      return { id, ...(await IMPLEMENTATIONS[id].search({ query, category, page })) }
    } catch (error) {
      return { id, items: [], total: 0, page, pageCount: 1, error: String(error?.message || error) }
    }
  }))
  const items = settled.flatMap((result) => result.items)
  return {
    items,
    total: settled.reduce((sum, result) => sum + result.total, 0),
    page,
    perSource: settled.map(({ id, total, error }) => ({ id, total, error })),
  }
}

export async function categories({ source = 'all' } = {}) {
  const wanted = normalizeSource(source)
  const ids = wanted === 'all' ? Object.keys(IMPLEMENTATIONS) : [wanted]
  const settled = await Promise.all(ids.map(async (id) => {
    try {
      return await IMPLEMENTATIONS[id].categories()
    } catch {
      return []
    }
  }))
  return settled.flat()
}

export async function detail({ source, id }) {
  const wanted = normalizeSource(source)
  const implementation = IMPLEMENTATIONS[wanted]
  if (!implementation) throw new Error(`未知来源：${source}`)
  return implementation.detail(id)
}
