import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let socket
let sequence = 0
const pending = new Map()
const errors = []
const failed = []
const overall = setTimeout(() => { console.error('Inspection timed out; close the diagnostic application.'); process.exit(1) }, 45000)
function send(method, params = {}) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP command timed out: ' + method)) }, 10000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (response.exceptionDetails) throw new Error('Renderer evaluation failed')
  return response.result.value
}
try {
  let target
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:9224/json/list', { signal: AbortSignal.timeout(1000) })
      const targets = await response.json()
      target = targets.find((item) => item.type === 'page' && item.url.startsWith('https://proyectox.local'))
      if (target) break
    } catch {}
    await delay(250)
  }
  if (!target) throw new Error('No diagnostic WebView page available')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const request = pending.get(message.id)
      pending.delete(message.id)
      clearTimeout(request.timer)
      if (message.error) request.reject(new Error(message.error.message))
      else request.resolve(message.result)
    } else if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.text)
    } else if (message.method === 'Network.loadingFailed') {
      failed.push(message.params.errorText)
    }
  })
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Network.enable')
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await evaluate('!!document.querySelector(".sidebar")')) break
    await delay(250)
  }
  const initial = await evaluate(`({ sidebar:!!document.querySelector('.sidebar'), nav:Array.from(document.querySelectorAll('.nav-links a')).map(a=>a.getAttribute('href')), error:!!document.getElementById('desktop-connection-error'), font:getComputedStyle(document.body).fontFamily })`)
  if (!initial.sidebar || initial.error || initial.nav.length < 9) throw new Error('Original UI did not mount: ' + JSON.stringify(initial))
  // Complete the existing first-use tutorial in the isolated diagnostic browser profile.
  // This changes only a UI preference, never business data.
  for (let step = 0; step < 4; step++) {
    if (!await evaluate(`!!document.querySelector('.onboarding-overlay')`)) break
    await evaluate(`document.querySelector('.onboarding-footer .btn-primary')?.click()`)
    await delay(300)
  }
  await delay(1500)
  const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true })
  await fs.writeFile(path.join(root, 'artifacts', 'ui-original.png'), Buffer.from(screenshot.data, 'base64'))
  const routes = ['/buscar', '/candidatos', '/enterprise/dashboard', '/enterprise/outbox', '/enterprise/rbac', '/enterprise/hire-tools', '/enterprise/audit', '/enterprise/reports']
  const checked = []
  for (const route of routes) {
    await evaluate(`location.hash = ${JSON.stringify('#' + route)}`)
    await delay(500)
    const result = await evaluate(`({ hash:location.hash, sidebar:!!document.querySelector('.sidebar'), error:!!document.getElementById('desktop-connection-error'), content:!!document.querySelector('.content'), panels:Array.from(document.querySelectorAll('.content [role="alert"],.content .banner.error')).map(e=>e.textContent.trim()) })`)
    if (result.hash !== '#' + route || !result.sidebar || result.error || !result.content || result.panels.length) throw new Error('Route failed: ' + route)
    checked.push(route)
  }
  await evaluate("location.hash = '#/'")
  await delay(500)
  console.log(JSON.stringify({ originalSidebar: true, navigationLinks: initial.nav.length, routes: checked, font: initial.font, runtimeErrors: errors, failedRequests: failed, screenshot: 'desktop/artifacts/ui-original.png' }, null, 2))
  if (errors.length || failed.length) throw new Error('Renderer errors or resource failures detected')
} finally {
  // Close only this application instance through its trusted bridge, not other processes.
  if (socket?.readyState === WebSocket.OPEN) {
    try { await evaluate(`window.chrome.webview.postMessage({id:crypto.randomUUID(),operation:'closeApplication',payload:{}})`) } catch {}
    socket.close()
  }
  for (const request of pending.values()) clearTimeout(request.timer)
  clearTimeout(overall)
}
