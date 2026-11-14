/* ============================================================
   宿主半身端到端冒烟 —— 真起一个 InkOS Studio，真发 HTTP 请求
   ------------------------------------------------------------
   这一步不看 mock，看的是真东西：
     · 用官方 bootstrap 建一个全新的 InkOS 项目
     · 通过 lib/host.js 的 apply() 拉起 Studio 子进程
     · 按网页半身的方式请求 /dsh-inkos/boot.json，等它变成 ready
     · 再确认 Studio 首页、前端产物、API 都真的能打开
     · 最后卸载插件，确认子进程被回收（不留孤儿进程）
   ============================================================ */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = '/dsh-inkos'

const failures = []
const passes = []
const ok = (label, detail) => passes.push(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
const bad = (label, error) => failures.push(`  ✗ ${label} — ${error?.message || error}`)

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

/** 把 Node 的 req/res 压成一次简单的内存调用 */
function callRoute(handler, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const res = {
      status: 0,
      headers: {},
      writeHead(code, headers) {
        this.status = code
        this.headers = headers || {}
      },
      end(body) {
        resolve({
          status: this.status,
          headers: this.headers,
          body: body === undefined || body === null ? '' : String(body),
        })
      },
    }
    const req = { method, url: path, headers: {} }
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

function fakeCtx(routes) {
  const disposers = []
  return {
    disposers,
    ctx: {
      effect(fn) {
        const dispose = fn()
        if (typeof dispose === 'function') disposers.push(dispose)
        return dispose
      },
      inject(names, cb) {
        cb({
          webServer: {
            register({ path, handler }) {
              routes.set(path, handler)
              return () => routes.delete(path)
            },
          },
        })
      },
      logger: {
        info: (...args) => console.log('   ', ...args),
        warn: (...args) => console.warn('   ', ...args),
        debug: () => {},
      },
    },
  }
}

async function main() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dsh-inkos-smoke-'))
  console.log(`临时 InkOS 项目：${projectRoot}\n`)

  const routes = new Map()
  const { ctx, disposers } = fakeCtx(routes)
  const { apply } = await import('../lib/host.js')

  let exitCode = 0
  try {
    const t0 = Date.now()
    apply(ctx, { projectRoot, readyTimeoutMs: 150_000 })

    const handler = routes.get(BASE)
    assert(handler, '状态路由没有挂载到 /dsh-inkos')
    ok('状态路由挂载', `${BASE}/boot.json`)

    // 等 Studio 就绪（首次启动要跑 bootstrap + 加载核心依赖）
    let snapshot = null
    const deadline = Date.now() + 150_000
    while (Date.now() < deadline) {
      const res = await callRoute(handler, `${BASE}/boot.json`)
      assert(res.status === 200, `boot.json 返回 ${res.status}`)
      snapshot = JSON.parse(res.body)
      if (snapshot.phase === 'ready') break
      if (snapshot.phase === 'failed') throw new Error(`启动失败：${snapshot.error}\n${(snapshot.logs || []).join('\n')}`)
      await new Promise((r) => setTimeout(r, 500))
    }
    assert(snapshot && snapshot.phase === 'ready', '超时仍未就绪')
    ok('Studio 就绪', `${snapshot.url}（${((Date.now() - t0) / 1000).toFixed(1)}s）`)
    ok('项目已自动初始化', snapshot.projectRoot)

    // Studio 首页：就是 InkOS 自己的那套前端
    const home = await fetch(snapshot.url)
    const html = await home.text()
    assert(home.ok, `首页 HTTP ${home.status}`)
    assert(/InkOS Studio/i.test(html), '首页不是 InkOS Studio')
    const asset = html.match(/\/assets\/[^"]+\.js/)?.[0]
    const style = html.match(/\/assets\/[^"]+\.css/)?.[0]
    assert(asset, '首页里没有前端 JS 产物')
    ok('首页返回 InkOS Studio', `${html.length}B · title 命中`)

    for (const [label, path] of [['JS 产物', asset], ['CSS 产物', style]]) {
      if (!path) continue
      const res = await fetch(new URL(path, snapshot.url))
      assert(res.ok, `${label} HTTP ${res.status}`)
      const size = (await res.arrayBuffer()).byteLength
      assert(size > 1000, `${label} 只有 ${size}B`)
      ok(`${label}可加载`, `${path} · ${(size / 1024).toFixed(0)}KB`)
    }

    // API：只有真后端才会这么答
    const api = await fetch(new URL('/api/v1/books', snapshot.url))
    const body = await api.json()
    assert(api.ok && Array.isArray(body.books), '/api/v1/books 返回异常')
    ok('Studio API 可用', `/api/v1/books → ${JSON.stringify(body)}`)

    // 网关：外链字体必须被摘掉，否则首屏会被 DNS/连接超时拖死（实测 30s）
    if (style) {
      const css = await fetch(new URL(style, snapshot.url))
      const text = await css.text()
      assert(!/fonts\.googleapis\.com/.test(text), 'CSS 里仍带着外链 @import，首屏会被拖住')
      assert(text.length > 10_000, `CSS 内容异常（${text.length}B）`)
      ok('网关摘除外链字体', `${style} · 无 fonts.googleapis.com`)
    }

    const homeHeaders = home.headers
    assert(
      /style-src/.test(homeHeaders.get('content-security-policy') || ''),
      'HTML 缺少约束样式的 CSP',
    )
    ok('网关注入样式 CSP', 'style-src/font-src 只允许本机')

    assert(snapshot.gatewayPort && snapshot.studioUrl, 'boot.json 没报告网关与上游地址')
    ok('网关与上游都在快照里', `gateway=${snapshot.gatewayPort} studio=${snapshot.studioUrl}`)

    // 卸载：子进程必须跟着走
    disposers.forEach((dispose) => {
      try {
        dispose()
      } catch (error) {
        bad('卸载清理', error)
      }
    })
    await new Promise((r) => setTimeout(r, 800))
    const afterStop = await fetch(snapshot.url, { signal: AbortSignal.timeout(2_000) }).then(
      () => 'alive',
      () => 'gone',
    )
    assert(afterStop === 'gone', '插件卸载后 Studio 仍在监听')
    ok('卸载即回收', '子进程随插件生命周期结束')
  } catch (error) {
    bad('端到端流程', error)
    exitCode = 1
  } finally {
    disposers.forEach((dispose) => {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    })
    rmSync(projectRoot, { recursive: true, force: true })
  }

  console.log('\ndsh-inkos 宿主半身冒烟\n')
  passes.forEach((line) => console.log(line))
  if (failures.length > 0) {
    console.log('')
    failures.forEach((line) => console.log(line))
    console.log(`\n${failures.length} 项未通过`)
    process.exit(1)
  }
  console.log(`\n全部 ${passes.length} 项通过`)
  process.exit(exitCode)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
