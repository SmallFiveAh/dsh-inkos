/* ============================================================
   只读检查：现在跑的是哪版、npm 上是哪版、会不会自动升
   ------------------------------------------------------------
   不改任何东西，适合升级前先看一眼。
   ============================================================ */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkLatest, createStateStore, decide, readDeclared } from '../lib/updater.js'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stateFile = join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'inkos', 'updater.json')

const current = await readDeclared(PLUGIN_ROOT)
const state = await createStateStore(stateFile).read()

console.log('dsh-inkos · 上游版本状态\n')
console.log(`  当前：@actalk/inkos ${current['@actalk/inkos']} / @actalk/inkos-studio ${current['@actalk/inkos-studio']}`)

try {
  const latest = await checkLatest({})
  console.log(`  最新：@actalk/inkos ${latest['@actalk/inkos']} / @actalk/inkos-studio ${latest['@actalk/inkos-studio']}`)

  const verdict = decide({ current, latest, policy: 'latest', badVersion: state.badVersion })
  console.log(`  判定：${verdict.shouldUpdate ? `可升级 → ${verdict.targetVersion}（${verdict.level}）` : verdict.reason}`)
} catch (error) {
  console.log(`  最新：查询失败（${error?.message || error}）`)
}

if (state.lastCheckAt) {
  console.log(`  上次检查：${new Date(state.lastCheckAt).toLocaleString()} · ${state.lastResult || '-'}`)
  if (state.lastReason) console.log(`  说明：${state.lastReason}`)
  if (state.badVersion) console.log(`  已回滚过的版本：${state.badVersion}`)
}
if (state.lastError) console.log(`  最近错误：${state.lastError}`)
