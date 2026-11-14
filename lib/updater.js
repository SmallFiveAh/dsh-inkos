/* ============================================================
   上游自动更新 —— 让插件跟着 InkOS 的发行版走
   ------------------------------------------------------------
   要解决的问题：插件跑的是 npm 上的 @actalk/inkos-studio。
   上游一发新版，插件不会自己变——除非有人去 npm install。

   这里做的事，按顺序：
     ① 查：npm view 拿到两个包的最新版（走 npm 自己的 registry/代理配置）
     ② 判：版本对比 + 升级策略（patch / minor / latest / off）
     ③ 装：先把 Studio 子进程停掉（Windows 会锁文件），再 npm install 精确版本
     ④ 验：真的把 Studio 起起来，探到 /api/v1/books 才算数
     ⑤ 回滚：验不过就装回旧版本、重新起、把这个版本记成「坏版本」不再重试

   为什么敢自动装：上游三个包（inkos / inkos-core / inkos-studio）是精确互相
   锁死的，必须同进同退，所以这里只接受「两个包同版本」的发行，版本不一致就跳过，
   免得装出两份 core。

   为什么不自动改插件代码：插件只依赖「dist/api/index.js 能起、前端产物在、
   /api/v1 没变」这三个假设。真变了，④ 的验证会失败并回滚——宁可用旧版，
   也不要把用户丢进一个点了没反应的入口。
   ============================================================ */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 必须同版本、同进同退的两个包 */
export const TRACKED = ['@actalk/inkos', '@actalk/inkos-studio']

const SEMVER = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/

/* ------------------------------------------------------------------ */
/* 版本比较                                                            */
/* ------------------------------------------------------------------ */

function parse(version) {
  const text = String(version || '').trim()
  const core = text.split('+')[0]
  const [main, pre] = core.split('-')
  const nums = main.split('.').map((n) => Number.parseInt(n, 10) || 0)
  while (nums.length < 3) nums.push(0)
  return { nums, pre: pre || '' }
}

/** -1 / 0 / 1，够用且不引依赖；同版本带预发布号时视为更低 */
export function compareVersion(a, b) {
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i++) {
    if (left.nums[i] !== right.nums[i]) return left.nums[i] > right.nums[i] ? 1 : -1
  }
  if (left.pre === right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1
  return left.pre > right.pre ? 1 : -1
}

/** 从 a 升到 b 属于哪一级 */
export function bumpLevel(a, b) {
  const left = parse(a).nums
  const right = parse(b).nums
  if (right[0] !== left[0]) return 'major'
  if (right[1] !== left[1]) return 'minor'
  if (right[2] !== left[2]) return 'patch'
  return null
}

/* ------------------------------------------------------------------ */
/* 决策                                                                */
/* ------------------------------------------------------------------ */

const POLICY_RANK = { patch: 1, minor: 2, major: 3, latest: 3, off: 0 }
const LEVEL_RANK = { patch: 1, minor: 2, major: 3 }

/**
 * @param {{ current: Record<string,string>, latest: Record<string,string>, policy?: string, badVersion?: string|null }} input
 * @returns {{ shouldUpdate: boolean, reason: string, targetVersion?: string, level?: string, target?: Record<string,string> }}
 */
export function decide({ current, latest, policy = 'latest', badVersion = null }) {
  if (policy === 'off') return { shouldUpdate: false, reason: '自动更新已关闭' }

  const missing = TRACKED.filter((pkg) => !current?.[pkg] || !latest?.[pkg])
  if (missing.length > 0) return { shouldUpdate: false, reason: `版本信息缺失：${missing.join(', ')}` }

  const [a, b] = TRACKED
  if (latest[a] !== latest[b]) {
    return {
      shouldUpdate: false,
      reason: `上游两个包最新版不一致（${a}@${latest[a]} / ${b}@${latest[b]}），跳过以免混装`,
    }
  }

  const targetVersion = latest[a]
  const currentVersion = current[a]

  if (compareVersion(currentVersion, targetVersion) >= 0) {
    return { shouldUpdate: false, reason: `已是最新（${currentVersion}）` }
  }
  if (badVersion && compareVersion(badVersion, targetVersion) >= 0) {
    return {
      shouldUpdate: false,
      reason: `${targetVersion} 此前升级失败并已回滚，等上游再出新版再试`,
    }
  }

  const level = bumpLevel(currentVersion, targetVersion) || 'patch'
  const allowed = POLICY_RANK[policy] ?? 3
  if (LEVEL_RANK[level] > allowed) {
    return { shouldUpdate: false, reason: `${level} 升级超出策略「${policy}」` }
  }

  return {
    shouldUpdate: true,
    reason: `${currentVersion} → ${targetVersion}（${level}）`,
    targetVersion,
    level,
    target: Object.fromEntries(TRACKED.map((pkg) => [pkg, targetVersion])),
  }
}

/* ------------------------------------------------------------------ */
/* 包管理器                                                            */
/* ------------------------------------------------------------------ */

let resolvedManager = null

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (c) => {
      stdout += String(c)
    })
    child.stderr?.on('data', (c) => {
      stderr += String(c)
    })

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }, options.timeoutMs ?? 120_000)

    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, code: null, stdout, stderr: `${stderr}${error.message}` })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, stdout, stderr })
    })
  })
}

/** npm 优先（用户就是用它装的），没有就退回 pnpm */
async function resolveManager(log) {
  if (resolvedManager) return resolvedManager
  const candidates = process.platform === 'win32' ? ['npm.cmd', 'pnpm.cmd'] : ['npm', 'pnpm']
  for (const cmd of candidates) {
    const probe = await run(cmd, ['--version'], { timeoutMs: 15_000 })
    if (probe.ok) {
      resolvedManager = {
        cmd,
        kind: cmd.startsWith('npm') ? 'npm' : 'pnpm',
        version: (probe.stdout.match(SEMVER) || ['?'])[0],
      }
      log?.(`自动更新使用 ${cmd} ${resolvedManager.version}`)
      return resolvedManager
    }
  }
  return null
}

/* ------------------------------------------------------------------ */
/* 查最新版                                                            */
/* ------------------------------------------------------------------ */

export async function checkLatest({ log, timeoutMs = 45_000 } = {}) {
  const manager = await resolveManager(log)
  if (!manager) throw new Error('找不到 npm 或 pnpm，无法检查更新')

  const latest = {}
  for (const pkg of TRACKED) {
    const args =
      manager.kind === 'npm' ? ['view', `${pkg}@latest`, 'version'] : ['view', `${pkg}@latest`, 'version']
    const result = await run(manager.cmd, args, { timeoutMs })
    if (!result.ok) {
      throw new Error(`查询 ${pkg} 失败：${(result.stderr || result.stdout).trim().slice(0, 200)}`)
    }
    const found = (result.stdout.match(new RegExp(SEMVER.source, 'g')) || []).pop()
    if (!found) throw new Error(`查询 ${pkg} 没有拿到版本号`)
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(found)) throw new Error(`${pkg} 版本号异常：${found}`)
    latest[pkg] = found
  }
  return latest
}

/* ------------------------------------------------------------------ */
/* 安装                                                                */
/* ------------------------------------------------------------------ */

export async function install(pluginRoot, target, { log, timeoutMs = 300_000 } = {}) {
  const manager = await resolveManager(log)
  if (!manager) throw new Error('找不到 npm 或 pnpm，无法安装更新')

  // 版本号会被拼进 shell 命令行，先按 semver 形状校验一遍（只可能是数字/点/连字符）
  const STRICT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/
  for (const pkg of TRACKED) {
    if (!STRICT.test(String(target[pkg] || ''))) throw new Error(`版本号不合法：${target[pkg]}`)
  }

  const specs = TRACKED.map((pkg) => `${pkg}@${target[pkg]}`)
  const args =
    manager.kind === 'npm'
      ? ['install', ...specs, '--save-exact', '--no-audit', '--no-fund']
      : ['add', ...specs, '--save-exact']

  log?.(`开始安装 ${specs.join(' ')}`)
  const result = await run(manager.cmd, args, { cwd: pluginRoot, timeoutMs })
  if (!result.ok) {
    throw new Error(`安装失败（${manager.cmd}）：${(result.stderr || result.stdout).trim().slice(-300)}`)
  }
  log?.(`安装完成：${specs.join(' ')}`)
}

/** 装完先做最便宜的体检：入口文件在不在、前端产物在不在 */
export function verifyLayout(pluginRoot) {
  const studio = join(pluginRoot, 'node_modules', '@actalk', 'inkos-studio', 'dist')
  const required = [join(studio, 'api', 'index.js'), join(studio, 'index.html')]
  const missing = required.filter((path) => !existsSync(path))
  if (missing.length > 0) throw new Error(`新版缺少必要文件：${missing.join(', ')}`)
}

/** 读插件自己声明的版本（也就是当前生效的版本） */
export async function readDeclared(pluginRoot) {
  const manifest = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'))
  const out = {}
  for (const pkg of TRACKED) {
    const value = manifest.dependencies?.[pkg]
    out[pkg] = typeof value === 'string' ? value.replace(/^[~^]/, '') : null
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 状态文件                                                            */
/* ------------------------------------------------------------------ */

const EMPTY_STATE = {
  lastCheckAt: null,
  lastResult: null, // updated | up-to-date | skipped | rolled-back | failed
  lastReason: null,
  lastError: null,
  badVersion: null,
  current: null,
  lastAppliedAt: null,
  history: [],
}

export function createStateStore(file) {
  return {
    file,
    async read() {
      try {
        return { ...EMPTY_STATE, ...JSON.parse(await readFile(file, 'utf8')) }
      } catch {
        return { ...EMPTY_STATE }
      }
    },
    async write(patch) {
      const current = await this.read()
      const next = { ...current, ...patch, history: (patch.history ?? current.history).slice(-20) }
      try {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, JSON.stringify(next, null, 2), 'utf8')
      } catch {
        /* 状态写不下去不影响主流程 */
      }
      return next
    },
  }
}
