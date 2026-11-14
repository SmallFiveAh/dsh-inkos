/* ============================================================
   本地网关 —— 一进一出，只干两件「让首屏别卡住」的事
   ------------------------------------------------------------
   为什么需要它：

   InkOS Studio 的构建产物 CSS 第一行是一条外链字体导入：
       @import "https://fonts.googleapis.com/css2?family=Instrument+Serif...";
   浏览器必须先取到它才能渲染首屏。在取不到 Google Fonts 的网络里
   （国内直连/受限代理），这条请求会一直挂到超时——实测 30 秒，
   期间整个 Studio 是白屏，我们的加载遮罩也就跟着转 30 秒。

   它同时还是「渲染阻塞」资源：DOMContentLoaded 都被它拖住了，
   所以光把遮罩去掉没用，页面本身就是白的。

   处理办法：把 Studio 原样放在网关后面（同一个 origin、路径 1:1 透传），
   网关只对两类响应做最小干预：
     · text/css  —— 摘掉指向外部主机的 @import（本地/相对地址保留）
     · text/html —— 加一条只约束样式与字体的 CSP，防止将来又冒出外链
   其余一切都原封不动地流过去（包括 SSE /api/v1/events）。

   之所以另开一个端口而不是挂在 DSH 的路径前缀下：
   Studio 是 Vite 构建的 SPA，index.html 里写的是 /assets/... 绝对路径。
   挂在 /dsh-inkos/app/ 下这些路径都会打回 DSH 根，必须改写资源路径；
   而让它独占一个 origin 的根，所有路径天然对得上，一行都不用改。
   ============================================================ */

import http from 'node:http'

/**
 * 外部（非本机）@import。
 *
 * 注意：Google Fonts 的 CSS2 地址里本身就带分号
 * （`family=Instrument+Serif:ital@0;1&…`），所以绝不能用 `[^;]*` 去截断——
 * 那样只会切掉一半，剩下的碎片会让整份样式表失效（页面变成无样式的裸 HTML）。
 * 这里按「引号 / 右括号」作为边界，分号只用来收尾。
 */
const EXTERNAL_IMPORTS = [
  // @import url("https://…");
  /@import\s*url\(\s*["']?https?:\/\/(?!127\.0\.0\.1|localhost)[^)]*["']?\s*\)\s*;/gi,
  // @import "https://…";
  /@import\s*["']https?:\/\/(?!127\.0\.0\.1|localhost)[^"']*["']\s*;/gi,
]

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/**
 * 启动网关。
 *
 * 端口一经分配就不再变：自动更新会重启上游 Studio（换端口），
 * 但舞台里的 iframe 地址保持原样——reload 一下就是新版本，
 * 不会因为换了端口变成一张错误页。
 *
 * @param {number} targetPort 上游 Studio 的端口
 * @param {{ blockExternalAssets?: boolean }} options
 * @returns {Promise<{ port: number, url: string, setTarget: (port: number) => void, close: () => Promise<void> }>}
 */
export async function startGateway(targetPort, options = {}) {
  const block = options.blockExternalAssets !== false
  const upstreamState = { port: targetPort }

  const server = http.createServer((req, res) => {
    forward(upstreamState.port, req, res, block)
  })
  server.on('clientError', (_error, socket) => {
    try {
      socket.destroy()
    } catch {
      /* ignore */
    }
  })

  const port = await new Promise((res, rej) => {
    server.once('error', rej)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      res(typeof addr === 'object' && addr ? addr.port : 0)
    })
  })

  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    setTarget(nextPort) {
      upstreamState.port = nextPort
    },
    close: () =>
      new Promise((done) => {
        server.closeAllConnections?.()
        server.close(() => done())
      }),
  }
}

function forward(targetPort, req, res, block) {
  const headers = { ...req.headers, host: `127.0.0.1:${targetPort}` }

  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: targetPort,
      method: req.method,
      path: req.url,
      headers,
    },
    (up) => {
      const type = String(up.headers['content-type'] || '').toLowerCase()
      const encoding = String(up.headers['content-encoding'] || '').toLowerCase()
      const plain = !encoding || encoding === 'identity'

      // SSE 等长连接：纯流式，绝不能缓冲
      if (type.includes('text/event-stream')) {
        res.writeHead(up.statusCode || 200, collect(up))
        up.pipe(res)
        return
      }

      if (block && plain && type.includes('text/css')) {
        stripExternalImports(up, res)
        return
      }

      if (block && type.includes('text/html')) {
        res.writeHead(up.statusCode || 200, {
          ...collect(up),
          // 只约束样式与字体；不设 default-src，图片/脚本一如既往不受限
          'content-security-policy': "style-src 'self' 'unsafe-inline' data:; font-src 'self' data:",
          // 升级后会换一套新的 hashed 资源，入口 HTML 绝不能吃旧缓存
          'cache-control': 'no-store',
        })
        up.pipe(res)
        return
      }

      res.writeHead(up.statusCode || 200, collect(up))
      up.pipe(res)
    },
  )

  upstream.on('error', (error) => {
    if (res.headersSent) {
      res.end()
      return
    }
    const body = `InkOS gateway: 无法连接上游 Studio（${error?.message || error}）`
    res.writeHead(502, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    res.end(body)
  })

  req.pipe(upstream)
}

function collect(up) {
  const out = {}
  for (const [key, value] of Object.entries(up.headers)) {
    if (!HOP_BY_HOP.has(key)) out[key] = value
  }
  out['x-dsh-inkos-gateway'] = '1'
  return out
}

/** 纯函数：摘掉外部 @import。导出是为了能被自检直接测到。 */
export function rewriteCss(text) {
  let out = text
  for (const pattern of EXTERNAL_IMPORTS) out = out.replace(pattern, '')
  return out
}

/** 摘掉外部 @import 后重算 content-length——否则浏览器按旧长度截断 */
function stripExternalImports(up, res) {
  const chunks = []
  up.on('data', (chunk) => chunks.push(chunk))
  up.on('end', () => {
    const body = Buffer.from(rewriteCss(Buffer.concat(chunks).toString('utf8')), 'utf8')
    res.writeHead(up.statusCode || 200, {
      ...collect(up),
      'content-length': String(body.length),
      // 改过内容就别让浏览器复用旧缓存
      'cache-control': 'no-store',
    })
    res.end(body)
  })
  up.on('error', () => res.destroy())
}
