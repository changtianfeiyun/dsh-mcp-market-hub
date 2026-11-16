// dsh-mcp-market-hub — client shell.
//
// The panel itself is a standalone document served by the host route
// /dsh-mcp-market-hub/ui (see lib/ui.js). Keeping it out of this bundle is the
// same split dsh-mcp-connector uses: the client only owns the sidebar entry and
// the frame, the panel owns the layout.
window.__ModuleLoader__.load({
  id: 'dsh-mcp-market-hub',
  factory(require) {
    var React = require('react')
    var h = React.createElement
    var SIDEBAR_ID = 'dsh-mcp-market-hub'
    var SIDEBAR_ORDER = 32
    var PANEL_PATH = '/dsh-mcp-market-hub/ui/'

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
        title: 'MCP 市场',
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

    return {
      inject: ['slots'],
      apply(ctx) {
        var slots = ctx.slots
        slots.inject('main', function () {
          return slots.register({ name: 'main', key: SIDEBAR_ID }, MarketPanel)
        })
        slots.inject('sidebar.panellist', function () {
          return slots.register({
            name: 'sidebar.panellist',
            id: SIDEBAR_ID,
            order: SIDEBAR_ORDER,
            label: function () { return 'MCP 市场' },
          }, SidebarIcon)
        })
      },
    }
  },
})
