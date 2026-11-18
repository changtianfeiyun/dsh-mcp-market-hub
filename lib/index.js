// dsh-mcp-market-hub — host half.
//
// Two surfaces:
//   /dsh-mcp-market-hub/api   panel API (search / detail / preview / install)
//   tools                     mcp_market_search | mcp_market_detail | mcp_market_install | mcp_market_installed | mcp_market_uninstall
//
// Both markets are public JSON APIs, so this plugin only aggregates and normalizes
// them; nothing is cached on disk and no credentials are involved.
//
// Installation targets DSH's built-in MCP manager (ctx.mcpManager) through a soft
// `ctx.inject`, so a host that ships mcp-manager gets live servers with no
// restart and no third-party plugin. Hosts without it fall back to writing the
// optional dsh-mcp-connector file.

import { SOURCES, categories as loadCategories, detail as loadDetail, search as runSearch } from './market.js'
import {
  TARGETS,
  buildImportJson,
  describeInstall,
  forgetEntry,
  installConnection,
  listConnections,
  pickFormat,
  readStore,
  storeEntry,
} from './install.js'
import { mountUi } from './ui.js'

export const name = 'dsh-mcp-market-hub'
export const inject = ['webServer', 'tools']

const ROUTE = '/dsh-mcp-market-hub/api'
const MAX_BODY_BYTES = 1024 * 1024

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

function localOnly(req) {
  const host = String(req.headers.host || '')
  const hostname = host.replace(/:\d+$/, '')
  const local = hostname === 'localhost' || hostname === '[::1]' || /^127\./.test(hostname)
  if (!local) return false
  if (String(req.headers['sec-fetch-site'] || '') === 'cross-site') return false
  const origin = req.headers.origin
  if (origin) {
    try {
      if (new URL(origin).host !== host) return false
    } catch {
      return false
    }
  }
  return true
}

async function readBody(req) {
  const declared = Number(req.headers['content-length'] || 0)
  if (declared > MAX_BODY_BYTES) throw new Error('请求体过大')
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  return JSON.parse(text)
}

function describeFormat(format) {
  if (!format) return '（市场没有提供可用的连接配置）'
  if (format.transport === 'stdio') {
    const args = Array.isArray(format.args) && format.args.length ? ' ' + format.args.join(' ') : ''
    return 'stdio: ' + format.command + args
  }
  return (format.transport === 'sse' ? 'sse: ' : 'streamable-http: ') + format.url
}

function summarize(item) {
  const formats = Array.isArray(item.formats) ? item.formats : []
  const out = []
  const shown = item.subtitle && item.subtitle !== item.title ? ' (' + item.subtitle + ')' : ''
  out.push((item.title || item.name) + shown)
  out.push('  来源: ' + (item.source === 'modelscope' ? '魔搭 ModelScope' : 'MCP Market')
    + '  ·  作者: ' + (item.author || '未知') + (item.hosted ? '  ·  托管' : ''))
  out.push('  ★ ' + (item.stars || 0) + '  ·  热度 ' + (item.hot || 0)
    + (Array.isArray(item.categories) && item.categories.length ? '  ·  ' + item.categories.join(' / ') : ''))
  if (item.description) out.push('  ' + String(item.description).replace(/\s+/g, ' ').slice(0, 220))
  out.push('  连接配置: ' + (formats.length ? formats.map(describeFormat).join(' | ') : '无'))
  if (item.url) out.push('  详情页: ' + item.url)
  return out.join('\n')
}

export function apply(ctx) {
  // Live view of what we registered with DSH's own MCP manager.
  const runtime = {
    service: null,
    disposers: new Map(),
    failures: [],
    error: '',
  }

  const target = () => (runtime.service ? TARGETS.manager : TARGETS.connector)

  const registerLive = (serverKey, entry) => {
    if (!runtime.service) throw new Error('当前 DSH 没有提供 mcpManager 服务，无法实时注册。')
    const previous = runtime.disposers.get(serverKey)
    if (previous) {
      try {
        previous()
      } catch {
        // A failed withdrawal must not block the new registration.
      }
      runtime.disposers.delete(serverKey)
    }
    const dispose = runtime.service.register(serverKey, entry)
    runtime.disposers.set(serverKey, dispose)
    return dispose
  }

  const replay = async () => {
    runtime.failures = []
    let document
    try {
      ({ document } = await readStore())
    } catch (error) {
      runtime.error = '读取安装记录失败：' + String(error?.message || error)
      return
    }
    for (const [serverKey, raw] of Object.entries(document.servers)) {
      if (!raw || raw.enabled === false || !raw.entry) continue
      try {
        registerLive(serverKey, raw.entry)
      } catch (error) {
        runtime.failures.push({ name: serverKey, reason: String(error?.message || error) })
      }
    }
  }

  ctx.inject(['mcpManager'], (mctx) => {
    runtime.service = mctx.mcpManager
    mctx.effect(() => () => {
      for (const dispose of runtime.disposers.values()) {
        try {
          dispose()
        } catch {
          // Nothing to do: the manager is going away anyway.
        }
      }
      runtime.disposers.clear()
      runtime.service = null
    })
    void replay()
  })

  const handler = async (req, res) => {
    if (!localOnly(req)) {
      json(res, 403, { ok: false, error: '只接受本机同源请求' })
      return
    }
    try {
      const url = new URL(String(req.url || ''), 'http://localhost')
      if (req.method === 'GET') {
        const op = url.searchParams.get('op') || 'search'
        if (op === 'sources') {
          json(res, 200, { ok: true, sources: SOURCES })
          return
        }
        if (op === 'categories') {
          const items = await loadCategories({ source: url.searchParams.get('source') || 'all' })
          json(res, 200, { ok: true, items })
          return
        }
        if (op === 'detail') {
          const source = url.searchParams.get('source') || 'mcpmarket'
          const id = url.searchParams.get('id') || ''
          const item = await loadDetail({ source, id })
          // An entry that cannot be installed still has a readable detail page.
          const plan = describeInstall(item, pickFormat(item, undefined, target()), target())
          json(res, 200, {
            ok: true,
            item,
            format: plan.format,
            importJson: plan.importJson,
            installable: plan.ok,
            installError: plan.reason,
            target: plan.target,
          })
          return
        }
        if (op === 'installed') {
          const result = await listConnections()
          const live = runtime.service
            ? runtime.service.list()
              .filter((row) => runtime.disposers.has(row.name))
              .map((row) => ({ name: row.name, state: String(row.status?.state || '') }))
            : []
          json(res, 200, {
            ok: true,
            target: target(),
            managerAvailable: Boolean(runtime.service),
            file: result.file,
            legacyFile: result.legacyFile,
            items: result.items,
            legacyItems: result.legacyItems,
            live,
            failures: runtime.failures,
            error: runtime.error,
          })
          return
        }
        const result = await runSearch({
          source: url.searchParams.get('source') || 'all',
          query: url.searchParams.get('q') || '',
          category: url.searchParams.get('category') || '',
          page: Number(url.searchParams.get('page') || 1) || 1,
        })
        json(res, 200, {
          ok: true,
          items: result.items,
          total: result.total,
          page: result.page,
          pageCount: result.pageCount,
          perSource: result.perSource,
        })
        return
      }
      if (req.method === 'POST') {
        const body = await readBody(req)
        if (body.op === 'install') {
          const item = body.item || await loadDetail({ source: body.source, id: body.id })
          const active = target()
          const format = pickFormat(item, body.serverKey, active)
          if (body.previewOnly) {
            const plan = describeInstall(item, format, active)
            json(res, 200, {
              ok: true,
              preview: true,
              target: plan.target,
              format: plan.format,
              importJson: plan.importJson,
              installable: plan.ok,
              installError: plan.reason,
            })
            return
          }
          if (active === TARGETS.manager) {
            const stored = await storeEntry(item, { serverKey: body.serverKey, format })
            let live = true
            let note = '已注册到 DSH 的 MCP 管理器，工具会立刻出现在会话里。'
            try {
              registerLive(stored.name, stored.entry)
            } catch (error) {
              live = false
              note = '已写入安装记录，但实时注册失败：' + String(error?.message || error) + '。重启 DSH 后会再次尝试。'
            }
            json(res, 200, {
              ok: true,
              target: TARGETS.manager,
              name: stored.name,
              entry: stored.entry,
              file: stored.file,
              live,
              importJson: buildImportJson(item, format),
              note,
            })
            return
          }
          const result = await installConnectionFallback(item, body, format)
          json(res, 200, result)
          return
        }
        if (body.op === 'uninstall') {
          const serverKey = String(body.name || '')
          const dispose = runtime.disposers.get(serverKey)
          if (dispose) {
            try {
              dispose()
            } catch {
              // Already gone.
            }
            runtime.disposers.delete(serverKey)
          }
          const result = await forgetEntry(serverKey)
          json(res, 200, { ok: true, name: serverKey, removed: result.ok, reason: result.reason || '' })
          return
        }
        json(res, 400, { ok: false, error: '未知操作：' + String(body.op) })
        return
      }
      json(res, 405, { ok: false, error: '只支持 GET / POST' })
    } catch (error) {
      json(res, 500, { ok: false, error: String((error && error.message) || error) })
    }
  }

  async function installConnectionFallback(item, body, format) {
    const result = await installConnection(item, { serverKey: body.serverKey, format: format || undefined })
    return {
      ok: true,
      target: TARGETS.connector,
      key: result.key,
      record: result.record,
      importJson: result.importJson,
      file: result.file,
      live: false,
      note: result.note,
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE, handler }))
  // 面板文档：ui/index.html（分类栏 + 卡片网格 + 安装抽屉）
  ctx.effect(() => mountUi(ctx))

  const toolOutput = {
    schema: {
      type: 'object',
      properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
      required: ['ok', 'text'],
      additionalProperties: false,
    },
    render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }],
  }
  const tool = (definition) => ctx.effect(() => ctx.tools.register(definition))

  tool({
    name: 'mcp_market_search',
    description: '在 MCP 市场里搜索可安装的 MCP 服务：聚合 https://mcpmarket.cn 与魔搭 ModelScope MCP 广场，返回名称、作者、星数、分类与连接配置。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，如 github / 数据库 / 浏览器' },
        source: { type: 'string', enum: ['all', 'mcpmarket', 'modelscope'], description: '来源，默认 all' },
        category: { type: 'string', description: '分类名' },
        page: { type: 'number', description: '页码，默认 1' },
      },
      additionalProperties: false,
    },
    output: toolOutput,
    async execute(args) {
      const result = await runSearch({ source: args.source, query: args.query, category: args.category, page: args.page })
      const out = ['共 ' + result.items.length + ' 条（各来源合计 ' + result.total + '）']
      for (const row of result.perSource || []) {
        out.push('  · ' + row.id + ': ' + row.total + ' 条' + (row.error ? '（失败：' + row.error + '）' : ''))
      }
      out.push('')
      for (const item of result.items.slice(0, 12)) { out.push(summarize(item)); out.push('') }
      if (result.items.length > 12) out.push('（还有 ' + (result.items.length - 12) + ' 条，缩小关键词或翻页查看）')
      return { ok: true, text: out.join('\n').trim() }
    },
  })

  tool({
    name: 'mcp_market_detail',
    description: '读取 MCP 市场里某个条目的完整信息（描述、分类、可用连接配置、可直接导入的 mcpServers JSON）。',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['mcpmarket', 'modelscope'], description: '来源' },
        id: { type: 'string', description: '条目 id' },
      },
      required: ['source', 'id'],
      additionalProperties: false,
    },
    output: toolOutput,
    async execute(args) {
      const item = await loadDetail({ source: args.source, id: args.id })
      const plan = describeInstall(item, pickFormat(item, undefined, target()), target())
      const out = [summarize(item)]
      if (item.overview) out.push('', String(item.overview).slice(0, 1200))
      if (item.readme) out.push('', String(item.readme).replace(/\s+/g, ' ').slice(0, 1200))
      if (plan.importJson) out.push('', '可直接导入 DSH 的配置：', JSON.stringify(plan.importJson, null, 2))
      else out.push('', '无法直接安装：' + plan.reason)
      return { ok: true, text: out.join('\n').trim() }
    },
  })

  tool({
    name: 'mcp_market_install',
    description: '把一个 MCP 市场条目装进当前 DSH：宿主带内置 MCP 管理器时实时注册（无需重启），否则回退写入 dsh-mcp-connector 的连接文件。apply=false 只预览。',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['mcpmarket', 'modelscope'], description: '来源' },
        id: { type: 'string', description: '条目 id' },
        serverKey: { type: 'string', description: '多配置时指定 serverKey（可选）' },
        apply: { type: 'boolean', description: 'true 才真正安装；默认 false 只预览' },
      },
      required: ['source', 'id'],
      additionalProperties: false,
    },
    output: toolOutput,
    async execute(args) {
      const item = await loadDetail({ source: args.source, id: args.id })
      const active = target()
      const format = pickFormat(item, args.serverKey, active)
      if (!args.apply) {
        const plan = describeInstall(item, format, active)
        return {
          ok: true,
          text: [summarize(item), '', '将写入的连接配置：',
            plan.importJson ? JSON.stringify(plan.importJson, null, 2) : '（无）',
            plan.ok ? '' : '⚠ ' + plan.reason,
            plan.ok ? '确认后带 apply=true 再调用一次即安装。' : '这个条目当前无法接入。'].join('\n'),
        }
      }
      if (active === TARGETS.manager) {
        const stored = await storeEntry(item, { serverKey: args.serverKey, format })
        let note = '已实时注册，工具应立刻可用。'
        try {
          registerLive(stored.name, stored.entry)
        } catch (error) {
          note = '安装记录已写入，但实时注册失败：' + String(error?.message || error)
        }
        return {
          ok: true,
          text: ['已安装 ' + stored.name, '记录文件: ' + stored.file,
            '配置: ' + JSON.stringify(stored.entry), note].join('\n'),
        }
      }
      const result = await installConnectionFallback(item, { serverKey: args.serverKey }, format)
      return {
        ok: true,
        text: ['已写入 ' + result.key, '文件: ' + result.file,
          '配置: ' + JSON.stringify(result.importJson), result.note].join('\n'),
      }
    },
  })

  tool({
    name: 'mcp_market_installed',
    description: '列出本机已安装的 MCP 服务（DSH 内置管理器里的实时注册，以及 dsh-mcp-connector 的旧记录），用于确认市场安装是否生效。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: toolOutput,
    async execute() {
      const result = await listConnections()
      const live = runtime.service
        ? runtime.service.list().filter((row) => runtime.disposers.has(row.name))
        : []
      const out = [
        '当前安装目标: ' + (runtime.service ? 'DSH 内置 MCP 管理器（实时）' : 'dsh-mcp-connector 文件（回退）'),
        '安装记录: ' + result.file + '  （' + result.items.length + ' 个）',
      ]
      for (const row of result.items) {
        const state = live.find((entry) => entry.name === row.serverName)
        out.push('  · ' + row.name + '  [' + row.transport + ']  ' + row.endpoint
          + (row.enabled ? '' : '（已停用）') + (state ? '  → ' + String(state.status?.state || '已注册') : ''))
      }
      if (result.legacyItems.length) {
        out.push('dsh-mcp-connector 记录: ' + result.legacyFile + '  （' + result.legacyItems.length + ' 个）')
        for (const row of result.legacyItems) out.push('  · ' + row.name + '  [' + row.transport + ']  ' + row.endpoint)
      }
      for (const failure of runtime.failures) out.push('⚠ ' + failure.name + ' 注册失败：' + failure.reason)
      return { ok: true, text: out.join('\n') }
    },
  })

  tool({
    name: 'mcp_market_uninstall',
    description: '卸载一个由 MCP 市场安装的 MCP 服务：撤回实时注册并删除安装记录。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '安装时得到的服务名（mcp_market_installed 可查）' } },
      required: ['name'],
      additionalProperties: false,
    },
    output: toolOutput,
    async execute(args) {
      const serverKey = String(args.name || '')
      const dispose = runtime.disposers.get(serverKey)
      if (dispose) {
        try {
          dispose()
        } catch {
          // Already withdrawn.
        }
        runtime.disposers.delete(serverKey)
      }
      const result = await forgetEntry(serverKey)
      return {
        ok: true,
        text: (result.ok ? '已卸载 ' + serverKey : '没有这条安装记录：' + serverKey)
          + (dispose ? '（实时注册已撤回）' : ''),
      }
    },
  })
}
