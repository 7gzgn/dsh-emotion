import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

// 数据跟主插件同一套：$DSH_HOME 或 ~/.dsh（别人机器上没有 D:\dsh）。
const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
const DEFS = process.env.EMOTION_DEFS || path.join(DSH_HOME, 'emotions.json')
const STATE = process.env.EMOTION_STATE || path.join(DSH_HOME, 'emotion-state.json')
// 面板 HTML 跟着插件走（assets/panel.html），不再依赖 D:\dsh\tools
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''))
const HTML = path.join(HERE, '..', 'assets', 'panel.html')
const PORT = Number(process.env.EMOTION_PORT || 7799)

function load(p, fb) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fb }
}
function save(p, v) {
  fs.writeFileSync(p, JSON.stringify(v, null, 2))
}
function emptyDefs() {
  return { version: 1, axes: [], combos: [], rules: [], events: [], links: [] }
}
function snapshot() {
  const defs = load(DEFS, emptyDefs())
  const st = load(STATE, { axes: {} })
  const vals = st.axes ?? {}
  return {
    empty: (defs.axes ?? []).length === 0,
    axes: (defs.axes ?? []).map((a) => ({
      key: a.key,
      zh: a.zh ?? a.key,
      tag: a.tag ?? '',
      value: Math.round(Number(vals[a.key] ?? a.value ?? 0)),
      rate: Number(a.rate ?? 0),
      decay: Number(a.decay ?? 0),
      polarity: a.polarity === 'pos' || a.polarity === 'neg' ? a.polarity : 'neutral',
      tags: Array.isArray(a.tags) ? a.tags : [],
      stages: Array.isArray(a.stages) ? a.stages : ['', '', '', ''],
    })),
    rules: (defs.rules ?? []).map((r) => ({ axis: r.axis, delta: r.delta, deltas: r.deltas, pattern: r.pattern })),
    events: (defs.events ?? []).map((e) => ({ on: e.on, axis: e.axis, delta: e.delta })),
    links: (defs.links ?? []).map((l) => ({ from: l.from, to: l.to, ratio: l.ratio })),
    combos: (defs.combos ?? []).map((c) => ({ when: c.when, text: c.text })),
  }
}
function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) }
    })
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const send = (code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try { return send(200, fs.readFileSync(HTML, 'utf8'), 'text/html; charset=utf-8') }
    catch (e) { return send(500, 'panel html missing: ' + e.message) }
  }
  if (req.method === 'GET' && url.pathname === '/api/state') return send(200, snapshot())

  if (req.method === 'POST' && url.pathname === '/api/set') {
    const b = await readBody(req)
    const st = load(STATE, { axes: {} })
    st.axes = st.axes ?? {}
    st.axes[String(b.key ?? '')] = Math.max(0, Math.min(100, Number(b.value) || 0))
    st.lastTick = Date.now()
    save(STATE, st)
    return send(200, snapshot())
  }

  if (req.method === 'POST' && url.pathname === '/api/update') {
    const b = await readBody(req)
    const defs = load(DEFS, emptyDefs())
    const a = (defs.axes ?? []).find((x) => x.key === b.key)
    if (!a) return send(404, { error: '没有这个轴' })
    if (typeof b.zh === 'string' && b.zh.trim()) a.zh = b.zh.trim()
    if (typeof b.tag === 'string') a.tag = b.tag.trim()
    if (Number.isFinite(Number(b.rate))) a.rate = Number(b.rate)
    if (Number.isFinite(Number(b.decay))) a.decay = Number(b.decay)
    if (b.polarity === 'pos' || b.polarity === 'neg' || b.polarity === 'neutral') a.polarity = b.polarity
    if (Array.isArray(b.tags)) a.tags = b.tags.map((t) => String(t).trim()).filter(Boolean)
    save(DEFS, defs)
    return send(200, snapshot())
  }

  if (req.method === 'POST' && url.pathname === '/api/del') {
    const b = await readBody(req)
    const defs = load(DEFS, emptyDefs())
    defs.axes = (defs.axes ?? []).filter((a) => a.key !== b.key)
    defs.links = (defs.links ?? []).filter((l) => l.from !== b.key && l.to !== b.key)
    defs.rules = (defs.rules ?? []).filter((r) => r.axis !== b.key)
    defs.events = (defs.events ?? []).filter((e) => e.axis !== b.key)
    save(DEFS, defs)
    const st = load(STATE, { axes: {} })
    if (st.axes) delete st.axes[b.key]
    save(STATE, st)
    return send(200, snapshot())
  }

  if (req.method === 'POST' && url.pathname === '/api/add') {
    const b = await readBody(req)
    const defs = load(DEFS, emptyDefs())
    defs.axes = defs.axes ?? []
    const key = String(b.key ?? '').trim().toLowerCase()
    if (!/^[a-z][a-z0-9_]{1,20}$/.test(key)) return send(400, { error: 'key 只能是小写字母/数字/下划线' })
    if (defs.axes.some((a) => a.key === key)) return send(400, { error: '这个 key 已经有了' })
    defs.axes.push({
      key,
      zh: String(b.zh ?? key),
      tag: String(b.tag ?? ''),
      value: Number(b.value ?? 30),
      rate: Number(b.rate ?? 0),
      decay: Number(b.decay ?? 0),
      polarity: b.polarity === 'pos' || b.polarity === 'neg' ? b.polarity : 'neutral',
      tags: Array.isArray(b.tags) ? b.tags.filter(Boolean) : [],
      stages: Array.isArray(b.stages) && b.stages.length === 4 ? b.stages : ['', `${key} 权重上升`, `${key} 主导`, `${key} 拉满`],
    })
    save(DEFS, defs)
    return send(200, snapshot())
  }

  // 触发：对话规则
  if (req.method === 'POST' && url.pathname === '/api/rule-add') {
    const b = await readBody(req)
    const pattern = String(b.pattern || '').trim()
    if (!pattern) return send(400, { error: '说一句什么话会触发它（正则）' })
    try { new RegExp(pattern) } catch (e) { return send(400, { error: '正则写错了: ' + e.message }) }
    let effects = []
    if (Array.isArray(b.deltas) && b.deltas.length) {
      effects = b.deltas
        .filter((e) => e && e.axis && Number.isFinite(Number(e.delta)) && Number(e.delta) !== 0)
        .map((e) => ({ axis: String(e.axis), delta: Number(e.delta) }))
    } else if (b.axis && Number.isFinite(Number(b.delta))) {
      effects = [{ axis: String(b.axis), delta: Number(b.delta) }]
    }
    if (!effects.length) return send(400, { error: '至少要有一个情绪和加减幅度' })
    const defs = load(DEFS, emptyDefs())
    defs.rules = defs.rules ?? []
    if (effects.length === 1) defs.rules.push({ axis: effects[0].axis, delta: effects[0].delta, pattern })
    else defs.rules.push({ deltas: effects, pattern })
    save(DEFS, defs)
    return send(200, snapshot())
  }
  if (req.method === 'POST' && url.pathname === '/api/rule-del') {
    const b = await readBody(req)
    const defs = load(DEFS, emptyDefs())
    defs.rules = (defs.rules ?? []).filter((_, i) => i !== Number(b.index))
    save(DEFS, defs)
    return send(200, snapshot())
  }

  // 触发：事件（on 名字自由填，不限于 tool_error/tool_ok）
  if (req.method === 'POST' && url.pathname === '/api/event-add') {
    const b = await readBody(req)
    if (!b.on || !b.axis) return send(400, { error: 'on 和 axis 都要填' })
    const defs = load(DEFS, emptyDefs())
    defs.events = defs.events ?? []
    defs.events.push({ on: String(b.on).trim(), axis: String(b.axis), delta: Number(b.delta) || 0 })
    save(DEFS, defs)
    return send(200, snapshot())
  }
  if (req.method === 'POST' && url.pathname === '/api/event-del') {
    const b = await readBody(req)
    const defs = load(DEFS, emptyDefs())
    defs.events = (defs.events ?? []).filter((_, i) => i !== Number(b.index))
    save(DEFS, defs)
    return send(200, snapshot())
  }

  // 联动：此消彼长
  if (req.method === 'POST' && url.pathname === '/api/link-add') {
    const b = await readBody(req)
    if (!b.from || !b.to || b.from === b.to) return send(400, { error: 'from / to 要填且不能相同' })
    const defs = load(DEFS, emptyDefs())
    defs.links = defs.links ?? []
    defs.links.push({ from: String(b.from), to: String(b.to), ratio: Number(b.ratio) || -1 })
    save(DEFS, defs)
    return send(200, snapshot())
  }
  if (req.method === 'POST' && url.pathname === '/api/link-del') {
    const b = await readBody(req)
    const defs = load(DEFS, emptyDefs())
    defs.links = (defs.links ?? []).filter((_, i) => i !== Number(b.index))
    save(DEFS, defs)
    return send(200, snapshot())
  }

  if (req.method === 'POST' && url.pathname === '/api/combo-add') {
    const b = await readBody(req)
    const a = String(b.a || ''), c = String(b.b || '')
    if (!a || !c || a === c) return send(400, { error: '两个情绪要选且不能相同' })
    const at = Math.min(100, Math.max(50, Number(b.at) || 90))
    const text = String(b.text || '').trim()
    if (!text) return send(400, { error: '写一句叠加后是什么状态' })
    const defs = load(DEFS, emptyDefs())
    defs.combos = defs.combos ?? []
    defs.combos.push({ when: [[a, at], [c, at]], text })
    save(DEFS, defs)
    return send(200, snapshot())
  }
  if (req.method === 'POST' && url.pathname === '/api/combo-del') {
    const b = await readBody(req)
    const defs = load(DEFS, emptyDefs())
    defs.combos = (defs.combos ?? []).filter((_, i) => i !== Number(b.index))
    save(DEFS, defs)
    return send(200, snapshot())
  }

  send(404, { error: 'not found' })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('情绪面板: http://127.0.0.1:' + PORT + '/')
})
