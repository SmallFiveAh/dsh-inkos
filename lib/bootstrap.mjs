/* ============================================================
   项目引导脚本 —— 在独立子进程里跑官方初始化
   ------------------------------------------------------------
   调的是 @actalk/inkos 里 project-bootstrap.js 的
   ensureProjectDirectoryInitialized()，与用户手敲 `inkos init` 是同一份实现：
   写入 inkos.json、books/、radar/、.env、.gitignore 等。

   为什么单独开一个进程：
   inkos 的 bootstrap 会连带加载 inkos-core（SQLite、LLM 客户端、几百个模块）。
   这些东西不该出现在宿主的模块图里，跑完即走最干净。

   用法：node bootstrap.mjs <bootstrap-entry.mjs> <projectRoot> <zh|en>
   ============================================================ */

import { pathToFileURL } from 'node:url'

const [, , entry, projectRoot, languageArg] = process.argv

if (!entry || !projectRoot) {
  console.error('bootstrap.mjs 需要两个参数：<bootstrap-entry> <projectRoot>')
  process.exit(2)
}

const language = languageArg === 'en' ? 'en' : 'zh'

try {
  const mod = await import(pathToFileURL(entry).href)
  if (typeof mod.ensureProjectDirectoryInitialized !== 'function') {
    throw new Error('官方 project-bootstrap 未导出 ensureProjectDirectoryInitialized')
  }
  const created = await mod.ensureProjectDirectoryInitialized(projectRoot, { language })
  console.log(created ? `created ${projectRoot}` : `exists ${projectRoot}`)
  process.exit(0)
} catch (error) {
  console.error(error?.stack || String(error))
  process.exit(1)
}
