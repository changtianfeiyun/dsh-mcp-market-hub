// dsh-mcp-market-hub — host half.
//
// Two surfaces:
//   /dsh-mcp-market-hub/api   panel API (search / detail / preview / install)
//   tools                     mcp_market_search | mcp_market_detail | mcp_market_install | mcp_market_installed
//
// Both markets are public JSON APIs, so this plugin only aggregates and normalizes
// them; nothing is cached on disk and no credentials are involved.

import { SOURCES, categories as loadCategories, detail as loadDetail, search as runSearch } from './market.js'
import { buildImportJson, connectionsFile, installConnection, listConnections, pickFormat } from './install.js'
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
          const format = pickFormat(item)
          json(res, 200, { ok: true, item, format, importJson: format ? buildImportJson(item, format) : null })
          return
        }
        if (op === 'installed') {
          const result = await listConnections()
          json(res, 200, { ok: true, file: result.file, items: result.items })
          return
        }
        const result = await runSearch({
          source: url.searchParams.get('source') || 'all',
          query: url.searchParams.get('q') || '',
          category: url.searchParams.get('category') || '',
          page: Number(url.searchParams.get('page') || 1) || 1,
        })
        json(res, 200, { ok: true, items: result.items, total: result.total, page: result.page, perSource: result.perSource })
        return
      }
      if (req.method === 'POST') {
        const body = await readBody(req)
        if (body.op === 'install') {
          const item = body.item || await loadDetail({ source: body.source, id: body.id })
          const format = pickFormat(item, body.serverKey)
          if (body.previewOnly) {
            json(res, 200, { ok: true, preview: true, format, importJson: buildImportJson(item, format) })
            return
          }
          const result = await installConnection(item, { serverKey: body.serverKey, format: format || undefined })
          json(res, 200, { ok: true, key: result.key, record: result.record, importJson: result.importJson, file: result.file, note: result.note })
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
      const format = pickFormat(item)
      const out = [summarize(item)]
      if (item.overview) out.push('', String(item.overview).slice(0, 1200))
      if (item.readme) out.push('', String(item.readme).replace(/\s+/g, ' ').slice(0, 1200))
      if (format) out.push('', '可直接导入 DSH 的配置：', JSON.stringify(buildImportJson(item, format), null, 2))
      return { ok: true, text: out.join('\n').trim() }
    },
  })

  tool({
    name: 'mcp_market_install',
    description: '把一个 MCP 市场条目装进 DSH 连接器：写入 ~/.dsh/storages/mcp_connector.json 的连接记录（重载插件后生效）。apply=false 时只返回将要写入的配置。',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['mcpmarket', 'modelscope'], description: '来源' },
        id: { type: 'string', description: '条目 id' },
        serverKey: { type: 'string', description: '多配置时指定 serverKey（可选）' },
        apply: { type: 'boolean', description: 'true 才真正写入；默认 false 只预览' },
      },
      required: ['source', 'id'],
      additionalProperties: false,
    },
    output: toolOutput,
    async execute(args) {
      const item = await loadDetail({ source: args.source, id: args.id })
      const format = pickFormat(item, args.serverKey)
      if (!args.apply) {
        return {
          ok: true,
          text: [summarize(item), '', '将写入的连接配置：',
            JSON.stringify(format ? buildImportJson(item, format) : null, null, 2),
            '', '确认后带 apply=true 再调用一次即写入。'].join('\n'),
        }
      }
      const result = await installConnection(item, { serverKey: args.serverKey })
      return {
        ok: true,
        text: ['已写入 ' + result.key, '文件: ' + result.file, '配置: ' + JSON.stringify(result.importJson), result.note].join('\n'),
      }
    },
  })

  tool({
    name: 'mcp_market_installed',
    description: '列出本机 DSH 连接器里已有的 MCP 连接（名称、传输方式、地址/命令），用于确认市场安装是否生效。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: toolOutput,
    async execute() {
      const result = await listConnections()
      const out = ['连接文件: ' + connectionsFile(), '已有连接 ' + result.items.length + ' 个']
      for (const row of result.items) {
        out.push('  · ' + row.name + '  [' + row.transport + ']  ' + row.endpoint + (row.enabled ? '' : '（已停用）'))
      }
      return { ok: true, text: out.join('\n') }
    },
  })
}
