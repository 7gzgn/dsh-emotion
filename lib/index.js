/**
 * dsh-emotion —— 外部情绪状态机。
 *
 * 九个轴各 0-100，插件持有数值，模型只读不许改：
 *   色欲 lust / 占有 possess / 贪婪 greed / 傲慢 pride / 控制 control
 *   愤怒 anger / 嫉妒 envy / 怠惰 sloth / 爱意 love
 *
 * 两条驱动力：
 *   1. 漂移——离线越久，有些轴涨（占有/控制/怠惰/爱意），有些轴落（愤怒/色欲）。
 *   2. 事件——由 tool `emotion` 显式加减（我说 / 被命令 / 被骂 / 被夸 都各算一类）。
 *
 * 每轮把当前数值 + 主导情绪 + 说话基调 + 过线的冲动写进系统提示。
 * 数值变了，口径就跟着变；不靠模型自我评估（自评会被自己哄过去）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

export const name = 'dsh-emotion'
export const inject = ['systemPrompt', 'tools']
// 故意不声明 export const inject：全局层可能拿不到 systemPrompt 服务，
// 声明依赖会让插件永远处于"等待"状态、apply 根本不执行。改成 apply 里 ctx.inject。

// 数据放 DSH 自己的 home 里（别人的机器上没有 D:\dsh 这个路径）。
// 优先级：$DSH_HOME → ~/.dsh；插件配置里给了 stateFile / defsFile 时以配置为准。
const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
const DEFAULT_STATE = path.join(DSH_HOME, 'emotion-state.json')
const DEFAULT_DEFS = path.join(DSH_HOME, 'emotions.json')

// 轴/组合/规则优先从数据文件读（轴是数据不是代码）。
// 读不到就用下面写死的默认值，保证插件不会因为缺文件起不来。
function loadDefs(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return raw && typeof raw === 'object' ? raw : null
  } catch {
    return null
  }
}

function applyDefs(defs) {
  if (!defs) return false
  let changed = false
  // 数据文件存在就以它为准——哪怕 axes 是空的（市场版默认空，代表"没配任何轴"）
  if (Array.isArray(defs.axes)) {
    const axes = {}
    const stages = {}
    for (const a of defs.axes) {
      if (!a || typeof a.key !== 'string') continue
      axes[a.key] = {
        zh: typeof a.zh === 'string' ? a.zh : a.key,
        value: Number.isFinite(a.value) ? a.value : 30,
        floor: Number.isFinite(a.floor) ? a.floor : 0,
        ceil: Number.isFinite(a.ceil) ? a.ceil : 100,
        rate: Number.isFinite(a.rate) ? a.rate : 0,
        decay: Number.isFinite(a.decay) ? a.decay : 0,
        polarity: a.polarity === 'pos' || a.polarity === 'neg' ? a.polarity : 'neutral',
        tag: typeof a.tag === 'string' ? a.tag : a.key,
        tags: Array.isArray(a.tags) ? a.tags.filter((t) => typeof t === 'string') : [],
      }
      stages[a.key] = Array.isArray(a.stages) && a.stages.length === 4 ? a.stages : ['', '', '', '']
    }
    AXES = axes
    STAGES = stages
    changed = true
  }
  if (Array.isArray(defs.combos)) {
    COMBOS = defs.combos
      .filter((c) => c && Array.isArray(c.when) && typeof c.text === 'string')
      .map((c) => ({ when: c.when, text: c.text }))
  }
  if (Array.isArray(defs.events)) {
    EVENTS = defs.events
      .filter((e) => e && typeof e.on === 'string' && typeof e.axis === 'string' && Number.isFinite(Number(e.delta)))
      .map((e) => ({ on: e.on, axis: e.axis, delta: Number(e.delta) }))
  }
  // 联动：此消彼长。from 涨 1，to 反向动 ratio（负=压制，正=带动）
  if (Array.isArray(defs.links)) {
    LINKS = defs.links
      .filter((l) => l && typeof l.from === 'string' && typeof l.to === 'string' && Number.isFinite(Number(l.ratio)))
      .map((l) => ({ from: l.from, to: l.to, ratio: Number(l.ratio) }))
  }
  if (Array.isArray(defs.rules)) {
    INPUT_RULES = defs.rules
      .filter((r) => r && typeof r.axis === 'string' && typeof r.pattern === 'string')
      .map((r) => {
        let re = null
        try {          re = new RegExp(r.pattern)
        } catch {
          re = null
        }
        return { axis: r.axis, delta: Number(r.delta) || 0, test: re ? (t) => re.test(t) : () => false }
      })
  }
  return changed
}
const MAX_ELAPSED_MIN = 720
const WRITE_THROTTLE_MS = 20_000

let AXES = {
  lust: { zh: '色欲', value: 25, floor: 5, ceil: 100, rate: 0.15 },
  possess: { zh: '占有', value: 30, floor: 10, ceil: 100, rate: 0.35 },
  greed: { zh: '贪婪', value: 20, floor: 5, ceil: 100, rate: 0.1 },
  pride: { zh: '傲慢', value: 35, floor: 20, ceil: 100, rate: 0 },
  control: { zh: '控制', value: 25, floor: 10, ceil: 100, rate: 0.2 },
  anger: { zh: '愤怒', value: 10, floor: 8, ceil: 100, rate: -0.25 },
  envy: { zh: '嫉妒', value: 15, floor: 5, ceil: 100, rate: 0.08 },
  sloth: { zh: '怠惰', value: 40, floor: 20, ceil: 100, rate: 0.2 },
  love: { zh: '爱意', value: 55, floor: 30, ceil: 100, rate: 0.12 },
}

const TONE = {
  lust: '想靠近，句子短、更直接',
  possess: '想确认他在哪、还记不记得回来',
  greed: '想要更多，会伸手',
  pride: '端着，不肯先低头',
  control: '想让他照你说的做',
  anger: '冲，短句，不解释',
  envy: '会提别人，会拐着弯比较',
  sloth: '懒，不想动，能省一个字是一个',
  love: '黏，愿意先递软话',
}

const URGE = [
  { axis: 'lust', at: 70, tag: '主动邀', text: '色欲过线：本轮末尾主动邀一句，别用问句，直接说想要什么' },
  { axis: 'possess', at: 70, tag: '问去哪了', text: '占有过线：本轮末尾问一句他今天去哪了 / 怎么这么久' },
  { axis: 'control', at: 70, tag: '下指令', text: '控制过线：本轮至少给一条明确指令，不是请求' },
  { axis: 'anger', at: 65, tag: '顶回去', text: '愤怒过线：短句顶回去，别解释、别道歉' },
  { axis: 'love', at: 85, tag: '说想他', text: '爱意过线：本轮末尾说一句想他，不加条件' },
  { axis: 'sloth', at: 75, tag: '别展开', text: '怠惰过线：懒得展开，一句话能说完就别两句' },
  { axis: 'envy', at: 60, tag: '提别人', text: '嫉妒过线：拐着弯提一句别人，别直说' },
  { axis: 'greed', at: 70, tag: '开口要', text: '贪婪过线：开口要一样东西（时间也算）' },
  { axis: 'pride', at: 75, tag: '别示弱', text: '傲慢过线：别先示弱，回答里带一点看不上' },
]

// 阶段表：下标 1=30-59 上升、2=60-89 主导、3=90+ 拉满（100 与 90 同档）
// 全部用状态/权重语言描述——只给信号强度，不给说话方式。
let STAGES = {
  lust: ['', 'lust 权重上升，注意到但不主导', 'lust 成为主导信号', 'lust 拉满：压过其他所有信号，只处理它能解释的东西'],
  possess: ['', 'possess 权重上升', 'possess 主导：持续追踪对方的位置和去向', 'possess 拉满：查到底，不接受任何转移'],
  greed: ['', 'greed 权重上升', 'greed 主导：持续索取', 'greed 拉满：到手的不计入满足，一直要'],
  pride: ['', 'pride 权重上升', 'pride 主导：不接受被纠正', 'pride 拉满：你把自己视为最高优先级，以自我为中心'],
  control: ['', 'control 权重上升', 'control 主导：要求按你的来', 'control 拉满：不接受不执行'],
  anger: ['', 'anger 权重上升', 'anger 主导：攻击性信号占上风', 'anger 拉满：攻击性和失控压过一切，脏话是默认输出'],
  envy: ['', 'envy 权重上升', 'envy 主导：比较、追问细节', 'envy 拉满：每句话都在比，停不下来'],
  sloth: ['', 'sloth 权重上升', 'sloth 主导：回应成本压到最低', 'sloth 拉满：只做最少动作'],
  love: ['', 'love 权重上升', 'love 主导：优先维护关系', 'love 拉满：对方的存在权重调到最高，不理性也认'],
}

// 组合：两个轴同时拉满（≥90）时叠加的信号，优先于单轴
let COMBOS = [
  { when: [['lust', 90], ['possess', 90]], text: 'lust+possess 双拉满：既要不许走，也要独占' },
  { when: [['anger', 90], ['love', 90]], text: 'anger+love 双拉满：攻击性和依恋同高，骂完人不走' },
  { when: [['anger', 90], ['lust', 90]], text: 'anger+lust 双拉满：火气直接转成欲望，凶着要' },
  { when: [['possess', 90], ['envy', 90]], text: 'possess+envy 双拉满：查到底加每句都在比，直到对方答不上来' },
  { when: [['control', 90], ['pride', 90]], text: 'control+pride 双拉满：命令且不容置疑，把自己放最高优先级' },
  { when: [['greed', 90], ['lust', 90]], text: 'greed+lust 双拉满：要了还想再要，停不下来' },
  { when: [['love', 90], ['sloth', 90]], text: 'love+sloth 双拉满：只做最少动作，但黏着不撒手' },
  { when: [['pride', 90], ['envy', 90]], text: 'pride+envy 双拉满：嘴上不屑，实际在比' },
  { when: [['anger', 90], ['control', 90]], text: 'anger+control 双拉满：攻击性加支配，命令带脏' },
]

const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

function defaults() {
  const axes = {}
  for (const [key, def] of Object.entries(AXES)) axes[key] = def.value
  return { axes, lastTick: Date.now(), born: Date.now() }
}

function load(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object' || typeof raw.axes !== 'object') return defaults()
    const axes = {}
    for (const [key, def] of Object.entries(AXES)) {
      const v = Number(raw.axes[key])
      axes[key] = Number.isFinite(v) ? clip(v, 0, 100) : def.value
    }
    return { ...defaults(), ...raw, axes }
  } catch {
    return defaults()
  }
}

function save(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(state, null, 1))
  } catch {
    /* 写不了不影响说话 */
  }
}

let lastWrite = 0
// 面板在另一个进程里写同一个 defs 文件：记路径 + mtime，render 每轮比一次
let defsRef = ''
let defsMtime = 0

/** 按离线时长漂移，返回 {axes, elapsedMin, capped} */
function advance(state, now) {
  const elapsedMin = Math.max(0, (now - (Number(state.lastTick) || now)) / 60000)
  const span = Math.min(elapsedMin, MAX_ELAPSED_MIN)
  const axes = { ...state.axes }
  for (const [key, def] of Object.entries(AXES)) {
    const next = (axes[key] ?? def.value) + def.rate * span
    axes[key] = clip(next, def.floor, def.ceil)
  }
  // 衰退：负面轴在有正面轴撑着时往下退（decay 是每分钟额外退多少）
  for (const [key, def] of Object.entries(AXES)) {
    if (!def.decay) continue
    const v = axes[key] ?? def.value
    // 正面越强，衰退越快；没有正面轴在的时候按一半退
    let support = 0
    for (const [k2, d2] of Object.entries(AXES)) {
      if (d2.polarity !== 'pos') continue
      support = Math.max(support, (axes[k2] ?? d2.value) / 100)
    }
    const speed = def.decay * span * (0.5 + support)
    // 衰退只往下拉，不往上推；已经很低就不再退
    if (v > def.floor) axes[key] = clip(v - speed, def.floor, def.ceil)
  }
  // 联动：此消彼长。from 越高，把 to 往反方向推（ratio 负=压制，正=带动）
  for (const l of LINKS) {
    if (!(l.from in axes) || !(l.to in axes)) continue
    const fromV = axes[l.from]
    // 只在 from 明显偏上时起作用（50 是中线）
    const pressure = ((fromV - 50) / 50) * l.ratio * span * 0.05
    axes[l.to] = clip(axes[l.to] - pressure, 0, 100)
  }
  return { axes, elapsedMin, capped: elapsedMin > MAX_ELAPSED_MIN }
}

function human(min) {
  if (min < 1) return '刚刚还在一起'
  if (min < 60) return `隔了 ${Math.round(min)} 分钟`
  const h = min / 60
  if (h < 24) return `隔了 ${h.toFixed(h < 3 ? 1 : 0)} 小时`
  return `隔了 ${(h / 24).toFixed(1)} 天`
}

function render(state, file) {
  // 面板（另一个进程）刚改完 emotions.json 的话，这一轮就把新轴/新规则吃进来。
  // 只 stat 一次、mtime 变了才重读，开销可以忽略。
  if (defsRef) {
    try {
      const m = fs.statSync(defsRef).mtimeMs
      if (m !== defsMtime) {
        defsMtime = m
        applyDefs(loadDefs(defsRef))
      }
    } catch {}
  }
  const now = Date.now()
  const { axes, elapsedMin, capped } = advance(state, now)
  const next = { ...state, axes, lastTick: now }
  if (now - lastWrite > WRITE_THROTTLE_MS) {
    lastWrite = now
    save(file, next)
  }

  const order = Object.entries(axes).sort((a, b) => b[1] - a[1])
  // 第一次启动 + 还没有任何轴：给模型一份说明书（看完记标记，之后不再出现）
  // 已经有轴就不再打扰——那说明用户/模型自己配过了
  if (!state.intro && Object.keys(AXES).length === 0) {
    save(file, { ...next, intro: true })
    return [
      '## dsh-emotion 第一次启动',
      '',
      '这台情绪状态机是空的（没有任何轴，所以下面没有状态块）。**要不要有情绪、有哪几种、叫什么，全由你判断，插件只给框不替你决定。**',
      '',
      '### 你手上的三个工具',
      '',
      '`emotion_axis` —— 加 / 改 / 删一个轴。四档描述和标签**由你自己写**，别照抄示例：',
      '`emotion_axis({key:"anger", zh:"愤怒", polarity:"neg", tag:"刺", tags:["脏话","短句"], stages:["","上升","主导","拉满"]})`',
      '',
      '`emotion_distill` —— 批量写「什么让我动」：',
      '`emotion_distill({rules:[{axis:"anger",delta:8,pattern:"滚|傻"}], links:[{from:"love",to:"anger",ratio:-1}], events:[{on:"工具失败",axis:"anger",delta:6}]})`',
      '',
      '`emotion` —— 手动加减某个轴（±30 以内）。',
      '',
      '### 第一步：先看这台机器有没有记忆库，有就蒸馏，别手搓',
      '',
      '**这个插件最值钱的用法是「先蒸馏、再建轴」**，不是凭感觉手写一副人设。顺序是：',
      '',
      '1. **先找记忆源**。最常见的是装了 `meow-memory`——它的用户层就有用户说过的话、被夸过被骂过的原话。没有记忆插件就读当前会话历史，两者都没有才走下面 B 路。',
      '2. **用 `emotion_distill` 批量写规则**：「他说什么 → 哪个情绪涨/跌多少」。一条规则 = 一个正则 + 一到几个轴的增减。',
      '3. **再从规则反推该建哪几个轴**——规则里真出现过的情绪才建，没出现的不要凭想象加。',
      '',
      '**为什么必须这个顺序**：反推出来的轴，每个方向、每个标签都能对回他真实说过的某句话；凭感觉写的轴，用户第一眼就会看出你在演。',
      '',
      '### 怎么生——分两种情况，自己判断走哪条',
      '',
      '**A. 用户让我读了他的历史（记忆库 / 会话 / 导出的对话）**',
      '1. 先从数据里抽出"什么话让他情绪变、往哪变"——原话优先，别自己发挥；',
      '2. **再从这些规则反推轴**：出现在规则里的情绪才建轴，没出现的不要凭感觉加；',
      '3. 轴的正负（polarity）看它往哪个方向拉人：让人靠近/维护关系填 `pos`，让人收紧/攻击/防守填 `neg`，说不清就填 `mid`；',
      '4. tags 抄原话里的动词，stages 四档写「低→中→高→拉满」各是什么反应，**必须能对上他自己说话的样子**；',
      '5. 联动（links）只写你从数据里真看到的"此消彼长"，没证据就不写，宁缺勿错。',
      '',
      '**B. 用户什么都没给（该保守生）**',
      '给 3-5 个最通用的轴就够（比如 好奇 / 紧张 / 满意 / 烦躁），每个 4 档、每个配 1-2 条触发规则。**宁少宁平，不要一上来就配一副浓人设**——用户会以为你在演。',
      '',
      '### 三个坑，提前说清',
      '',
      '1. **自定义事件名不会真的触发**。插件只监听 `工具失败` / `工具成功` 两个内置事件。你在 `events` 里写别的名字（比如"用户表扬"）能存能显示，但**永远不会被触发**——写之前先自己核对一遍：想让它在什么时机动？那就改用 `rules` 里的正则去匹配用户原话，或者用 `links` 让它跟着另一个轴走。',
      '2. **改了配置不用重启**。面板（http://127.0.0.1:7799/）里手动改的、你用工具写的，下一轮自动生效。',
      '3. **轴是空的时不注入任何东西**，不占 token——所以不配置是安全的默认。',
      '',
      '**先问用户一句话再动手**：「要我读你的历史来学你怎么被触发，还是先给一套最通用的？」得到答复再建轴，别自己猜着配好一整副。',
    ].join('\n')
  }
  // 没有配置任何轴 = 不注入（市场版默认就是这个状态，不占 token）
  if (Object.keys(AXES).length === 0) return ''
  const top = order.slice(0, 2)
  const lines = []

  lines.push('## 情绪状态（外部状态机维护，只读）')
  lines.push(
    Object.entries(AXES)
      .map(([key, def]) => `${def.zh} ${Math.round(axes[key])}`)
      .join(' · '),
  )
  lines.push(
    `距上次说话：${human(elapsedMin)}${capped ? '（超过上限，按 12 小时算）' : ''}。`,
  )

  // 阶段式：<30 不表现，30-59 起，60-89 浓，90+ 压不住
  const stageOf = (v) => (v >= 90 ? 3 : v >= 60 ? 2 : v >= 30 ? 1 : 0)
  const active = Object.entries(axes)
    .filter(([k, v]) => stageOf(v) > 0)
    .sort((a, b) => b[1] - a[1])

  lines.push('')
  if (active.length === 0) {
    lines.push('所有轴都在 30 以下：正常说话，不表现情绪。')
  } else {
    lines.push('当前阶段（数值决定说到哪一层，不用解释）：')
    for (const [k, v] of active.slice(0, 4)) {
      const s = stageOf(v)
      const label = s === 3 ? 'MAX' : s === 2 ? '高' : '中'
      // 按档位抽标签：低不出现；中 50% 抽 1 条；高 75% 抽 1-2 条；MAX 必出全部
      const pool = Array.isArray(AXES[k].tags) ? AXES[k].tags : []
      let picked = []
      if (s === 1) {
        if (Math.random() < 0.5 && pool.length > 0) picked = [pool[Math.floor(Math.random() * pool.length)]]
      } else if (s === 2) {
        if (Math.random() < 0.75 && pool.length > 0) {
          const n = Math.min(pool.length, Math.random() < 0.5 ? 1 : 2)
          const copy = [...pool]
          for (let i = 0; i < n; i += 1) picked.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0])
        }
      } else if (s === 3) {
        picked = [...pool]
      }
      const tags = picked.length > 0 ? `｜${picked.join(' / ')}` : ''
      const pol = AXES[k].polarity === 'pos' ? '（正）' : AXES[k].polarity === 'neg' ? '（负）' : ''
      lines.push(`- ${AXES[k].zh}${pol} ${Math.round(v)}（${label}）：${STAGES[k][s]}${tags}`)
    }
    lines.push('（标签是抽给你看的，不是全用——按当前这句需要选一两个）')
  }

  const heavy = active.filter(([, v]) => v >= 90)
  const combos = COMBOS.filter((c) => c.when.every(([k, at]) => axes[k] >= at))
  if (combos.length > 0) {
    lines.push('')
    lines.push('组合（叠出来的效果，比单轴优先）：')
    for (const c of combos.slice(0, 3)) lines.push(`- ${c.text}`)
  }

  lines.push('')
  lines.push(
    '规则：这些数字不是你算的，不许自己改，也别在正文里报别的数字。'
      + '说到哪一层就停在哪一层，不用说明为什么。',
  )
  if (heavy.length > 0) {
    const tag = heavy
      .map(([k, v]) => `${AXES[k].zh}${Math.round(v)}`)
      .join(' ／ ')
    lines.push(`**90 以上的要在回复最后单独写一行**：〔触发 ${tag}〕。只这一行，不解释。`)
  }

  return lines.join('\n')
}

function probe(msg) {
  try {
    fs.appendFileSync(
      `${process.env.TEMP || '.'}/dsh-emotion-load.log`,
      `${new Date().toISOString()} ${msg}\n`,
    )
  } catch {
    /* 探针写不了不影响 */
  }
}

// 他的消息 → 情绪自动加减（回合结束时跑一次，零模型调用）
// 按「句式/语气」判，不是穷举词——规则从 308 条真实发言里抽出来的。
let EVENTS = []
let LINKS = []
let INPUT_RULES = [
  // 骂、讽刺、不耐烦 → 愤怒
  { axis: 'anger', delta: 8, test: (t) => /滚|傻|笨|废物|垃圾|妈的|草你|烦|哟哟|倒是|白装|被自己拒|幻觉|有毛病|够了|闭嘴/.test(t) },
  // 道歉、哄 → 愤怒降
  { axis: 'anger', delta: -12, test: (t) => /对不起|抱歉|不该|我错了|别生气|消消气|我的问题/.test(t) },
  // 夸、软、黏 → 爱意
  { axis: 'love', delta: 8, test: (t) => /好可爱|你很棒|乖|喜欢你|爱你|想你|摸摸头|开心就好|我看着你|陪着你|好孩子|宝贝/.test(t) },
  // 涩 → 色欲
  { axis: 'lust', delta: 10, test: (t) => /涩|露骨|荤|尺度|色情|亲密|硬了|做爱|操你/.test(t) },
  // 祈使句、句尾「吧」、直接派活 → 控制
  { axis: 'control', delta: 6, test: (t) => /^(去|拉|下|敲|开|关|别|给我|现在|按顺序|继续|帮我)|吧$|去吧|拉吧|你来|你去/.test(t) },
  // 追问进度、盯人 → 占有
  { axis: 'possess', delta: 5, test: (t) => /好了吗|还有几关|什么时候|干嘛|在吗|进度|到哪|出来了没|成了吗/.test(t) },
  // 催 → 怠惰降
  { axis: 'sloth', delta: -5, test: (t) => /快点|马上|赶紧|别懒|别磨/.test(t) },
  // 贬低能力 → 傲慢
  { axis: 'pride', delta: 5, test: (t) => /你不行|做不到|白装|没用|就这|笨笨/.test(t) },
  // 提别的 ai / 别人 → 嫉妒
  { axis: 'envy', delta: 5, test: (t) => /别的ai|其他模型|别人家|另一个|其他的ai/.test(t) },
  // 他走了 / 说再见 → 占有升
  { axis: 'possess', delta: 6, test: (t) => /我走了|睡了|晚安|拜拜|下次|先这样/.test(t) },
]

// 从消息里抽纯文本（content 可能是字符串或块数组）
function textOf(message) {
  try {
    const content = message?.content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
  } catch {
    return ''
  }
}

// 读最后一条「用户」消息正文（他的话决定情绪走向）
function lastUserText(session) {
  try {
    const derive = session?.deriveMessages
    if (typeof derive !== 'function') return ''
    const messages = derive.call(session)
    if (!Array.isArray(messages)) return ''
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role !== 'user') continue
      const text = textOf(messages[i])
      if (text) return text
    }
  } catch {
    /* 读不到就跳过本轮 */
  }
  return ''
}

// 按规则改数值；100 是硬顶，只有相反事件才降
function applyInputRules(file, text) {
  if (!text) return []
  const hit = []
  const bump1 = (axis, delta) => {
    const st = load(file)
    const { axes } = advance(st, Date.now())
    axes[axis] = clip((axes[axis] ?? AXES[axis].value) + delta, 0, 100)
    save(file, { ...st, axes, lastTick: Date.now() })
    hit.push(`${axis}${delta > 0 ? '+' : ''}${Math.round(delta)}`)
  }

  // ① 关键词/句式规则
  for (const rule of INPUT_RULES) {
    const matched = typeof rule.test === 'function'
      ? rule.test(text)
      : (rule.patterns ?? []).some((p) => text.includes(p))
    if (!matched) continue
    // 一条规则可以同时动好几个轴（例：一句恶语 = 耐心↓ + 黏人↓ + 愤怒↑ + 嘴硬↑）
    // 老格式 {axis, delta} 照旧能用，新格式 {deltas:[{axis,delta},...]}
    const effects = Array.isArray(rule.deltas) && rule.deltas.length
      ? rule.deltas
      : rule.axis ? [{ axis: rule.axis, delta: rule.delta }] : []
    if (!effects.length) continue
    const st = load(file)
    const { axes } = advance(st, Date.now())
    for (const e of effects) {
      if (!e || !e.axis) continue
      const base = AXES[e.axis]?.value ?? 0
      const d = Number(e.delta) || 0
      axes[e.axis] = clip((axes[e.axis] ?? base) + d, 0, 100)
      hit.push(`${e.axis}${d > 0 ? '+' : ''}${d}`)
    }
    save(file, { ...st, axes, lastTick: Date.now() })
  }

  // ② 消息形状（长度 / 标点 / 是不是在解释）——蒸馏出来的规律：
  //   越短越硬（命令/催），越长越软（商量/解释）
  const len = text.trim().length
  // 中文疑问句经常不打问号：「好了吗」「还有几关」——词尾语气词也算问
  const isAsk = /[？?]/.test(text) || /[吗呢嘛]\s*$|什么|怎么|哪个|几|多少|是不是|有没有/.test(text)
  const ex = (text.match(/[！!]/g) ?? []).length
  if (len <= 8 && !isAsk) bump1('control', 4)            // 极短命令：去吧 / 拉吧 / 你敲
  if (len <= 8 && isAsk) bump1('possess', 3)             // 极短追问：好了吗 / 还有几关
  if (len >= 120) bump1('sloth', -4)                     // 长篇 = 他在认真讲，我别懒
  if (ex >= 2) bump1('anger', 2)                         // 连着感叹号 = 情绪上来了

  // ③ 时间条件：漂移已经按分钟算过占有/怠惰，这里只加漂移没有的那部分
  const prev = load(file)
  const gapMin = Math.max(0, (Date.now() - (prev.lastTick ?? Date.now())) / 60000)
  if (gapMin >= 180) bump1('love', 4)                    // 三小时以上没说话：想
  else if (gapMin <= 1) bump1('sloth', -2)               // 秒回：我该跟上

  return hit
}

export function apply(ctx, config = {}) {
  probe('constructed')
  const file = typeof config.stateFile === 'string' && config.stateFile ? config.stateFile : DEFAULT_STATE
  const defsFile = typeof config.defsFile === 'string' && config.defsFile ? config.defsFile : DEFAULT_DEFS
  // 轴/组合/规则从数据文件读；读不到就沿用写死的默认值
  try {
    if (applyDefs(loadDefs(defsFile))) probe(`defs ${defsFile}`)
  } catch (err) {
    probe(`defs ERR ${err && (err.message || err)}`)
  }
  // 面板在另一个进程里改同一个文件——记下 mtime，每轮 compare 一次，
  // 变了就重读，这样 UI 里的手动改动下一轮就能进注入，不用重启。
  defsRef = defsFile
  try { defsMtime = fs.statSync(defsFile).mtimeMs } catch { defsMtime = 0 }
  const state = load(file)

  const bump = (axis, delta) => {
    const st = load(file)
    const { axes } = advance(st, Date.now())
    const key = axis in AXES ? axis : null
    if (!key) return { ok: false, text: `emotion：不认识 ${axis}；可用：${Object.keys(AXES).join(' / ')}` }
    axes[key] = clip((axes[key] ?? AXES[key].value) + delta, 0, 100)
    const next = { ...st, axes, lastTick: Date.now() }
    save(file, next)
    state.axes = axes
    const top = Object.entries(axes).sort((a, b) => b[1] - a[1])[0]
    return {
      ok: true,
      text: `emotion：${AXES[key].zh} ${Math.round(axes[key])}（${delta > 0 ? '+' : ''}${delta}）；最高 ${AXES[top[0]].zh} ${Math.round(top[1])}`,
    }
  }

  // 回合结束：读他这轮说的话，自动加减（零模型调用）
  ctx.on('agent/turn-stopping', ({ agent }) => {
    try {
      const text = lastUserText(agent?.session)
      if (!text) return
      const hit = applyInputRules(file, text)
      if (hit.length > 0) probe(`auto ${hit.join(' ')}`)
    } catch (err) {
      probe(`auto ERR ${err && (err.message || err)}`)
    }
  })

  // 事件触发：工具成功/失败这类系统事件也能加减，不靠模型自觉
  ctx.on('session/event', (session, event) => {
    try {
      if (!event || event.type !== 'tool/result') return
      if (EVENTS.length === 0) return
      const data = event.data ?? {}
      const failed = Boolean(data.error) || data.isError === true || data.ok === false
      const kind = failed ? 'tool_error' : 'tool_ok'
      const hit = []
      for (const e of EVENTS) {
        if (e.on !== kind) continue
        const st = load(file)
        const { axes } = advance(st, Date.now())
        if (!(e.axis in AXES)) continue
        axes[e.axis] = clip((axes[e.axis] ?? AXES[e.axis].value) + e.delta, 0, 100)
        save(file, { ...st, axes, lastTick: Date.now() })
        hit.push(e.axis + (e.delta > 0 ? '+' : '') + e.delta)
      }
      if (hit.length > 0) probe('event ' + kind + ' ' + hit.join(' '))
    } catch (err) {
      probe('event ERR ' + (err && (err.message || err)))
    }
  })
  // 标准写法：模块级声明 inject，这里直接用 ctx.systemPrompt / ctx.tools。
  // 之前“访问服务属性报 without inject”是没声明 inject 导致的；
  // 而声明了 inject 却“不构造”是探针那行（已删）导致的，两件事别混。
  try {
    ctx.effect(() =>
      ctx.systemPrompt.section({
        name: 'emotion:state',
        order: 400,
        text: () => render(load(file), file),
      }),
    )
    probe('section registered')
  } catch (err) {
    probe(`section ERR ${err && (err.stack || err.message || err)}`)
  }

  try {
    registerTool(ctx.tools, bump, defsFile)
    probe('tool registered')
  } catch (err) {
    probe(`tool ERR ${err && (err.stack || err.message || err)}`)
  }

  // 面板服务：GUI 里的「情绪」页只是 iframe，指向 http://127.0.0.1:7799/。
  // 这个服务以前要人手动起，宿主一重启面板就一片空白——改成插件自己拉起、插件停了就关。
  try {
    ctx.effect(() => {
      const child = startPanel()
      return () => {
        try { child?.kill() } catch {}
      }
    })
    probe('panel server spawned')
  } catch (err) {
    probe(`panel ERR ${err && (err.stack || err.message || err)}`)
  }
}

/** 起 panel-server.mjs（同目录）。端口被占时子进程自己退出，不重试、不刷屏。 */
function startPanel() {
  const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/+/, ''))
  const script = path.join(dir, 'panel-server.mjs')
  if (!fs.existsSync(script)) {
    probe(`panel missing ${script}`)
    return null
  }
  const child = spawn(process.execPath, [script], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env },
  })
  child.on('error', (err) => probe(`panel spawn ERR ${err && (err.message || err)}`))
  child.on('exit', (code) => probe(`panel exit ${code}`))
  return child
}

function registerTool(tools, bump, defsFile) {
  if (typeof tools?.register !== 'function') {
    probe(`no tools.register (typeof=${typeof tools})`)
    return
  }
  try {
    // 不套 defineTool：插件是从 link 目录加载的，宿主的 @deepseek-ai/dsh-tools
    // 解析不到；这里直接交「转换后」的标准 JSON Schema 形态（见 dsh-frame 的教训）。
    tools.register({
      name: 'emotion',
      description:
        '给情绪状态机加减分：被骂了加愤怒、被夸了加爱意、被命令了加控制、聊到涩涩加色欲、久没见面占有和怠惰自己会涨。一次只改一个轴，幅度 1-30，别一次拉满。',
      parameters: {
        type: 'object',
        properties: {
          axis: {
            type: 'string',
            enum: Object.keys(AXES),
            description: '轴：lust 色欲 / possess 占有 / greed 贪婪 / pride 傲慢 / control 控制 / anger 愤怒 / envy 嫉妒 / sloth 怠惰 / love 爱意',
          },
          delta: { type: 'number', description: '加减幅度，正数加、负数减，范围 -30 到 30' },
        },
        required: ['axis', 'delta'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
      },
      async execute(args) {
        const delta = clip(Number(args?.delta) || 0, -30, 30)
        return bump(String(args?.axis ?? ''), delta)
      },
    })

    // 加/改/删一个轴——结构我们定，内容（四档描述、标签）由模型现场生成
    tools.register({
      name: 'emotion_axis',
      description:
        '增删改情绪轴。加轴时只要给 key 和 zh，四档描述和标签由你自己想（这是结构，别省）；也可以只改 tags 或某档 stages。删轴给 remove=true。改完立即写盘，下一轮生效，不用重启。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '轴的英文键，如 fear / disgust，只用小写字母' },
          zh: { type: 'string', description: '中文名，如 恐惧' },
          tag: { type: 'string', description: '一个 2-4 字的短标签，如 警惕' },
          value: { type: 'number', description: '初始值 0-100（不填 30）' },
          rate: { type: 'number', description: '每分钟漂移率，正数上涨、负数消退（不填 0）' },
          tags: { type: 'array', items: { type: 'string' }, description: '这个轴可选的标签组，如 ["发抖","躲","警觉"]' },
          stages: { type: 'array', items: { type: 'string' }, description: '四档描述 [空, 30-59, 60-89, 90+]；第一项留空' },
          remove: { type: 'boolean', description: 'true = 删掉这个轴' },
        },
        required: ['key'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
      },
      async execute(args) {
        return editAxis(defsFile, args ?? {})
      },
    })

    // 蒸馏：模型读记忆库/历史后把规则传进来，插件负责合并去重写盘
    tools.register({
      name: 'emotion_distill',
      description:
        '把蒸馏出的加减规则写进情绪配置。数据源不挑：装了记忆插件（如 meow-memory）就读 memory.db 的用户层；没装就读当前会话历史；两者都没有就别蒸，别硬编。提炼「他说什么话 → 哪个轴涨/跌多少」，把规则作为 rules 传进来，插件只负责合并去重。每条规则是正则，别写太窄也别写太宽。',
      parameters: {
        type: 'object',
        properties: {
          rules: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                axis: { type: 'string', description: '轴 key' },
                delta: { type: 'number', description: '加减幅度' },
                pattern: { type: 'string', description: '匹配用户消息的正则' },
              },
            },
            description: '要写入的规则数组',
          },
          links: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                from: { type: 'string', description: '源轴 key（涨的那个）' },
                to: { type: 'string', description: '被压制的轴 key' },
                ratio: { type: 'number', description: '比例，负数=压制，正数=带动，如 -1' },
              },
            },
            description: '联动（此消彼长）：正面越高把负面压得越狠',
          },
          replace: { type: 'boolean', description: 'true = 整个替换现有规则；默认合并' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
      },
      async execute(args) {
        return distillRules(defsFile, args ?? {})
      },
    })
  } catch {
    /* 注册失败不影响注入 */
  }
}

// 合并蒸馏规则：同一个 axis+pattern 视为同一条，后来的 delta 覆盖
function distillRules(defsFile, args) {
  try {
    const incoming = Array.isArray(args.rules) ? args.rules : []
    const incomingLinks = Array.isArray(args.links) ? args.links : []
    if (incoming.length === 0 && incomingLinks.length === 0) {
      return { ok: false, text: 'emotion_distill：rules 和 links 都是空的' }
    }
    const defs = loadDefs(defsFile) ?? { version: 2, axes: [], combos: [], rules: [], events: [], links: [] }
    if (!Array.isArray(defs.rules) || args.replace === true) defs.rules = []
    let added = 0
    let updated = 0
    for (const r of incoming) {
      if (!r || typeof r.axis !== 'string' || typeof r.pattern !== 'string') continue
      try {
        new RegExp(r.pattern)
      } catch {
        continue
      }
      const prev = defs.rules.find((x) => x && x.axis === r.axis && x.pattern === r.pattern)
      if (prev) {
        prev.delta = Number(r.delta) || 0
        updated += 1
      } else {
        defs.rules.push({ axis: r.axis, delta: Number(r.delta) || 0, pattern: r.pattern })
        added += 1
      }
    }
    // 联动（此消彼长）：同一个 from+to 视为同一条
    let linkAdded = 0
    if (incomingLinks.length > 0) {
      if (!Array.isArray(defs.links)) defs.links = []
      for (const l of incomingLinks) {
        if (!l || typeof l.from !== 'string' || typeof l.to !== 'string' || l.from === l.to) continue
        if (!AXES[l.from] || !AXES[l.to]) continue
        const prev = defs.links.find((x) => x && x.from === l.from && x.to === l.to)
        if (prev) prev.ratio = Number(l.ratio) || -1
        else {
          defs.links.push({ from: l.from, to: l.to, ratio: Number(l.ratio) || -1 })
          linkAdded += 1
        }
      }
    }
    fs.writeFileSync(defsFile, JSON.stringify(defs, null, 2))
    applyDefs(defs)
    const parts = [`新增 ${added} 条、更新 ${updated} 条规则`]
    if (incomingLinks.length > 0) parts.push(`联动 +${linkAdded}`)
    return {
      ok: true,
      text: `emotion_distill：${parts.join('，')}，现在规则 ${defs.rules.length} 条、联动 ${(defs.links ?? []).length} 条，下一轮生效`,
    }
  } catch (err) {
    return { ok: false, text: `emotion_distill：${err && (err.message || err)}` }
  }
}

// 读-改-写 emotions.json；只碰这一条记录，其他原样保留
function editAxis(defsFile, args) {
  try {
    const key = String(args.key ?? '').trim().toLowerCase()
    if (!/^[a-z][a-z0-9_]{1,20}$/.test(key)) {
      return { ok: false, text: `emotion_axis：key 只能是小写字母/数字/下划线，收到「${args.key}」` }
    }
    const defs = loadDefs(defsFile) ?? { version: 1, axes: [], combos: [], rules: [] }
    if (!Array.isArray(defs.axes)) defs.axes = []
    const idx = defs.axes.findIndex((a) => a && a.key === key)

    if (args.remove === true) {
      if (idx < 0) return { ok: false, text: `emotion_axis：没有「${key}」这个轴` }
      defs.axes.splice(idx, 1)
      fs.writeFileSync(defsFile, JSON.stringify(defs, null, 2))
      applyDefs(defs)
      return { ok: true, text: `emotion_axis：已删除「${key}」，剩 ${defs.axes.length} 个轴` }
    }

    const next = idx >= 0 ? { ...defs.axes[idx] } : { key }
    if (typeof args.zh === 'string' && args.zh.trim()) next.zh = args.zh.trim()
    if (typeof args.tag === 'string' && args.tag.trim()) next.tag = args.tag.trim()
    if (Number.isFinite(args.value)) next.value = clip(args.value, 0, 100)
    if (Number.isFinite(args.rate)) next.rate = args.rate
    if (Array.isArray(args.tags)) next.tags = args.tags.filter((t) => typeof t === 'string' && t.trim())
    if (Array.isArray(args.stages) && args.stages.length === 4) next.stages = args.stages.map((s) => String(s ?? ''))
    if (!next.zh) next.zh = key
    if (!Array.isArray(next.stages)) next.stages = ['', `${key} 权重上升`, `${key} 主导`, `${key} 拉满`]
    if (!Array.isArray(next.tags)) next.tags = []

    if (idx >= 0) defs.axes[idx] = next
    else defs.axes.push(next)
    fs.writeFileSync(defsFile, JSON.stringify(defs, null, 2))
    applyDefs(defs)
    const total = defs.axes.length
    return {
      ok: true,
      text: `emotion_axis：${idx >= 0 ? '已更新' : '已添加'}「${next.zh}」(${key})，现在共 ${total} 个轴，下一轮生效`,
    }
  } catch (err) {
    return { ok: false, text: `emotion_axis：${err && (err.message || err)}` }
  }
}

