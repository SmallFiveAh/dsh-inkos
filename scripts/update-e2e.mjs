/* ============================================================
   上游自动更新 · 真机端到端
   ------------------------------------------------------------
   不 mock 任何一步，走的就是用户机器上的真实路径：

     ① 把插件降到 1.7.2（真实 npm install）
     ② 用 host.js 起 Studio，确认 snapshot.version = 1.7.2
     ③ 调用 session.runUpdateCheck()，让插件自己发现 1.8.0 并升级
     ④ 断言：装好了、Studio 重新就绪、版本变了、**舞台地址没变**、revision +1
     ⑤ 确认页面仍然返回 InkOS Studio

   跑完插件会停在 npm 最新版（也就是自动更新该有的终态）。
   ============================================================ */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { install, readDeclared, checkLatest } from '../lib/updater.js'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = '/dsh-inkos'

const failures = []
const passes = []
const ok = (label, detail) => passes.push(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
const bad = (label, error) => failures.push(`  ✗ ${label} — ${error?.message || error}`)

function assert(condition, message) {
  if (!condition) throw new Error(message)
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
      inject(_names, cb) {
        cb({
          webServer: {
            register({ path, handler }) {
              routes.set(path, handler)
              return () => routes.delete(path)
            },
          },
        })
      },
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
    },
  }
}

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
        resolve({ status: this.status, headers: this.headers, body: body ? String(body) : '' })
      },
    }
    Promise.resolve(handler({ method, url: path, headers: {} }, res)).catch(reject)
  })
}

async function waitReady(handler, timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs
  let snapshot = null
  while (Date.now() < deadline) {
    const res = await callRoute(handler, `${BASE}/boot.json`)
    snapshot = JSON.parse(res.body)
    if (snapshot.phase === 'ready') return snapshot
    if (snapshot.phase === 'failed') throw new Error(`启动失败：${snapshot.error}`)
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error('等待就绪超时')
}

async function main() {
  const workDir = mkdtempSync(join(tmpdir(), 'inkos-update-'))
  const projectRoot = join(workDir, 'project')
  const updateStateFile = join(workDir, 'updater.json')
  const latest = await checkLatest({ log: () => {} })
  const newest = latest['@actalk/inkos']
  console.log(`npm 最新版：${newest}\n`)

  const { apply } = await import('../lib/host.js')
  let exitCode = 1

  try {
    // ① 降级到一个更老的版本
    const oldTarget = { '@actalk/inkos': '1.7.2', '@actalk/inkos-studio': '1.7.2' }
    console.log('① 降到 1.7.2 …')
    await install(PLUGIN_ROOT, oldTarget, { log: () => {} })
    assert((await readDeclared(PLUGIN_ROOT))['@actalk/inkos'] === '1.7.2', '降级没生效')
    ok('准备：插件已是旧版', '1.7.2')

    const routes = new Map()
    const { ctx, disposers } = fakeCtx(routes)
    apply(ctx, {
      projectRoot,
      updateStateFile,
      readyTimeoutMs: 150_000,
      autoUpdate: true,
      updatePolicy: 'latest',
      updateCheckHours: 24, // 关掉定时器，测试里手动触发
    })

    const handler = routes.get(BASE)
    assert(handler, '状态路由没挂载')

    // ② 旧版能正常起来
    const before = await waitReady(handler)
    assert(before.version === '1.7.2', `旧版启动后版本应为 1.7.2，实际 ${before.version}`)
    ok('旧版可正常启动', `version=${before.version}`)

    // ③ 让插件自己去升级：走的就是网页半身会用的那条路由
    console.log('③ 触发自动更新 …')
    const started = Date.now()
    const trigger = await callRoute(handler, `${BASE}/update`, 'POST')
    assert(trigger.status === 202, `触发接口返回 ${trigger.status}`)

    // 轮询到版本变化为止（期间会经历 starting）
    let after = null
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
      const res = await callRoute(handler, `${BASE}/boot.json`)
      const snap = JSON.parse(res.body)
      if (snap.phase === 'ready' && snap.version === newest) {
        after = snap
        break
      }
      if (snap.phase === 'failed') throw new Error(`升级后启动失败：${snap.error}`)
      await new Promise((r) => setTimeout(r, 500))
    }
    assert(after, `等不到升到 ${newest}`)
    const cost = ((Date.now() - started) / 1000).toFixed(1)
    ok('插件自行发现并安装新版', `1.7.2 → ${after.version}（${cost}s）`)

    // ④ 升级后必须仍然就绪，且舞台地址不变
    assert(after.phase === 'ready', `升级后状态是 ${after.phase}`)
    assert(after.url === before.url, `舞台地址变了：${before.url} → ${after.url}`)
    assert(after.revision > before.revision, 'revision 没有递增，页面不会自动刷新')
    ok('升级后 Studio 仍就绪', `phase=${after.phase} version=${after.version}`)
    ok('舞台地址保持不变', `${after.url}（iframe 不用重新指向）`)
    ok('revision 递增（页面会自动重挂）', `${before.revision} → ${after.revision}`)

    // ⑤ 页面真的是新版且能打开
    const home = await fetch(after.url)
    const html = await home.text()
    assert(
      home.ok && /InkOS Studio/i.test(html),
      `升级后首页打不开：HTTP ${home.status}，body=${JSON.stringify(html.slice(0, 160))}`,
    )
    const shipped = await readDeclared(PLUGIN_ROOT)
    assert(shipped['@actalk/inkos'] === newest, 'package.json 没跟着更新，重装会退回旧版')
    ok('升级后页面可访问', `HTTP ${home.status} · ${html.length}B`)
    ok('package.json 同步到新版', shipped['@actalk/inkos'])

    disposers.forEach((dispose) => {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    })
    exitCode = 0
  } catch (error) {
    bad('自动更新流程', error)
  } finally {
    // 兜底：无论成败都回到最新版，别把插件留在旧版上
    try {
      const declared = await readDeclared(PLUGIN_ROOT)
      if (declared['@actalk/inkos'] !== newest) {
        await install(PLUGIN_ROOT, { '@actalk/inkos': newest, '@actalk/inkos-studio': newest }, { log: () => {} })
      }
    } catch {
      /* ignore */
    }
    rmSync(workDir, { recursive: true, force: true })
  }

  console.log('\ndsh-inkos 自动更新端到端\n')
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
