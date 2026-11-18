// dsh-mcp-market-hub — client shell.
//
// The panel itself is a standalone document served by the host route
// /dsh-mcp-market-hub/ui (see lib/ui.js). Keeping it out of this bundle is the
// same split other DSH panels use: the client only owns the sidebar entry and
// the frame, the panel owns the layout and its own CSP.
//
// Registration is defensive on purpose — a host that lacks a slot must not take
// the whole client bundle down with it.
window.__ModuleLoader__.load({
  id: 'dsh-mcp-market-hub',
  factory(require) {
    var React = require('react')
    var h = React.createElement
    var PANEL_ID = 'dsh-mcp-market-hub'
    var SIDEBAR_ORDER = 32
    var PANEL_PATH = '/dsh-mcp-market-hub/ui/'
    var LABEL = 'MCP 市场'

    function panelUrl() {
      try {
        return new URL(PANEL_PATH, window.location.origin).href
      } catch (error) {
        return PANEL_PATH
      }
    }

    function MarketPanel() {
      var frameRef = React.useRef(null)
      React.useEffect(function () {
        var frame = frameRef.current
        if (!frame) return
        var url = panelUrl()
        if (frame.getAttribute('src') !== url) frame.setAttribute('src', url)
      }, [])
      return h('iframe', {
        ref: frameRef,
        title: LABEL,
        src: panelUrl(),
        style: {
          width: '100%',
          height: '100%',
          minHeight: 320,
          border: 0,
          display: 'block',
          background: 'transparent',
        },
      })
    }

    function SidebarIcon() {
      return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none' },
        h('circle', { cx: 12, cy: 12, r: 8.2, stroke: 'currentColor', strokeWidth: 1.7 }),
        h('path', {
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round',
          d: 'M12 3.8v5.4M12 14.8v5.4M3.8 12h5.4M14.8 12h5.4',
        }))
    }

    function warn(what, error) {
      try {
        console.error('[dsh-mcp-market-hub] ' + what + ' failed (the rest of the panel still works):', error)
      } catch (ignored) {
        // console is not guaranteed in every embedding
      }
    }

    /** Register into one slot, surviving a host that does not offer it. */
    function mount(slots, slotKey, build, what) {
      try {
        return slots.inject(slotKey, function () {
          try {
            return build()
          } catch (error) {
            warn(what, error)
            return function () {}
          }
        })
      } catch (error) {
        warn(what, error)
        return function () {}
      }
    }

    return {
      name: 'dsh-mcp-market-hub',
      inject: ['slots'],
      apply(ctx) {
        var slots = ctx.slots
        if (!slots || typeof slots.inject !== 'function') {
          warn('slots service', new Error('ctx.slots is unavailable'))
          return
        }
        mount(slots, 'main', function () {
          return slots.register({ name: 'main', key: PANEL_ID }, MarketPanel)
        }, 'main panel')
        mount(slots, 'sidebar.panellist', function () {
          return slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: SIDEBAR_ORDER,
            label: function () { return LABEL },
          }, SidebarIcon)
        }, 'sidebar entry')
      },
    }
  },
})
