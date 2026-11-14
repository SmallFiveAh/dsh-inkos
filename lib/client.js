/* ============================================================
   Client 半身 —— 左侧栏入口 + 舞台区内的 InkOS 页面
   ------------------------------------------------------------
   本文件是 DSH 的「浏览器半边」：一个 CJS 模块表，首次 require 时才跑副作用。
   它只做两件事：

   ① 在 sidebar.panellist 注册一枚图标
        —— 就是左侧栏「新建对话」下方那排面板入口里的一格。
           宿主对这一行的点击会 layout.selectPanel(id)，不需要（也不应该）
           自己拦事件：拦下来反而会让中央舞台不切换。

   ② 在 main 注册同一 id 的舞台页
        —— 点击 ① 之后，宿主把中央舞台切到这个 key，这里就是那一页。
           页面本体是 InkOS Studio 自己（由 Host 半身拉起的子进程提供），
           用 iframe 铺满舞台，不跳外部浏览器、不开独立窗口。

   两个 id 必须同名（PANEL_ID）：宿主是按「panellist.id === main.key」
   把入口和页面认成同一个面板的。
   ============================================================ */

window.__ModuleLoader__.load({
  id: 'dsh-inkos',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    /** 依赖在模块入口静态声明：DSH 的客户端 ctx 是能力代理，没声明的服务拿不到 */
    const inject = ['slots']

    /** 面板身份：panellist.id 与 main.key 用同一个值 */
    const PANEL_ID = 'inkos'
    /** 状态路由前缀，必须与 lib/host.js 的 BASE_PATH 一致 */
    const BASE = '/dsh-inkos'
    const TITLE = 'InkOS 创作工作台'

    /* ---------- 主题色兜底：宿主没给 --dsw-* 令牌时也不能变成白底黑字 ---------- */

    const C = {
      text: 'var(--dsw-alias-text-1, inherit)',
      text2: 'var(--dsw-alias-text-2, rgba(127,127,127,.92))',
      text3: 'var(--dsw-alias-text-3, rgba(127,127,127,.7))',
      bg: 'var(--dsw-alias-bg-layer-1, transparent)',
      border: 'var(--dsw-alias-border-l1, rgba(127,127,127,.24))',
      accent: 'var(--dsw-alias-brand-primary, #4d6bfe)',
    }

    /* ---------- ① 侧栏图标 ---------- */

    /** 一支笔尖＋一页纸：和 InkOS「写字的工作台」对得上，18px 下也不糊 */
    const Glyph = ({ size = 18 }) =>
      h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { key: 'page', d: 'M13.5 3.5H6.5A2 2 0 0 0 4.5 5.5v13a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-9' }),
        h('path', { key: 'fold', d: 'M13.5 3.5v6h6' }),
        h('path', { key: 'nib', d: 'M8.6 15.6l1.1-3.2 5.4-5.4a1.2 1.2 0 0 1 1.7 1.7l-5.4 5.4-2.8 1.5z' }),
      )

    function createSidebarEntry() {
      return function InkOSSidebarEntry(owner = {}) {
        const size = owner.size ?? 18
        const active = Boolean(owner.active)
        return h(
          'span',
          {
            role: 'button',
            tabIndex: 0,
            title: TITLE,
            'aria-label': TITLE,
            'aria-pressed': active ? 'true' : 'false',
            'data-dsh-inkos-entry': PANEL_ID,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '100%',
              height: '100%',
              color: 'inherit',
              opacity: active ? 1 : 0.78,
              cursor: 'pointer',
            },
          },
          h(Glyph, { size }),
        )
      }
    }

    /* ---------- ② 舞台页 ---------- */

    function createStagePage() {
      return function InkOSStage() {
        const [boot, setBoot] = React.useState(null)
        const [attempt, setAttempt] = React.useState(0)
        const [frameReady, setFrameReady] = React.useState(false)
        const [retrying, setRetrying] = React.useState(false)
        /** 上一次看到的 revision：上游自动更新后它 +1，我们就换一张新 iframe */
        const revisionRef = React.useRef(null)

        // 轮询宿主的状态路由：没就绪时快轮，就绪后慢轮（为了发现自动更新）
        React.useEffect(() => {
          let alive = true
          let timer = 0

          const poll = async () => {
            let next
            try {
              const res = await fetch(`${BASE}/boot.json`, { cache: 'no-store' })
              next = await res.json()
            } catch (error) {
              next = {
                ok: false,
                phase: 'unreachable',
                error: `拿不到宿主状态路由：${(error && error.message) || error}`,
              }
            }
            if (!alive) return

            if (next.phase === 'ready') {
              const previous = revisionRef.current
              revisionRef.current = next.revision
              // 版本换了 → 让 iframe 重新挂载，用户不用自己刷新
              if (previous !== null && previous !== next.revision) setFrameReady(false)
            }

            setBoot(next)

            let delay = 1200
            if (next.phase === 'ready') delay = 60000
            else if (next.phase === 'failed' || next.phase === 'unreachable') delay = 0
            if (delay) timer = window.setTimeout(poll, delay)
          }

          poll()
          return () => {
            alive = false
            if (timer) window.clearTimeout(timer)
          }
        }, [attempt])

        const retry = React.useCallback(() => {
          setRetrying(true)
          setFrameReady(false)
          fetch(`${BASE}/restart`, { method: 'POST' })
            .catch(() => null)
            .then(() => {
              setBoot({ phase: 'starting' })
              setAttempt((n) => n + 1)
            })
            .finally(() => setRetrying(false))
        }, [])

        const ready = Boolean(boot && boot.phase === 'ready' && boot.url)

        /**
         * 遮罩的兜底：绝不能只等 iframe 的 load。
         * load 要等文档的所有子资源（字体、图片）都结束——上游 Studio 曾经因为
         * 一条外链字体卡住 30 秒，遮罩也跟着糊了 30 秒。现在网关已经摘掉了那条
         * 导入，但这里仍留一个看门狗：到点就揭开，让 Studio 自己的骨架先露出来。
         */
        React.useEffect(() => {
          if (!ready || frameReady) return undefined
          const timer = window.setTimeout(() => setFrameReady(true), 2500)
          return () => window.clearTimeout(timer)
        }, [ready, frameReady, attempt])

        /* ready：iframe 铺满整个舞台，其余一概不加（不遮挡、不加工具栏） */
        if (ready) {
          return h(
            'div',
            {
              'data-dsh-inkos-stage': 'ready',
              style: {
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                width: '100%',
                height: '100%',
                minHeight: 0,
                background: C.bg,
              },
            },
            !frameReady &&
              h(
                'div',
                {
                  key: 'veil',
                  style: {
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: C.bg,
                    color: C.text2,
                    font: '13px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif',
                    zIndex: 2,
                  },
                },
                '正在打开 InkOS Studio…',
              ),
            h('iframe', {
              key: `${boot.url}#${attempt}#${boot.revision || 0}`,
              src: boot.url,
              title: TITLE,
              onLoad: () => setFrameReady(true),
              allow: 'clipboard-write; fullscreen',
              referrerPolicy: 'no-referrer',
              style: {
                flex: '1 1 auto',
                width: '100%',
                height: '100%',
                minHeight: 0,
                border: 0,
                display: 'block',
                background: 'transparent',
              },
            }),
          )
        }

        /* 其余状态：一张居中的说明卡，说清楚现在在干什么、卡在哪 */
        const failed = boot && (boot.phase === 'failed' || boot.phase === 'unreachable')
        const title = failed
          ? boot.phase === 'unreachable'
            ? '宿主状态路由不可用'
            : 'InkOS Studio 没起来'
          : '正在启动 InkOS Studio…'

        const detail = failed
          ? boot.error || '未知错误'
          : boot && boot.update && boot.update.updating
            ? '正在从 npm 更新 InkOS，装完会自动重新打开…'
            : boot && boot.phase === 'preparing'
              ? '正在准备 InkOS 项目目录…'
              : boot && boot.phase === 'starting'
                ? '正在加载 Studio 服务，首次启动会慢一些…'
                : '正在等待工作室就绪…'

        const logs = failed && Array.isArray(boot.logs) ? boot.logs.slice(-6) : []

        return h(
          'div',
          {
            'data-dsh-inkos-stage': failed ? 'error' : 'loading',
            style: {
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 14,
              width: '100%',
              height: '100%',
              padding: 28,
              boxSizing: 'border-box',
              background: C.bg,
              color: C.text,
              font: '13px/1.7 system-ui, -apple-system, "Segoe UI", sans-serif',
              textAlign: 'center',
            },
          },
          h('div', { style: { fontSize: 15, fontWeight: 600 } }, title),
          h('div', { style: { maxWidth: 560, color: C.text2, wordBreak: 'break-word' } }, detail),
          logs.length > 0 &&
            h(
              'pre',
              {
                style: {
                  maxWidth: 640,
                  maxHeight: 160,
                  overflow: 'auto',
                  margin: 0,
                  padding: '8px 10px',
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                  background: 'rgba(127,127,127,.08)',
                  color: C.text3,
                  font: '11.5px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace',
                  textAlign: 'left',
                  whiteSpace: 'pre-wrap',
                },
              },
              logs.join('\n'),
            ),
          failed &&
            h(
              'button',
              {
                type: 'button',
                onClick: retry,
                disabled: retrying,
                style: {
                  marginTop: 4,
                  padding: '7px 18px',
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                  background: 'transparent',
                  color: C.accent,
                  font: '13px/1 inherit',
                  cursor: retrying ? 'default' : 'pointer',
                },
              },
              retrying ? '正在重启…' : '重新启动 Studio',
            ),
        )
      }
    }

    /* ---------- 装配 ---------- */

    function apply(ctx) {
      const slots = ctx && ctx.slots
      if (!slots) {
        console.warn('[dsh-inkos] 缺少 slots 服务，界面未注册')
        return
      }

      // ① 左侧栏入口：排在自带面板之后
      slots.inject('sidebar.panellist', () =>
        slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 8,
            label: () => TITLE,
          },
          createSidebarEntry(),
        ),
      )

      // ② 舞台页：id 与 ① 同名，宿主才会把点击落到这一页上
      slots.inject('main', () =>
        slots.register({ name: 'main', key: PANEL_ID }, createStagePage()),
      )
    }

    exports.name = 'inkos'
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
