/* ============================================================
   Host 半身 —— 把 InkOS Studio 原样跑起来，并把状态挂成同源路由
   ------------------------------------------------------------
   设计取舍（为什么是「子进程 + 同源状态路由」而不是别的）：

   1) 不重写 InkOS 的界面。
      InkOS 的创作工作台是一整套 Vite + React + Hono 应用（建书、写作、
      多线推演、Short、Play、翻译、封面、服务配置……）。任何「照着重画
      一遍」的复刻都会在第二周就开始漂移。这里直接跑官方包
      @actalk/inkos-studio 的 dist/api/index.js —— 与 `inkos studio`
      启动的是同一个进程、同一份前端产物，页面结构、交互流程、显示呈现
      都按原样，不多不少。

   2) 用子进程而不是 import 进宿主。
      inkos-core 会拉起 SQLite、LLM 客户端、大量 ESM 依赖，塞进宿主的
      模块图里既容易撞版本，也容易拖慢宿主启动；子进程崩了还能单独重启，
      宿主的对话不受牵连。

   3) 只挂一条同源状态路由（/dsh-inkos/boot.json 等）。
      舞台里的 iframe 需要知道「Studio 在哪个端口、好了没有」；这条路由
      顺便承担「重启」这个动作。静态页面本身仍由 Studio 自己提供，
      本插件不介入它的任何资源。

   失败的姿态：任何一步出错都不许把插件标记成「未激活」——
   一旦抛出去，侧栏入口和舞台页会一起消失，用户只看到一行红字。
   所以这里统一降级成 phase:'failed' + 人话原因，由舞台页显示并提供重试。
   ============================================================ */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startGateway } from './gateway.js'
import {
  checkLatest,
  createStateStore,
  decide,
  install,
  readDeclared,
  verifyLayout,
} from './updater.js'

export const name = 'inkos'

/**
 * 不静态声明 webServer：它是「有就挂、没有就降级」的可选能力。
 * 声成强依赖会让我们永远等不到它；而直接读外层 ctx.webServer 又会被宿主的
 * 守卫代理拒绝（cannot get property "webServer" without inject）。
 * 官方先例是 dshmarket：ctx.inject(['webServer'], scoped => ...)，只允许在
 * 回调给的 scoped 上下文里访问已声明的服务。
 */
export const inject = []

/** 与 lib/client.js 的 BASE 必须一致：舞台页就是靠它来问状态的 */
const BASE_PATH = '/dsh-inkos'

/** 插件目录（lib/ 的上一级），用于定位自带的 bootstrap 脚本 */
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const DEFAULTS = {
  projectRoot: null,
  port: 0,
  language: 'zh',
  readyTimeoutMs: 90_000,
  blockExternalAssets: true,
  autoUpdate: true,
  updatePolicy: 'latest',
  updateCheckHours: 6,
}

const LOG_LIMIT = 40

export function apply(ctx, config = {}) {
  try {
    return activate(ctx, config)
  } catch (error) {
    console.error('[dsh-inkos] Host 半身初始化失败，入口与舞台页仍会出现：', error)
  }
}

function activate(ctx, config) {
  const settings = normalizeConfig(config)
  const session = createSession(ctx, settings)

  // 插件被卸载/禁用时回收子进程，别在用户机器上留孤儿
  ctx.effect(() => () => session.dispose(), 'dsh-inkos studio lifecycle')

  // 宿主启动即预热：用户点入口时通常已经就绪。失败也不吵，等用户点开再说。
  session
    .ensureStarted()
    .then(() => session.scheduleUpdates())
    .catch(() => {})

  // 状态路由：舞台页靠它判断「加载中 / 就绪 / 失败」，并触发重启
  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped?.webServer
    if (!webServer || typeof webServer.register !== 'function') {
      console.warn(
        '[dsh-inkos] 当前组合没有 webServer 服务：Studio 仍会自动启动，' +
          '但舞台页拿不到状态（会提示改用浏览器打开）。',
      )
      return
    }
    ctx.effect(
      () =>
        webServer.register({
          kind: 'prefix',
          path: BASE_PATH,
          handler: (req, res) => handleRoute(session, req, res),
        }),
      'dsh-inkos status route',
    )
    console.info(`[dsh-inkos] 状态路由已挂载：${BASE_PATH}/boot.json`)
  })
}

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

function normalizeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const language = raw.language === 'en' ? 'en' : 'zh'
  const port = Number.isInteger(raw.port) && raw.port > 0 ? raw.port : 0
  const readyTimeoutMs =
    Number.isFinite(raw.readyTimeoutMs) && raw.readyTimeoutMs > 5_000
      ? Math.floor(raw.readyTimeoutMs)
      : DEFAULTS.readyTimeoutMs

  const policy = ['off', 'patch', 'minor', 'latest'].includes(raw.updatePolicy)
    ? raw.updatePolicy
    : DEFAULTS.updatePolicy
  const hours = Number.isFinite(raw.updateCheckHours) && raw.updateCheckHours >= 0.02
    ? Number(raw.updateCheckHours)
    : DEFAULTS.updateCheckHours

  return {
    projectRoot:
      typeof raw.projectRoot === 'string' && raw.projectRoot.trim()
        ? resolve(raw.projectRoot.trim())
        : null,
    port,
    language,
    readyTimeoutMs,
    blockExternalAssets: raw.blockExternalAssets !== false,
    autoUpdate: raw.autoUpdate !== false && policy !== 'off',
    updatePolicy: policy,
    updateCheckMs: Math.round(hours * 3_600_000),
    updateStateFile:
      typeof raw.updateStateFile === 'string' && raw.updateStateFile.trim()
        ? resolve(raw.updateStateFile.trim())
        : join(homedir(), '.dsh', 'inkos', 'updater.json'),
  }
}

/* ------------------------------------------------------------------ */
/* 运行时定位                                                          */
/* ------------------------------------------------------------------ */

/**
 * 依赖都声明在 package.json 里，解析不到就说明装漏了。
 * 用 createRequire 而不是 import：只是拿路径，不要把 inkos-core 拽进宿主的模块图。
 *
 * 两个入口分别解析、按需调用：上游不同版本里这两个文件未必同时存在，
 * 一次解析两个会让「换个版本就起不来」这种问题提前爆炸。
 */
const requireFromPlugin = createRequire(import.meta.url)
const studioEntryPath = () =>
  requireFromPlugin.resolve('@actalk/inkos-studio/dist/api/index.js')
const bootstrapEntryPath = () =>
  requireFromPlugin.resolve('@actalk/inkos/dist/project-bootstrap.js')

/* ------------------------------------------------------------------ */
/* 会话状态机                                                          */
/* ------------------------------------------------------------------ */

function createSession(ctx, settings) {
  const state = {
    phase: 'idle', // idle | preparing | starting | ready | failed
    error: null,
    url: null, // 给舞台用的地址（网关）
    studioUrl: null, // 上游 Studio 自己的地址，仅排障用
    port: null, // Studio 端口
    gatewayPort: null,
    root: null,
    child: null,
    gateway: null,
    logs: [],
    startedAt: null,
    // 每次成功（重）启动 +1。舞台看到它变了就重新挂 iframe，
    // 于是自动更新完不需要用户手动刷新。
    revision: 0,
    intentionalStop: false,
    version: null, // 当前生效的上游版本
    update: {
      autoUpdate: settings.autoUpdate,
      policy: settings.updatePolicy,
      updating: false,
      lastCheckAt: null,
      lastResult: null,
      lastReason: null,
      lastError: null,
      badVersion: null,
    },
  }

  let inflight = null
  let disposed = false
  let updateTimer = null

  const log = (line) => {
    state.logs.push(line)
    if (state.logs.length > LOG_LIMIT) state.logs.shift()
  }

  const childEnv = () => {
    const env = {
      ...process.env,
      INKOS_PROJECT_ROOT: state.root,
      INKOS_STUDIO_PORT: String(state.port),
    }
    // 宿主若跑在 Electron 里，process.execPath 是 Electron 本体，
    // 加这个开关它才会以纯 Node 的身份执行脚本（普通 node 会忽略它）。
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
    return env
  }

  function attach(child) {
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      String(chunk)
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((line) => log(line))
    })
    child.stderr?.on('data', (chunk) => {
      String(chunk)
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((line) => log(line))
    })
    child.on('exit', (code, signal) => {
      if (state.child !== child) return
      state.child = null
      // 主动停（重启/升级）不算崩溃，别把舞台推进错误态
      if (state.phase === 'ready' && !state.intentionalStop) {
        state.phase = 'failed'
        state.error = `Studio 进程已退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`
      }
    })
  }

  function killChild() {
    const child = state.child
    state.child = null
    if (!child) return
    try {
      child.kill()
    } catch {
      /* 已经死了就算了 */
    }
  }

  async function closeGateway() {
    const gateway = state.gateway
    state.gateway = null
    state.gatewayPort = null
    if (!gateway) return
    try {
      await gateway.close()
    } catch {
      /* ignore */
    }
  }

  async function bootstrapProject() {
    const root = settings.projectRoot || join(homedir(), '.dsh', 'inkos', 'project')
    await mkdir(root, { recursive: true })
    state.root = root
    if (existsSync(join(root, 'inkos.json'))) return

    log(`未发现 inkos.json，按官方 init 逻辑初始化项目：${root}`)
    const bootstrapEntry = bootstrapEntryPath()
    await runBootstrapNode(bootstrapEntry, root, settings.language, childEnvBase())
  }

  function childEnvBase() {
    const env = { ...process.env }
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
    return env
  }

  /** 用子进程跑官方 initializeProjectDirectory，避免把 inkos-core 拉进宿主 */
  function runBootstrapNode(entry, root, language, env) {
    return new Promise((res, rej) => {
      const script = join(PLUGIN_ROOT, 'lib', 'bootstrap.mjs')
      const child = spawn(process.execPath, [script, entry, root, language], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let stderr = ''
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (c) => {
        stderr += String(c)
      })
      child.on('error', rej)
      child.on('exit', (code) => {
        if (code === 0) return res()
        rej(new Error(`项目初始化失败（code=${code}）：${stderr.trim() || '无输出'}`))
      })
    })
  }

  function findFreePort() {
    if (settings.port) return Promise.resolve(settings.port)
    return new Promise((res, rej) => {
      const srv = net.createServer()
      srv.unref()
      srv.on('error', rej)
      srv.listen(0, '127.0.0.1', () => {
        const { port } = srv.address()
        srv.close(() => res(port))
      })
    })
  }

  async function waitForReady() {
    const deadline = Date.now() + settings.readyTimeoutMs
    const probe = `http://127.0.0.1:${state.port}/api/v1/books`
    while (Date.now() < deadline) {
      if (disposed) throw new Error('插件已卸载')
      if (!state.child) throw new Error(tailLogs() || 'Studio 进程提前退出')
      try {
        const res = await fetch(probe, { signal: AbortSignal.timeout(4_000) })
        if (res.ok) {
          await res.arrayBuffer().catch(() => {})
          return
        }
      } catch {
        /* 还没起来，继续等 */
      }
      await new Promise((r) => setTimeout(r, 400))
    }
    throw new Error(
      `等待 Studio 就绪超时（${Math.round(settings.readyTimeoutMs / 1000)}s）。${
        tailLogs() || '请检查端口占用与依赖安装。'
      }`,
    )
  }

  const tailLogs = () => state.logs.slice(-6).join(' | ')

  /** 只负责把 Studio 进程拉起来并等它应答（不含项目初始化与网关） */
  async function launchStudio() {
    state.port = await findFreePort()
    state.intentionalStop = false
    state.phase = 'starting'

    const studioEntry = studioEntryPath()
    const child = spawn(process.execPath, [studioEntry, state.root], {
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    state.child = child
    attach(child)

    await waitForReady()
    state.studioUrl = `http://127.0.0.1:${state.port}/`
  }

  /**
   * 网关只建一次：端口固定，舞台 iframe 的地址就固定。
   * 升级会换掉上游端口，这里只把网关的目标指过去。
   */
  async function ensureGateway() {
    if (state.gateway) {
      state.gateway.setTarget(state.port)
      return
    }
    const gateway = await startGateway(state.port, {
      blockExternalAssets: settings.blockExternalAssets,
    })
    state.gateway = gateway
    state.gatewayPort = gateway.port
    state.url = gateway.url
  }

  async function start() {
    state.phase = 'preparing'
    state.error = null

    await bootstrapProject()
    await launchStudio()
    await ensureGateway()

    state.revision += 1
    state.phase = 'ready'
    state.startedAt = Date.now()
    state.version = await currentVersion()
    console.info(
      `[dsh-inkos] InkOS Studio 已就绪：${state.url}（上游 ${state.studioUrl}，版本 ${state.version || '未知'}，项目 ${state.root}）`,
    )
  }

  async function currentVersion() {
    try {
      const declared = await readDeclared(PLUGIN_ROOT)
      return declared['@actalk/inkos'] || null
    } catch {
      return null
    }
  }

  /** 停进程要给 Windows 一点时间放开文件句柄，否则 npm 覆盖文件会 EBUSY */
  async function stopStudio() {
    state.intentionalStop = true
    killChild()
    await new Promise((r) => setTimeout(r, 300))
  }

  /** 单飞：并发调用共用同一次启动，避免点两下开两个进程 */
  function ensureStarted() {
    if (disposed) return Promise.reject(new Error('插件已卸载'))
    // 升级期间禁止旁人再来点一把火：
    // 舞台会按几百毫秒的节奏问 boot.json，看到「不是 ready」就顺手 ensureStarted，
    // 那会在 npm 装包的中途再起一个进程 —— 端口打架、revision 跳两格。
    if (state.update.updating) return inflight ?? Promise.resolve(state)
    if (state.phase === 'ready') return Promise.resolve(state)
    if (inflight) return inflight

    inflight = start()
      .then(() => state)
      .catch((error) => {
        state.phase = 'failed'
        state.error = error?.message || String(error)
        killChild()
        closeGateway().catch(() => {})
        console.error('[dsh-inkos] Studio 启动失败：', state.error)
        throw error
      })
      .finally(() => {
        inflight = null
      })

    return inflight
  }

  async function restart() {
    await stopStudio()
    state.phase = 'idle'
    state.error = null
    return ensureStarted().catch(() => null)
  }

  /* ---------------- 上游自动更新 ---------------- */

  const updateStore = createStateStore(settings.updateStateFile)

  async function syncUpdateState(patch) {
    Object.assign(state.update, patch)
    try {
      await updateStore.write(patch)
    } catch {
      /* 状态写不下去不影响主流程 */
    }
  }

  /**
   * 查 → 判 → 装 → 验 → 失败回滚。
   * 整个过程里 state.phase 保持 starting/ready，舞台看到的是「正在启动」，
   * 而不是一次误报的崩溃。
   */
  async function runUpdateCheck(trigger = 'timer') {
    if (disposed) return { ok: false, reason: '插件已卸载' }
    if (!settings.autoUpdate) return { ok: false, reason: '自动更新已关闭' }
    if (state.update.updating) return { ok: false, reason: '已有更新在进行' }
    if (state.phase !== 'ready') return { ok: false, reason: 'Studio 尚未就绪，稍后再查' }

    state.update.updating = true
    let attempted = null
    let previous = null

    try {
      previous = await readDeclared(PLUGIN_ROOT)
      const latest = await checkLatest({ log })
      const verdict = decide({
        current: previous,
        latest,
        policy: settings.updatePolicy,
        badVersion: state.update.badVersion,
      })

      await syncUpdateState({
        lastCheckAt: Date.now(),
        lastResult: verdict.shouldUpdate ? 'updating' : 'up-to-date',
        lastReason: verdict.reason,
        lastError: null,
        current: previous,
      })

      if (!verdict.shouldUpdate) {
        log(`[更新] ${trigger}：${verdict.reason}`)
        return { ok: true, updated: false, reason: verdict.reason }
      }

      attempted = verdict.targetVersion
      log(`[更新] 发现新版：${verdict.reason}，开始安装`)

      // 先离开 ready：舞台会显示「正在更新」而不是一次误报的崩溃，
      // 同时 ensureStarted 的闸门（见上）会把轮询挡在外面。
      state.phase = 'starting'
      await stopStudio()
      await install(PLUGIN_ROOT, verdict.target, { log })
      verifyLayout(PLUGIN_ROOT)

      await launchStudio()
      await ensureGateway()
      state.revision += 1
      state.phase = 'ready'
      state.error = null
      state.version = attempted

      await syncUpdateState({
        lastResult: 'updated',
        lastAppliedAt: Date.now(),
        lastReason: verdict.reason,
        current: verdict.target,
        badVersion: null,
        history: [
          ...(await updateStore.read()).history,
          { at: Date.now(), from: previous['@actalk/inkos'], to: attempted, result: 'updated', trigger },
        ],
      })
      console.info(`[dsh-inkos] 已自动升级到 InkOS ${attempted}`)
      return { ok: true, updated: true, version: attempted }
    } catch (error) {
      const reason = error?.message || String(error)
      console.error('[dsh-inkos] 自动升级失败：', reason)
      log(`[更新] 失败：${reason}`)

      // 回滚：装回旧版、重新起、把这个版本记为坏版本，别反复重试
      let rolledBack = false
      if (previous && previous['@actalk/inkos']) {
        try {
          await stopStudio()
          await install(PLUGIN_ROOT, previous, { log })
          verifyLayout(PLUGIN_ROOT)
          await launchStudio()
          await ensureGateway()
          state.revision += 1
          state.phase = 'ready'
          state.error = null
          state.version = previous['@actalk/inkos']
          rolledBack = true
          console.warn(`[dsh-inkos] 已回滚到 ${previous['@actalk/inkos']}`)
        } catch (rollbackError) {
          state.phase = 'failed'
          state.error = `升级失败且回滚失败：${reason} / ${rollbackError?.message || rollbackError}`
        }
      }

      await syncUpdateState({
        lastResult: rolledBack ? 'rolled-back' : 'failed',
        lastError: reason,
        lastReason: attempted ? `尝试升级到 ${attempted} 未通过验证` : '检查更新失败',
        badVersion: rolledBack ? attempted : state.update.badVersion,
        history: [
          ...(await updateStore.read()).history,
          {
            at: Date.now(),
            from: previous?.['@actalk/inkos'] ?? null,
            to: attempted,
            result: rolledBack ? 'rolled-back' : 'failed',
            trigger,
            error: reason,
          },
        ],
      })
      return { ok: false, updated: false, error: reason, rolledBack }
    } finally {
      state.update.updating = false
    }
  }

  /** 启动后先等一会儿（别和首屏抢资源），随后按小时轮询 */
  function scheduleUpdates() {
    if (!settings.autoUpdate || updateTimer) return
    const first = setTimeout(() => {
      runUpdateCheck('startup').catch(() => {})
    }, 20_000)
    first.unref?.()

    updateTimer = setInterval(() => {
      runUpdateCheck('timer').catch(() => {})
    }, Math.max(settings.updateCheckMs, 60_000))
    updateTimer.unref?.()

    // 把首检定时器也挂上，析构时一起清
    updateTimer.firstCheck = first
  }

  async function dispose() {
    disposed = true
    if (updateTimer) {
      clearInterval(updateTimer)
      clearTimeout(updateTimer.firstCheck)
      updateTimer = null
    }
    await closeGateway()
    killChild()
    state.phase = 'idle'
  }

  /** 给舞台页看的快照：只暴露它真正需要的字段 */
  function snapshot() {
    return {
      ok: state.phase === 'ready',
      phase: state.phase,
      url: state.url,
      studioUrl: state.studioUrl,
      port: state.port,
      gatewayPort: state.gatewayPort,
      projectRoot: state.root,
      error: state.error,
      updatedAt: Date.now(),
      // 版本与 revision：客户端靠它判断「上游换了新版，该重新挂 iframe 了」
      revision: state.revision,
      version: state.version,
      update: { ...state.update },
      // 失败时带上尾部日志，省得用户去翻宿主控制台
      logs: state.phase === 'failed' ? state.logs.slice(-8) : [],
    }
  }

  return { state, ensureStarted, restart, dispose, snapshot, scheduleUpdates, runUpdateCheck, settings }
}

/* ------------------------------------------------------------------ */
/* 状态路由                                                            */
/* ------------------------------------------------------------------ */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function handleRoute(session, req, res) {
  let pathname = '/'
  try {
    pathname = new URL(req.url || '/', 'http://localhost').pathname
    // handler 挂在 prefix 上，raw url 里带着前缀
    pathname = pathname.slice(BASE_PATH.length) || '/'
  } catch {
    sendJson(res, 400, { ok: false, error: 'bad request' })
    return
  }

  try {
    if (pathname === '/boot.json' || pathname === '/health') {
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'cache-control': 'no-store' })
        res.end()
        return
      }
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      // 顺手踢一脚：页面来问状态时，若还没起来就让它起来（宿主启动预热失败时兜底）
      if (session.state.phase !== 'ready') session.ensureStarted().catch(() => {})
      sendJson(res, 200, session.snapshot())
      return
    }

    if (pathname === '/restart') {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      // 不 await：重启要十几秒，让页面先拿到「正在重启」，再自己轮询
      session.restart()
      sendJson(res, 202, { ok: true, phase: 'restarting' })
      return
    }

    // 手动触发一次上游更新检查（自动更新也会按小时自己跑）
    if (pathname === '/update') {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      // 同样不 await：装包可能几十秒，页面轮询 boot.json 就能看到进度
      session.runUpdateCheck('manual').catch(() => {})
      sendJson(res, 202, { ok: true, phase: 'checking' })
      return
    }

    sendJson(res, 404, { ok: false, error: 'not found' })
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error?.message || String(error) })
  }
}
