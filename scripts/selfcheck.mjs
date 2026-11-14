/* ============================================================
   静态自检 —— 检查 DSH 插件最容易「装了没反应」的那几个点
   ------------------------------------------------------------
   DSH 的加载器对清单错误非常安静：name 写错只打一条 warn 然后跳过，
   client 入口没声明就根本不加载网页半边，人看到的只是「按钮没出来」。
   所以这些字段必须机器校验，不能靠肉眼。
   ============================================================ */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const checks = []

function check(label, fn) {
  try {
    const detail = fn()
    checks.push(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    failures.push(`  ✗ ${label} — ${error.message}`)
  }
}

async function checkAsync(label, fn) {
  try {
    const detail = await fn()
    checks.push(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    failures.push(`  ✗ ${label} — ${error.message}`)
  }
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

check('package.json 有 dsh 清单', () => {
  if (!pkg.dsh) throw new Error('缺少 dsh 字段')
  return `工程 ${pkg.name}@${pkg.version}`
})

check('dsh.bundle.patch 指向真实文件', () => {
  const patch = pkg.dsh?.bundle?.patch
  if (!patch) throw new Error('缺少 dsh.bundle.patch')
  if (!existsSync(join(ROOT, patch))) throw new Error(`${patch} 不存在`)
  return patch
})

check('patch 里的 name 与包名一致（否则加载器只告警并跳过）', () => {
  const patchText = readFileSync(join(ROOT, pkg.dsh.bundle.patch), 'utf8')
  const names = [...patchText.matchAll(/^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map((m) => m[1])
  if (names.length === 0) throw new Error('patch 里没有 name 行')
  if (!names.includes(pkg.name)) throw new Error(`patch name=${names.join(',')} ≠ ${pkg.name}`)
  return `${pkg.name} 已挂载`
})

check('dsh.client 声明 web 平台与 client 导出', () => {
  const client = pkg.dsh?.client
  if (!client) throw new Error('缺少 dsh.client')
  if (client.platform !== 'web') throw new Error(`platform=${client.platform}`)
  const entry = pkg.exports?.['./client']
  if (!entry) throw new Error('exports["./client"] 缺失')
  if (!existsSync(join(ROOT, entry))) throw new Error(`${entry} 不存在`)
  return `${entry} · inject=${JSON.stringify(client.inject || [])}`
})

check('client 入口声明 immediately（宿主启动即加载，入口才会自动出现）', () => {
  if (pkg.dsh?.client?.immediately !== true) throw new Error('immediately 不是 true')
  return 'immediately: true'
})

check('main 指向宿主入口', () => {
  if (!pkg.main) throw new Error('缺少 main')
  if (!existsSync(join(ROOT, pkg.main))) throw new Error(`${pkg.main} 不存在`)
  return pkg.main
})

check('宿主/网页两半语法可解析', () => {
  for (const file of ['lib/host.js', 'lib/client.js', 'lib/bootstrap.mjs', 'lib/gateway.js', 'lib/updater.js']) {
    execFileSync(process.execPath, ['--check', join(ROOT, file)], { stdio: 'pipe' })
  }
  return 'host / client / bootstrap / gateway / updater'
})

check('两半的路由前缀保持一致', () => {
  const host = readFileSync(join(ROOT, 'lib/host.js'), 'utf8')
  const client = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
  const hostBase = host.match(/const BASE_PATH = '([^']+)'/)?.[1]
  const clientBase = client.match(/const BASE = '([^']+)'/)?.[1]
  if (!hostBase || !clientBase) throw new Error('没找到前缀常量')
  if (hostBase !== clientBase) throw new Error(`host=${hostBase} client=${clientBase}`)
  return hostBase
})

await checkAsync('上游更新的版本判定', async () => {
  const { compareVersion, bumpLevel, decide } = await import('../lib/updater.js')

  if (compareVersion('1.8.0', '1.7.2') !== 1) throw new Error('1.8.0 应大于 1.7.2')
  if (compareVersion('1.8.0', '1.8.0') !== 0) throw new Error('同版本应为 0')
  if (compareVersion('1.8.0-canary.56.1', '1.8.0') !== -1) throw new Error('预发布版应小于正式版')
  if (bumpLevel('1.7.2', '1.8.0') !== 'minor') throw new Error('1.7.2→1.8.0 应为 minor')
  if (bumpLevel('1.8.0', '2.0.0') !== 'major') throw new Error('1.8.0→2.0.0 应为 major')

  const cur = { '@actalk/inkos': '1.8.0', '@actalk/inkos-studio': '1.8.0' }
  const newer = { '@actalk/inkos': '1.9.0', '@actalk/inkos-studio': '1.9.0' }

  if (decide({ current: cur, latest: cur }).shouldUpdate) throw new Error('同版本不该更新')
  const go = decide({ current: cur, latest: newer, policy: 'latest' })
  if (!go.shouldUpdate || go.targetVersion !== '1.9.0') throw new Error('应判定为可更新到 1.9.0')
  if (go.target['@actalk/inkos-studio'] !== '1.9.0') throw new Error('两个包必须同步升级')

  const minorOnly = decide({
    current: cur,
    latest: { '@actalk/inkos': '2.0.0', '@actalk/inkos-studio': '2.0.0' },
    policy: 'minor',
  })
  if (minorOnly.shouldUpdate) throw new Error('minor 策略不该跨大版本')

  const mixed = decide({
    current: cur,
    latest: { '@actalk/inkos': '1.9.0', '@actalk/inkos-studio': '1.8.5' },
  })
  if (mixed.shouldUpdate) throw new Error('两包版本不一致时必须跳过，避免混装')

  const bad = decide({ current: cur, latest: newer, policy: 'latest', badVersion: '1.9.0' })
  if (bad.shouldUpdate) throw new Error('回滚过的版本不该反复重试')

  if (decide({ current: cur, latest: newer, policy: 'off' }).shouldUpdate) {
    throw new Error('off 策略不该更新')
  }

  return '比较 / 分级 / 策略 / 混装拦截 / 坏版本拦截 均正确'
})

check('网关端口在重启后可复用（舞台地址不变）', () => {
  const gateway = readFileSync(join(ROOT, 'lib/gateway.js'), 'utf8')
  if (!/setTarget\s*:/.test(gateway)) throw new Error('网关没有导出 setTarget，重启就会换端口')
  const host = readFileSync(join(ROOT, 'lib/host.js'), 'utf8')
  if (!/state\.gateway\.setTarget\(/.test(host)) {
    throw new Error('宿主重启时没有把网关指向新端口，舞台地址会失效')
  }
  return 'setTarget + 端口固定'
})

check('依赖已安装', () => {
  const require_ = join(ROOT, 'node_modules', '@actalk')
  if (!existsSync(require_)) throw new Error('缺 node_modules/@actalk，请先 npm install')
  return '@actalk/inkos + @actalk/inkos-studio'
})

/**
 * 网关改写的回归测试。
 * 曾经踩过：Google Fonts 的 URL 自带分号（`ital@0;1`），按分号截断只删掉一半，
 * 余下的碎片让整份样式表失效 —— 页面变成无样式的裸 HTML，且看不出报错。
 * 所以这里既验「删掉了外链」，也验「没删坏别的东西」。
 */
await checkAsync('CSS 改写只摘外链、不伤样式', async () => {
  const { rewriteCss } = await import('../lib/gateway.js')
  const distDir = join(ROOT, 'node_modules', '@actalk', 'inkos-studio', 'dist')
  const html = readFileSync(join(distDir, 'index.html'), 'utf8')
  // 认准入口页真正加载的那份样式表（assets 里还有一堆按需 chunk 的 css）
  const href = html.match(/href="(\/assets\/[^"]+\.css)"/)?.[1]
  if (!href) throw new Error('index.html 里找不到主样式表')
  const file = href.replace('/assets/', '')
  if (!readdirSync(join(distDir, 'assets')).includes(file)) throw new Error(`${file} 不存在`)

  const source = readFileSync(join(distDir, 'assets', file), 'utf8')
  const out = rewriteCss(source)
  const removed = source.length - out.length

  if (!source.includes('googleapis.com')) throw new Error('样例里本来就没有外链，测试失去意义')
  if (out.includes('googleapis.com')) throw new Error('外链字体没删干净')
  if (/@import/.test(out)) throw new Error('仍有 @import 残留')
  if (!out.includes('--font-sans')) throw new Error('Tailwind 变量被删坏了，样式表会失效')
  if (!out.startsWith('/*!') && !out.startsWith('@layer')) {
    throw new Error(`改写后开头是碎片：${JSON.stringify(out.slice(0, 40))}`)
  }
  if (removed > 400 || removed < 50) throw new Error(`删除长度异常（${removed} 字节）`)

  return `移除 ${removed} 字节，${file} 完整`
})

console.log('dsh-inkos 静态自检\n')
checks.forEach((line) => console.log(line))

if (failures.length > 0) {
  console.log('')
  failures.forEach((line) => console.log(line))
  console.log(`\n${failures.length} 项未通过`)
  process.exit(1)
}

console.log(`\n全部 ${checks.length} 项通过`)
