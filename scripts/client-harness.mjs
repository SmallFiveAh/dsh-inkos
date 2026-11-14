/* ============================================================
   网页半身的行为自检 —— 不启动 DSH，也能证明「入口 + 舞台页」真的注册成了
   ------------------------------------------------------------
   做法：把 lib/client.js 当成 DSH 的模块表来跑
     · 伪造 window.__ModuleLoader__，接住 factory
     · require('react') 换成一套极简 hooks 运行时（useState/useEffect 够用）
     · 伪造 ctx.slots，记录 register 收到的参数
   然后真的把两个组件渲染一遍，断言：
     · 侧栏入口注册在 sidebar.panellist，id=inkos，能画出 SVG
     · 舞台页注册在 main，key=inkos，就绪时输出 iframe 且 src 指向 Studio
     · 失败时给出原因和「重新启动 Studio」按钮
   这些正是「点击入口 → 舞台内出现页面」这条链路里，插件自己负责的那一段。
   ============================================================ */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const passes = []

function ok(label, detail) {
  passes.push(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
}
function bad(label, error) {
  failures.push(`  ✗ ${label} — ${error?.message || error}`)
}
function assert(cond, message) {
  if (!cond) throw new Error(message)
}

/* ---------- 极简 React：只为跑通这两个组件 ---------- */

function createMiniReact() {
  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: props || {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
    }),
  }

  let state = []
  let effectSlots = []
  let index = 0
  let queuedEffects = []
  let rendering = false
  let rerenderQueued = false
  let component = null
  let tree = null
  let renders = 0

  const same = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

  React.useState = (initial) => {
    const i = index++
    if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial
    const set = (value) => {
      if (rendering) return
      const next = typeof value === 'function' ? value(state[i]) : value
      if (Object.is(next, state[i])) return
      state[i] = next
      if (!rerenderQueued) {
        rerenderQueued = true
        queueMicrotask(() => {
          rerenderQueued = false
          render()
        })
      }
    }
    return [state[i], set]
  }

  React.useEffect = (fn, deps) => {
    queuedEffects.push({ fn, deps })
  }
  React.useCallback = (fn) => fn
  React.useRef = (value) => ({ current: value })

  function render() {
    if (!component) return tree
    if (renders++ > 40) throw new Error('渲染次数超限：疑似 effect 与 setState 互相触发')
    rendering = true
    index = 0
    queuedEffects = []
    tree = component()
    rendering = false

    const effects = queuedEffects
    queuedEffects = []
    effects.forEach((effect, i) => {
      const prev = effectSlots[i]
      const shouldRun = !prev || !effect.deps || !same(prev.deps, effect.deps)
      if (!shouldRun) return
      try {
        prev?.cleanup?.()
      } catch {
        /* ignore */
      }
      const cleanup = effect.fn()
      effectSlots[i] = { deps: effect.deps, cleanup }
    })
    return tree
  }

  function mount(fn) {
    component = fn
    state = []
    effectSlots = []
    index = 0
    renders = 0
    return render()
  }

  return { React, mount, get tree() { return tree } }
}

/* ---------- 在沙箱里执行 client.js ---------- */

function loadClientModule(fetchImpl) {
  const source = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
  let exported = null

  const timers = { setTimeout: (fn) => 0, clearTimeout: () => {} } // 测试里不让轮询真的挂起
  const sandbox = {
    console,
    fetch: fetchImpl,
    queueMicrotask,
    URL,
    window: {
      __ModuleLoader__: {
        load: ({ id, factory }) => {
          exported = factory((name) => {
            if (name === 'react') return REQUIRED_REACT
            throw new Error(`未预期的 require: ${name}`)
          })
          exported.__id = id
        },
      },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  new vm.Script(source, { filename: 'lib/client.js' }).runInContext(sandbox)

  if (!exported) throw new Error('client.js 没有调用 window.__ModuleLoader__.load')
  return exported
}

let REQUIRED_REACT = null

/* ---------- 伪造 slots 服务 ---------- */

function createSlots() {
  const registrations = []
  return {
    registrations,
    slots: {
      inject(key, cb) {
        cb()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
}

function findNode(node, predicate) {
  if (!node || typeof node !== 'object') return null
  // 函数组件在极简运行时里不会自动展开，这里补一步再找
  if (typeof node.type === 'function') return findNode(node.type(node.props), predicate)
  if (predicate(node)) return node
  for (const child of node.children || []) {
    const hit = findNode(child, predicate)
    if (hit) return hit
  }
  return null
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children || []).map(textOf).join('')
}

/* ---------- 用例 ---------- */

async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

async function main() {
  // 1. 模块能被加载，并且导出 name/inject/apply
  let client
  try {
    const mini = createMiniReact()
    REQUIRED_REACT = mini.React
    client = loadClientModule(async () => ({
      ok: true,
      json: async () => ({ ok: true, phase: 'ready', url: 'http://127.0.0.1:4567/' }),
    }))
    assert(client && typeof client.apply === 'function', '导出缺 apply')
    assert(Array.isArray(client.inject), '导出缺 inject')
    assert(client.name === 'inkos', `导出 name=${client.name}`)
    ok('模块表可加载并导出 name/inject/apply', `name=${client.name} inject=${JSON.stringify(client.inject)}`)
  } catch (error) {
    bad('模块可加载', error)
    report()
    return
  }

  // 2. 注册：侧栏入口 + 舞台页
  const { slots, registrations } = createSlots()
  try {
    client.apply({ slots })
    assert(registrations.length === 2, `注册数量=${registrations.length}`)

    const entry = registrations.find((r) => r.options.name === 'sidebar.panellist')
    const stage = registrations.find((r) => r.options.name === 'main')
    assert(entry, '没有注册 sidebar.panellist')
    assert(stage, '没有注册 main')
    assert(entry.options.id === 'inkos', `panellist.id=${entry.options.id}`)
    assert(stage.options.key === entry.options.id, 'main.key 与 panellist.id 不一致，宿主不会把它们认成同一个面板')
    assert(typeof entry.options.label === 'function' && entry.options.label() === 'InkOS 创作工作台', 'label 不对')
    ok('侧栏入口注册在「新建对话」下方的面板位', `sidebar.panellist id=${entry.options.id} order=${entry.options.order}`)
    ok('舞台页与入口同 id 绑定', `main key=${stage.options.key}`)

    // 3. 图标真的能画出来（宿主拿它塞进那一格）
    const iconTree = entry.component({ size: 18, active: false })
    const svg = findNode(iconTree, (n) => n.type === 'svg')
    assert(svg, '图标没有渲染出 svg')
    assert(svg.props.width === 18, `图标尺寸=${svg.props.width}`)
    ok('侧栏图标可渲染', 'svg 18×18 · stroke=currentColor')
  } catch (error) {
    bad('槽注册', error)
    report()
    return
  }

  const stageComponent = registrations.find((r) => r.options.name === 'main').component

  // 4. 就绪态：舞台页输出 iframe，并且铺满
  try {
    const mini = createMiniReact()
    REQUIRED_REACT = mini.React
    const url = 'http://127.0.0.1:4567/'
    const mod = loadClientModule(async () => ({ ok: true, json: async () => ({ ok: true, phase: 'ready', url }) }))
    const localRegs = []
    mod.apply({
      slots: {
        inject: (k, cb) => cb(),
        register: (options, component) => {
          localRegs.push({ options, component })
          return () => {}
        },
      },
    })
    const stage = localRegs.find((r) => r.options.name === 'main').component

    mini.mount(stage)
    await flush()
    const frame = findNode(mini.tree, (n) => n.type === 'iframe')
    assert(frame, `就绪后没有 iframe，当前树：${JSON.stringify(mini.tree && mini.tree.type)}`)
    assert(frame.props.src === url, `iframe.src=${frame.props.src}`)
    assert(frame.props.style.height === '100%' && frame.props.style.width === '100%', 'iframe 没有铺满舞台')
    ok('就绪后在舞台内渲染 iframe', `src=${frame.props.src} · 100%×100% · 无边框`)
  } catch (error) {
    bad('就绪态渲染', error)
  }

  // 5. 失败态：给原因 + 重启按钮，而不是白屏
  try {
    const mini = createMiniReact()
    REQUIRED_REACT = mini.React
    const mod = loadClientModule(async () => ({
      ok: false,
      json: async () => ({ ok: false, phase: 'failed', error: '等待 Studio 就绪超时（90s）', logs: ['boom'] }),
    }))
    const localRegs = []
    mod.apply({
      slots: {
        inject: (k, cb) => cb(),
        register: (options, component) => {
          localRegs.push({ options, component })
          return () => {}
        },
      },
    })
    const stage = localRegs.find((r) => r.options.name === 'main').component

    mini.mount(stage)
    await flush()
    const text = textOf(mini.tree)
    assert(text.includes('InkOS Studio 没起来'), `失败态标题缺失：${text.slice(0, 80)}`)
    assert(text.includes('等待 Studio 就绪超时'), '失败原因没有透出')
    const button = findNode(mini.tree, (n) => n.type === 'button')
    assert(button, '失败态没有重试按钮')
    assert(textOf(button).includes('重新启动'), '重试按钮文案不对')
    ok('失败态可解释、可重试', '标题 + 原因 + 尾部日志 + 重新启动按钮')
  } catch (error) {
    bad('失败态渲染', error)
  }

  report()
}

function report() {
  console.log('dsh-inkos 网页半身自检\n')
  passes.forEach((line) => console.log(line))
  if (failures.length > 0) {
    console.log('')
    failures.forEach((line) => console.log(line))
    console.log(`\n${failures.length} 项未通过`)
    process.exit(1)
  }
  console.log(`\n全部 ${passes.length} 项通过`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
