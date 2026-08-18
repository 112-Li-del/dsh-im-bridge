// dsh-im-bridge 浏览器半体：侧边栏底部（设置旁）二维码按钮 + 浮层显示登录二维码。
// 手写的 __ModuleLoader__ 格式 bundle（与 tsdown 产物同构）；工厂内使用 React.createElement。
window.__ModuleLoader__.load({
  id: 'dsh-im-bridge',
  factory: (require) => {
    const React = require('react')

    // 模块级 UI 状态：按钮与浮层通过它联动
    const qrUi = {
      open: false,
      listeners: new Set(),
      toggle() {
        this.open = !this.open
        this.notify()
      },
      close() {
        if (!this.open) return
        this.open = false
        this.notify()
      },
      subscribe(fn) {
        this.listeners.add(fn)
        return () => this.listeners.delete(fn)
      },
      notify() {
        for (const fn of this.listeners) fn()
      },
    }

    const QR_IMAGE_URL = '/dsh-im-bridge/qr.png'
    const STATUS_URL = '/dsh-im-bridge/status.json'
    const POLL_MS = 5000

    // 侧边栏底部的小按钮（rail 态 36px / 宽态 28px）
    function QRButton(props) {
      const wide = Boolean(props.wide)
      const [, force] = React.useState(0)
      React.useEffect(() => qrUi.subscribe(() => force((n) => n + 1)), [])
      const open = qrUi.open
      return React.createElement(
        'button',
        {
          type: 'button',
          title: '微信远程控制（扫码登录）',
          'aria-label': '微信二维码',
          'aria-expanded': open,
          onClick: () => qrUi.toggle(),
          style: {
            cursor: 'pointer',
            background: 'transparent',
            border: 'none',
            borderRadius: '50%',
            width: wide ? 28 : 36,
            height: wide ? 28 : 36,
            flex: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            color: open ? 'var(--dsw-alias-brand-primary, #4d6bfe)' : 'var(--dsw-alias-label-secondary)',
          },
        },
        React.createElement(
          'svg',
          { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true' },
          React.createElement('path', {
            d: 'M3 3h8v8H3V3zm2 2v4h4V5H5zm8-2h8v8h-8V3zm2 2v4h4V5h-4zM3 13h8v8H3v-8zm2 2v4h4v-4H5zm13-2h3v2h-3v-2zm-5 0h2v2h-2v-2zm5 5h3v2h-3v-2zm-5 0h2v5h-2v-5z',
          }),
        ),
      )
    }

    // 二维码浮层（shell.overlay 条目；关闭时渲染 null）
    function QRPanel() {
      const [open, setOpen] = React.useState(qrUi.open)
      const [status, setStatus] = React.useState(null)
      const [imgError, setImgError] = React.useState(false)
      const [tick, setTick] = React.useState(Date.now())

      React.useEffect(() => qrUi.subscribe(() => setOpen(qrUi.open)), [])

      React.useEffect(() => {
        if (!open) return
        let alive = true
        const poll = async () => {
          try {
            const r = await fetch(`${STATUS_URL}?_=${Date.now()}`)
            if (r.ok) {
              const j = await r.json()
              if (alive) {
                setStatus(j)
                setImgError(false)
              }
            }
          } catch {
            if (alive) setImgError(true)
          }
          setTick(Date.now())
        }
        poll()
        const t = setInterval(poll, POLL_MS)
        return () => {
          alive = false
          clearInterval(t)
        }
      }, [open])

      if (!open) return null

      const loggedIn = Boolean(status && status.loggedIn)
      const qrReady = Boolean(status && status.qrReady)
      const imgSrc = `${QR_IMAGE_URL}?_=${tick}`

      return React.createElement(
        'div',
        {
          style: {
            position: 'fixed',
            right: 16,
            bottom: 56,
            zIndex: 1000,
            background: 'var(--dsw-alias-bg-layer-2, #ffffff)',
            border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
            borderRadius: 12,
            padding: 16,
            boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            alignItems: 'center',
            fontSize: 13,
            color: 'var(--dsw-alias-label-primary)',
          },
        },
        React.createElement('div', { style: { fontWeight: 600, fontSize: 14 } }, '微信远程控制'),
        loggedIn
          ? React.createElement(
              'div',
              { style: { color: 'var(--dsw-alias-label-success, #2e7d32)' } },
              '✅ 已登录，微信可远程驱动本机 DSH',
            )
          : React.createElement(
              'div',
              { style: { color: 'var(--dsw-alias-label-secondary)' } },
              '📱 用微信扫一扫登录（二维码几分钟刷新一次）',
            ),
        !qrReady || imgError
          ? React.createElement(
              'div',
              { style: { color: 'var(--dsw-alias-label-tertiary)', padding: 12 } },
              '二维码生成中，请稍候…',
            )
          : React.createElement('img', {
              src: imgSrc,
              alt: '微信登录二维码',
              width: 240,
              height: 240,
              onError: () => setImgError(true),
              style: { borderRadius: 8, background: '#ffffff', padding: 4, border: '1px solid var(--dsw-alias-border-l2, #eee)' },
            }),
        React.createElement(
          'button',
          {
            type: 'button',
            onClick: () => qrUi.close(),
            style: {
              cursor: 'pointer',
              background: 'transparent',
              border: 'none',
              color: 'var(--dsw-alias-label-secondary)',
              fontSize: 13,
              padding: '4px 12px',
            },
          },
          '关闭',
        ),
      )
    }

    return {
      name: 'dsh-im-bridge',
      apply(ctx) {
        const slots = ctx.get('slots')
        if (slots === undefined) return
        // 侧边栏底部：设置旁的小二维码按钮
        slots.inject('sidebar.footer.action', () =>
          slots.register(
            { name: 'sidebar.footer.action', id: 'im-bridge-qr', order: -20, label: '微信二维码' },
            (props) => React.createElement(QRButton, { wide: props.wide }),
          ),
        )
        // 全局浮层：二维码面板
        slots.inject('shell.overlay', () =>
          slots.register(
            { name: 'shell.overlay', id: 'im-bridge-qr-panel', order: 20, label: '微信二维码面板' },
            () => React.createElement(QRPanel),
          ),
        )
      },
    }
  },
})
