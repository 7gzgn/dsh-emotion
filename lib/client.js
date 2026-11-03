// dsh-emotion 客户端：在 DSH 里注册一个「情绪」页，内容用 iframe 嵌本机面板。
// 只做容器，UI 仍在 http://127.0.0.1:7799/ —— 这样面板样式改一次两边都生效。
window.__ModuleLoader__.load({
  id: 'dsh-emotion',
  factory: (require) => {
    const React = require('react')
    const PANEL_URL = 'http://127.0.0.1:7799/'
    const KEY = 'dsh-emotion-panel'

    function EmotionPanel() {
      return React.createElement(
        'div',
        {
          style: {
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'stretch',
            width: '100%',
            height: '100%',
            padding: '12px 16px',
            boxSizing: 'border-box',
            overflow: 'hidden',
          },
        },
        React.createElement('iframe', {
          src: PANEL_URL,
          title: '情绪',
          style: {
            width: 'min(1080px, 100%)',
            height: '100%',
            border: '1px solid rgba(138,109,40,.45)',
            borderRadius: '14px',
            background: 'transparent',
          },
        }),
      )
    }

    function EmotionIcon() {
      return React.createElement('span', { 'aria-hidden': 'true' }, '\u25CE')
    }

    // 服务名，不是包名 —— 写成 ['layout'] 会让 cordis 永远不注入，apply 根本不执行
    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.inject(['layout'], (pageCtx) => {
        if (!pageCtx || !pageCtx.slots) return
        pageCtx.slots.inject('main', () =>
          pageCtx.slots.register(
            {
              name: 'main',
              key: KEY,
              locale: 'emotion',
              inject: () => ({ renderPanel: () => React.createElement(EmotionPanel) }),
            },
            EmotionPanel,
          ),
        )
        pageCtx.slots.inject('sidebar.panellist', () =>
          pageCtx.slots.register(
            {
              name: 'sidebar.panellist',
              id: KEY,
              order: 30,
              label: () => '情绪',
              locale: 'emotion',
            },
            EmotionIcon,
          ),
        )
      })
    }

    return { name: 'emotion', apply, inject }
  },
})
