// dsh-mcp-market-hub — panel logic (no build step, no framework).
// Talks to /dsh-mcp-market-hub/api on the same origin; the host route serves this
// document, the API route answers the market queries and the install writes.
(function () {
  'use strict'

  var API = '/dsh-mcp-market-hub/api'
  var SOURCE_LABEL = { mcpmarket: 'MCP Market', modelscope: '魔搭' }
  var MS_LABEL = {
    'search': '搜索',
    'knowledge-and-memory': '知识与记忆',
    'developer-tools': '开发工具',
    'browser-automation': '浏览器自动化',
    'communication': '通信',
    'finance': '金融',
    'entertainment-and-media': '娱乐媒体',
    'art-and-culture': '艺术文化',
    'productivity': '办公效率',
    'data': '数据',
  }
  var WEB_TARGETS = {
    mcpmarket: { url: 'https://mcpmarket.cn/', title: 'MCP Market' },
    modelscope: { url: 'https://www.modelscope.cn/mcp?category=search&page=1', title: '魔搭 MCP 广场' },
  }

  var state = {
    source: 'all',
    category: '',
    q: '',
    page: 1,
    view: 'market',
    categories: [],
    categoriesError: '',
    items: [],
    total: 0,
    pageCount: 1,
    loading: false,
    error: '',
    installed: null,
    installedFile: '',
    legacyFile: '',
    target: '',
    managerAvailable: false,
    web: 'mcpmarket',
    detail: null,
  }

  var $ = function (id) { return document.getElementById(id) }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  function paramString(base, extra) {
    var params = new URLSearchParams()
    for (var key in base) if (base[key] !== '' && base[key] != null) params.set(key, base[key])
    for (var k in (extra || {})) if (extra[k] !== '' && extra[k] != null) params.set(k, extra[k])
    return params.toString()
  }

  function get(op, extra) {
    return fetch(API + '?' + paramString({ op: op }, extra), { headers: { accept: 'application/json' } })
      .then(readJson)
  }

  function post(body) {
    return fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(readJson)
  }

  function readJson(response) {
    return response.json().then(function (payload) {
      if (payload && payload.ok === false) throw new Error(payload.error || '请求失败')
      return payload
    })
  }

  var toastTimer = 0
  function toast(text, isError) {
    var node = $('toast')
    node.textContent = text
    node.className = 'toast' + (isError ? ' err' : '')
    node.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(function () { node.hidden = true }, isError ? 6000 : 3200)
  }

  /* ── rail ─────────────────────────────────────────────────────────── */

  function railRow(label, count, active, attrs) {
    return '<div class="rail-item' + (active ? ' on' : '') + '" ' + attrs + '>' +
      '<span>' + esc(label) + '</span>' +
      (count == null ? '' : '<span class="rail-count">' + esc(count) + '</span>') +
      '</div>'
  }

  function renderRail() {
    var seen = state.categories.filter(function (row) { return row.source === 'mcpmarket' })
    var ms = state.categories.filter(function (row) { return row.source === 'modelscope' })
    var out = []
    out.push('<div class="rail-group">总览</div>')
    out.push(railRow('全部 MCP', null, state.view === 'market' && !state.category, 'data-act="all"'))
    out.push(railRow('已安装到 DSH', null, state.view === 'installed', 'data-act="installed"'))
    out.push(railRow('内嵌市场网页', null, state.view === 'web', 'data-act="web"'))
    if (seen.length) {
      out.push('<div class="rail-group">MCP Market</div>')
      seen.forEach(function (row) {
        var on = state.category === row.id && state.source !== 'modelscope' && state.view === 'market'
        out.push(railRow(row.name, row.count, on, 'data-act="cat" data-source="mcpmarket" data-id="' + esc(row.id) + '"'))
      })
    }
    if (ms.length) {
      out.push('<div class="rail-group">魔搭 ModelScope</div>')
      ms.forEach(function (row) {
        var on = state.category === row.id && state.source === 'modelscope' && state.view === 'market'
        var label = MS_LABEL[row.id] || row.id
        out.push(railRow(label + ' · ' + row.id, row.count, on, 'data-act="cat" data-source="modelscope" data-id="' + esc(row.id) + '"'))
      })
    }
    if (!seen.length && !ms.length) {
      out.push('<div class="rail-group">分类</div>')
      out.push('<div class="hint" style="padding:6px 9px">' + esc(state.categoriesError || '分类加载中…') + '</div>')
    }
    $('rail').innerHTML = out.join('')
  }

  /* ── cards ────────────────────────────────────────────────────────── */

  function initialOf(item) {
    var text = String(item.title || item.name || '?')
    return text.slice(0, 1).toUpperCase()
  }

  function subOf(item) {
    var title = String(item.title || item.name || '')
    if (item.subtitle && item.subtitle !== title) return item.subtitle
    if (item.name && item.name !== title) return item.name
    return ''
  }

  function cardMarkup(item, index) {
    var logo = item.icon
      ? '<img src="' + esc(item.icon) + '" alt="" loading="lazy" onerror="this.remove()">'
      : esc(initialOf(item))
    var chips = (item.categories || []).slice(0, 3).map(function (c) {
      return '<span class="chip">' + esc(MS_LABEL[c] || c) + '</span>'
    }).join('')
    return '<div class="card" data-act="detail" data-source="' + esc(item.source) + '" data-id="' + esc(item.id) + '">' +
      '<div class="logo">' + logo + '</div>' +
      '<div class="card-body">' +
        '<div class="card-title">' + esc(item.title || item.name) + '</div>' +
        '<div class="card-sub">' + esc(subOf(item)) + (item.author ? ' · ' + esc(item.author) : '') + '</div>' +
        '<div class="card-meta">' +
          '<span class="src ' + esc(item.source) + '">' + esc(SOURCE_LABEL[item.source] || item.source) + '</span>' +
          '<span>★ ' + esc(item.stars || 0) + '</span>' +
          (item.hosted ? '<span>托管</span>' : '') +
        '</div>' +
        (chips ? '<div class="chips">' + chips + '</div>' : '') +
      '</div>' +
      '<div class="card-actions"><button class="btn-sm" type="button" data-act="detail" data-source="' + esc(item.source) + '" data-id="' + esc(item.id) + '">安装</button></div>' +
    '</div>'
  }

  function renderMarket() {
    if (state.loading) { $('main').innerHTML = '<div class="empty">正在查询两个市场…</div>'; return }
    if (state.error) { $('main').innerHTML = '<div class="empty">' + esc(state.error) + '</div>'; return }
    if (!state.items.length) {
      $('main').innerHTML = '<div class="empty">这个分类下没有条目。换个分类，或在上方搜索。</div>'
      return
    }
    var head = '<div class="hint" style="margin-bottom:10px">' +
      esc(state.category ? '分类：' + (MS_LABEL[state.category] || state.category) : (state.q ? '搜索：' + state.q : '全部 MCP')) +
      ' · ' + esc(state.items.length) + ' / ' + esc(state.total) + ' 条 · 第 ' + esc(state.page) + ' / ' +
      esc(Math.max(1, Number(state.pageCount) || 1)) + ' 页' +
      '</div>'
    var grid = '<div class="grid">' + state.items.map(cardMarkup).join('') + '</div>'
    var last = Math.max(1, Number(state.pageCount) || 1)
    var pager = '<div class="pager">' +
      '<button type="button" data-act="prev"' + (state.page <= 1 ? ' disabled' : '') + '>上一页</button>' +
      '<span class="pager-num">' + esc(state.page) + ' / ' + esc(last) + '</span>' +
      '<button type="button" data-act="next"' + (state.page >= last ? ' disabled' : '') + '>下一页</button>' +
      '</div>'
    $('main').innerHTML = head + grid + pager
  }

  function installedCard(row, removable) {
    var stateText = row.liveState ? '运行中' : (row.enabled ? '已记录' : '已停用')
    return '<div class="card" style="cursor:default">' +
      '<div class="logo">' + esc(String(row.name || '?').slice(0, 1).toUpperCase()) + '</div>' +
      '<div class="card-body">' +
        '<div class="card-title">' + esc(row.name) + '</div>' +
        '<div class="card-sub">' + esc(row.endpoint || '—') + '</div>' +
        '<div class="card-meta"><span class="chip">' + esc(row.transport || '—') + '</span>' +
        '<span class="chip">' + esc(stateText) + '</span>' +
        (row.via ? '<span class="chip">' + esc(row.via) + '</span>' : '') + '</div>' +
      '</div>' +
      (removable ? '<div class="card-actions"><button class="btn-sm" type="button" data-act="uninstall" data-name="' + esc(row.serverName || row.key) + '">卸载</button></div>' : '') +
      '</div>'
  }

  function renderInstalled() {
    if (!state.installed) { $('main').innerHTML = '<div class="empty">正在读取安装记录…</div>'; return }
    var payload = state.installed
    var rows = (payload.items || []).map(function (row) {
      var live = (payload.live || []).filter(function (entry) { return entry.name === row.serverName })[0]
      var copy = {}
      for (var k in row) copy[k] = row[k]
      copy.liveState = live ? String(live.state || 'connected') : ''
      return copy
    })
    var legacy = payload.legacyItems || []
    var target = payload.target === 'mcp-manager'
      ? 'DSH 内置 MCP 管理器（实时生效）'
      : 'dsh-mcp-connector 连接文件（需要重载插件）'
    var head = '<div class="hint" style="margin-bottom:10px">安装目标：' + esc(target) +
      ' · 记录文件 <code>' + esc(payload.file || '') + '</code> · 共 ' + rows.length + ' 条</div>'
    var failures = (payload.failures || []).map(function (row) {
      return '<div class="hint" style="margin-bottom:6px">⚠ ' + esc(row.name) + ' 注册失败：' + esc(row.reason) + '</div>'
    }).join('')
    if (payload.error) failures += '<div class="hint" style="margin-bottom:6px">⚠ ' + esc(payload.error) + '</div>'
    var body = rows.length
      ? '<div class="grid">' + rows.map(function (row) { return installedCard(row, true) }).join('') + '</div>'
      : '<div class="empty">还没有从市场装过任何 MCP。左侧挑个分类，点卡片上的「安装」。</div>'
    var legacyHtml = ''
    if (legacy.length) {
      legacyHtml = '<div class="section-title" style="margin-top:18px">dsh-mcp-connector 里的旧记录</div>' +
        '<div class="hint" style="margin-bottom:10px">这些是别的插件写入的，本页只读取：<code>' + esc(payload.legacyFile || '') + '</code></div>' +
        '<div class="grid">' + legacy.map(function (row) { return installedCard(row, false) }).join('') + '</div>'
    }
    $('main').innerHTML = head + failures + body + legacyHtml
  }

  function renderWeb() {
    var target = WEB_TARGETS[state.web]
    var tabs = Object.keys(WEB_TARGETS).map(function (key) {
      return '<button type="button" class="btn-sm' + (key === state.web ? ' on' : '') + '" data-act="webtab" data-key="' + key + '">' + esc(WEB_TARGETS[key].title) + '</button>'
    }).join(' ')
    var note = state.web === 'modelscope'
      ? '<div class="hint" style="padding:6px 0">魔搭页面设置了 X-Frame-Options: SAMEORIGIN，本站无法内嵌。点下方按钮在新窗口打开，或用左侧分类浏览。' +
        '<br><a href="' + esc(target.url) + '" target="_blank" rel="noreferrer" style="color:var(--brand)">在新窗口打开 ' + esc(target.title) + '</a></div>'
      : ''
    var frame = state.web === 'modelscope' ? '' :
      '<iframe src="' + esc(target.url) + '" referrerpolicy="no-referrer" title="' + esc(target.title) + '"></iframe>'
    $('main').innerHTML = '<div class="web"><div style="display:flex;gap:6px;align-items:center;padding-bottom:8px">' +
      tabs + '</div>' + note + frame + '</div>'
  }

  function render() {
    renderRail()
    if (state.view === 'installed') renderInstalled()
    else if (state.view === 'web') renderWeb()
    else renderMarket()
  }

  /* ── data ─────────────────────────────────────────────────────────── */

  function loadCategories() {
    return get('categories', { source: 'all' }).then(function (payload) {
      state.categories = payload.items || []
      state.categoriesError = state.categories.length ? '' : '两个市场都没有返回分类'
    }).catch(function (error) {
      state.categories = []
      state.categoriesError = '分类加载失败：' + String(error.message || error)
    }).then(render)
  }

  function loadItems() {
    state.loading = true
    state.error = ''
    render()
    return get('search', {
      source: state.source,
      q: state.q,
      category: state.category,
      page: state.page,
    }).then(function (payload) {
      state.items = payload.items || []
      state.total = payload.total || state.items.length
      state.pageCount = Math.max(1, Number(payload.pageCount) || 1)
    }).catch(function (error) {
      state.items = []
      state.total = 0
      state.pageCount = 1
      state.error = '查询失败：' + String(error.message || error)
    }).then(function () {
      state.loading = false
      render()
    })
  }

  function absorbInstalled(payload) {
    state.installedFile = String(payload.file || '')
    state.legacyFile = String(payload.legacyFile || '')
    state.target = String(payload.target || '')
    state.managerAvailable = Boolean(payload.managerAvailable)
  }

  function loadInstalledFile() {
    return get('installed').then(absorbInstalled)
      .catch(function () { /* the drawer falls back to the default path */ })
  }

  function loadInstalled() {
    state.view = 'installed'
    state.installed = null
    render()
    return get('installed').then(function (payload) {
      absorbInstalled(payload)
      state.installed = payload
      render()
    }).catch(function (error) {
      state.installed = { file: '', items: [], legacyItems: [], live: [], failures: [] }
      render()
      toast(String(error.message || error), true)
    })
  }

  function chooseAll() {
    state.view = 'market'
    state.source = 'all'
    state.category = ''
    state.page = 1
    loadItems()
  }

  function chooseCategory(source, id) {
    state.view = 'market'
    state.source = source
    state.category = id
    state.page = 1
    loadItems()
  }

  /* ── detail ───────────────────────────────────────────────────────── */

  function fmtTitle(format) {
    if (!format) return '—'
    if (format.transport === 'stdio') {
      var args = Array.isArray(format.args) && format.args.length ? ' ' + format.args.join(' ') : ''
      return 'stdio · ' + format.command + args
    }
    return format.transport + ' · ' + format.url
  }

  function closeDetail() {
    state.detail = null
    $('modal').hidden = true
    $('modal').innerHTML = ''
  }

  function openDetail(source, id) {
    var modal = $('modal')
    modal.hidden = false
    modal.innerHTML = '<div class="drawer"><div class="drawer-body"><div class="empty">正在读取详情…</div></div></div>' +
      '<div style="flex:1" data-act="close"></div>'
    get('detail', { source: source, id: id }).then(function (payload) {
      state.detail = payload
      renderDetail()
    }).catch(function (error) {
      modal.innerHTML = '<div class="drawer"><div class="drawer-head"><h2>读取失败</h2></div>' +
        '<div class="drawer-body"><div class="desc">' + esc(String(error.message || error)) + '</div></div>' +
        '<div class="drawer-foot"><button class="btn" type="button" data-act="close">关闭</button></div></div>' +
        '<div style="flex:1" data-act="close"></div>'
    })
  }

  function renderDetail() {
    var payload = state.detail
    if (!payload) return
    var item = payload.item || {}
    var formats = item.formats || []
    var picked = payload.format || formats[0] || null
    var formatsHtml = formats.length
      ? formats.map(function (format, index) {
          var on = picked && (format.serverKey === picked.serverKey) && (format.transport === picked.transport)
          return '<label class="fmt' + (on ? ' on' : '') + '" data-act="pick" data-index="' + index + '">' +
            '<input type="radio" name="fmt" ' + (on ? 'checked' : '') + '>' +
            '<span style="flex:1"><b>' + esc(format.transport) + '</b> <code>' + esc(fmtTitle(format).replace(format.transport + ' · ', '')) + '</code></span>' +
            '</label>'
        }).join('')
      : '<div class="desc">市场没有给这个条目提供连接配置，只能去详情页手动配置。</div>'
    var json = payload.importJson ? '<div class="section-title">将写入 DSH 的配置</div><pre>' + esc(JSON.stringify(payload.importJson, null, 2)) + '</pre>' : ''
    var tags = (item.tags || []).slice(0, 8).map(function (t) { return '<span class="chip">' + esc(t) + '</span>' }).join('')
    $('modal').innerHTML = '<div class="drawer">' +
      '<div class="drawer-head">' +
        '<div class="logo">' + (item.icon ? '<img src="' + esc(item.icon) + '" alt="" onerror="this.remove()">' : esc(initialOf(item))) + '</div>' +
        '<div style="flex:1;min-width:0">' +
          '<h2>' + esc(item.title || item.name) + '</h2>' +
          '<div class="card-sub">' + esc(subOf(item)) + (item.author ? ' · ' + esc(item.author) : '') + '</div>' +
          '<div class="card-meta" style="margin-top:4px"><span class="src ' + esc(item.source) + '">' + esc(SOURCE_LABEL[item.source] || item.source) + '</span>' +
            '<span>★ ' + esc(item.stars || 0) + '</span>' + (item.url ? '<a href="' + esc(item.url) + '" target="_blank" rel="noreferrer" style="color:var(--brand)">详情页</a>' : '') + '</div>' +
          (tags ? '<div class="chips" style="margin-top:4px">' + tags + '</div>' : '') +
        '</div>' +
        '<button class="drawer-close" type="button" title="关闭" aria-label="关闭" data-act="close">✕</button>' +
      '</div>' +
      '<div class="drawer-body">' +
        '<div class="section-title">说明</div>' +
        '<div class="desc">' + esc(String(item.description || item.overview || item.readme || '（无描述）').slice(0, 1600)) + '</div>' +
        '<div class="section-title">安装方式</div>' + formatsHtml +
        json +
        '<div class="hint">' + installHint(payload) + '</div>' +
      '</div>' +
      '<div class="drawer-foot">' +
        '<button class="btn-primary" type="button" data-act="install"' + (picked && payload.installable !== false ? '' : ' disabled') + '>' + esc(installLabel()) + '</button>' +
        '<button class="btn" type="button" data-act="copyjson"' + (payload.importJson ? '' : ' disabled') + '>复制 JSON</button>' +
      '</div>' +
      '</div>' +
      '<div style="flex:1" data-act="close"></div>'
  }

  function pickFormat(index) {
    var payload = state.detail
    if (!payload) return
    var item = payload.item || {}
    var format = (item.formats || [])[index]
    if (!format) return
    post({ op: 'install', source: item.source, id: item.id, serverKey: format.serverKey, previewOnly: true })
      .then(function (next) {
        state.detail = {
          item: item,
          format: next.format || format,
          importJson: next.importJson || null,
          installable: next.installable !== false,
          installError: String(next.installError || ''),
        }
        renderDetail()
      })
      .catch(function (error) { toast(String(error.message || error), true) })
  }

  function installLabel() {
    return state.managerAvailable ? '安装到 DSH' : '写入连接文件'
  }

  function installHint(payload) {
    if (!payload.installable && payload.installError) return '这个条目装不进当前 DSH：' + esc(payload.installError)
    if (state.managerAvailable) {
      return 'DSH 内置的 MCP 管理器会立刻注册这条连接，装完即可在会话里调用它的工具，不用重启。' +
        '记录保存在 <code>' + esc(state.installedFile || '~/.dsh/storages/mcp_market_hub.json') + '</code>，下次启动会自动恢复。'
    }
    return '当前 DSH 没有内置 MCP 管理器，只能写入 dsh-mcp-connector 的连接文件 <code>' +
      esc(state.legacyFile || '~/.dsh/storages/mcp_connector.json') +
      '</code>；重载该插件（或重启 DSH）后连接才会生效。'
  }

  function runInstall() {
    var payload = state.detail
    if (!payload || !payload.format) return
    var item = payload.item || {}
    var button = $('modal').querySelector('[data-act="install"]')
    if (button) { button.disabled = true; button.textContent = '安装中…' }
    post({ op: 'install', source: item.source, id: item.id, serverKey: payload.format.serverKey })
      .then(function (result) {
        if (result.live) {
          toast('已注册到 DSH：' + String(result.name || '') + '，工具现在就能用。')
        } else {
          toast(String(result.note || ('已写入 ' + String(result.file || ''))))
        }
        closeDetail()
        state.installed = null
        loadInstalledFile()
      })
      .catch(function (error) {
        toast(String(error.message || error), true)
        if (button) { button.disabled = false; button.textContent = installLabel() }
      })
  }

  function runUninstall(name) {
    if (!name) return
    post({ op: 'uninstall', name: name })
      .then(function (result) {
        toast(result.removed ? ('已卸载 ' + name) : ('没有这条安装记录：' + name), !result.removed)
        loadInstalled()
      })
      .catch(function (error) { toast(String(error.message || error), true) })
  }

  /* ── events ───────────────────────────────────────────────────────── */

  document.addEventListener('click', function (event) {
    var node = event.target.closest('[data-act]')
    if (!node) return
    var act = node.getAttribute('data-act')
    if (act === 'close') { closeDetail(); return }
    if (act === 'all') { chooseAll(); return }
    if (act === 'installed') { loadInstalled(); return }
    if (act === 'web') { state.view = 'web'; render(); return }
    if (act === 'webtab') { state.web = node.getAttribute('data-key'); render(); return }
    if (act === 'cat') { chooseCategory(node.getAttribute('data-source'), node.getAttribute('data-id')); return }
    if (act === 'detail') { openDetail(node.getAttribute('data-source'), node.getAttribute('data-id')); return }
    if (act === 'pick') { pickFormat(Number(node.getAttribute('data-index'))); return }
    if (act === 'install') { runInstall(); return }
    if (act === 'uninstall') { runUninstall(node.getAttribute('data-name')); return }
    if (act === 'copyjson') {
      if (state.detail && state.detail.importJson) {
        navigator.clipboard.writeText(JSON.stringify(state.detail.importJson, null, 2))
          .then(function () { toast('配置 JSON 已复制') })
          .catch(function () { toast('复制失败', true) })
      }
      return
    }
    if (act === 'prev') { if (state.page > 1) { state.page -= 1; loadItems() } return }
    if (act === 'next') {
      if (state.page < Math.max(1, Number(state.pageCount) || 1)) { state.page += 1; loadItems() }
      return
    }
  })

  $('btn-refresh').addEventListener('click', function () {
    loadCategories()
    if (state.view === 'installed') loadInstalled()
    else if (state.view === 'market') loadItems()
  })

  $('btn-search').addEventListener('click', function () {
    state.q = $('q').value.trim()
    state.page = 1
    state.view = 'market'
    if (state.q) { state.source = 'all'; state.category = '' }
    loadItems()
  })

  $('q').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') $('btn-search').click()
  })

  $('btn-web').addEventListener('click', function () {
    state.view = state.view === 'web' ? 'market' : 'web'
    if (state.view === 'market') loadItems(); else render()
  })

  $('btn-theme').addEventListener('click', function () {
    var root = document.documentElement
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'
    root.setAttribute('data-theme', next)
    try { localStorage.setItem('dsh-mcp-market-hub:theme', next) } catch (error) { /* ignore */ }
  })

  try {
    var saved = localStorage.getItem('dsh-mcp-market-hub:theme')
    if (saved) document.documentElement.setAttribute('data-theme', saved)
  } catch (error) { /* ignore */ }

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeDetail()
  })

  loadInstalledFile()
  loadCategories()
  loadItems()
})()
