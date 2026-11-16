// dsh-mcp-market-hub — serve the panel document out of ui/.
//
// The panel is plain HTML/CSS/JS (no build step) so the market grid, category rail
// and install drawer can look like the real market sites instead of a list of
// React buttons. DSH mounts it in an iframe; everything below is same-origin with
// the DSH web server, so the panel can call /dsh-mcp-market-hub/api directly.

import { readFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const UI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'ui')
const PREFIX = '/dsh-mcp-market-hub/ui'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

// The panel may show market logos over https and may embed the MCP Market site.
// `frame-ancestors 'self'` keeps other origins from framing it.
const CSP = [
  "default-src 'self'",
  "img-src 'self' data: https:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "frame-src 'self' https://mcpmarket.cn https://www.modelscope.cn https://modelscope.cn",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

function resolveUiFile(pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return { ok: false }
  }
  const segments = decoded.replace(/\\/g, '/').split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.includes('..')) return { ok: false }
  if (segments.length === 0) return { ok: true, path: join(UI_DIR, 'index.html'), rel: 'index.html' }
  const abs = resolve(UI_DIR, ...segments)
  const relAbs = relative(UI_DIR, abs)
  if (relAbs === '' || relAbs === '..' || relAbs.startsWith('..' + sep) || isAbsolute(relAbs)) return { ok: false }
  return { ok: true, path: abs, rel: segments.join('/') }
}

/** Register the panel document route; returns its disposer. */
export function mountUi(ctx) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      const pathname = new URL(String(req.url || '/'), 'http://localhost').pathname
      const rest = pathname.startsWith(PREFIX) ? pathname.slice(PREFIX.length) : pathname
      const file = resolveUiFile(rest || '/')
      if (!file.ok) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }
      try {
        const body = await readFile(file.path)
        res.writeHead(200, {
          'content-type': MIME[extname(file.rel).toLowerCase()] || 'application/octet-stream',
          'content-length': body.length,
          'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'content-security-policy': CSP,
        })
        res.end(req.method === 'HEAD' ? undefined : body)
      } catch (error) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
      }
    },
  })
}

export { UI_DIR, PREFIX }
