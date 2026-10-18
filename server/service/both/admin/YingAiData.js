import fs from 'fs'
import path from 'path'

/**
 * YingAI 私聊数据层（纯 fs，不依赖锅巴框架，可单独测试）
 *
 * 数据源：<pluginDir>/data/private/
 *   users/<uid>/{conversation,profile,relationship,emotion,selfstate}.json
 *   userFlags.json / config.override.json
 */

const SKIP_DIR = /^(test_|tmp_|dbg|followup|_quarantine)/

function readJson(file, fb = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fb
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), {recursive: true})
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

/** 文本风格度量 */
function styleOf(list) {
  const n = list.length || 1
  const lens = list.map((t) => String(t).length)
  const avg = lens.reduce((a, b) => a + b, 0) / n
  const question = list.filter((t) => /[?？]/.test(t)).length
  const multiLine = list.filter((t) => String(t).includes('\n')).length
  const codeBlock = list.filter((t) => /```/.test(t)).length
  const openings = new Map()
  for (const t of list) {
    const s = String(t).replace(/^[\s，。！？~…、]+/, '').slice(0, 4)
    if (s.length >= 2) openings.set(s, (openings.get(s) || 0) + 1)
  }
  const repeated = [...openings.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1])
  const repeatedCount = repeated.reduce((s, [, c]) => s + c, 0)
  // 句中模板句：3-gram 出现在 >=3 条回复里（"你今天怎"/"你才"等），比只看开头更准
  const grams = new Map()
  for (const t of list) {
    const seen = new Set()
    for (let i = 0; i + 3 <= t.length; i++) {
      const g = t.slice(i, i + 3)
      if (/[\s，。！？,.!?、…~～"“”]/.test(g)) continue
      seen.add(g)
    }
    for (const g of seen) grams.set(g, (grams.get(g) || 0) + 1)
  }
  const templates = [...grams.entries()].filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]).slice(0, 8)
  const hotReplyCount = templates.length ? list.filter((t) => templates.some(([g]) => t.includes(g))).length : 0
  return {
    count: list.length,
    avgLen: Math.round(avg * 10) / 10,
    maxLen: lens.length ? Math.max(...lens) : 0,
    questionRate: Math.round((question / n) * 100) / 100,
    multiLineRate: Math.round((multiLine / n) * 100) / 100,
    codeBlockRate: Math.round((codeBlock / n) * 100) / 100,
    repeatOpenRate: Math.round((hotReplyCount / n) * 100) / 100,
    openings: templates.map(([k, c]) => ({prefix: k, count: c})),
  }
}

export function createYingAiData(pluginDir) {
  const privateDir = path.join(pluginDir, 'data', 'private')
  const usersDir = path.join(privateDir, 'users')
  const flagsFile = path.join(privateDir, 'userFlags.json')
  const overrideFile = path.join(privateDir, 'config.override.json')

  let cache = null
  let cacheAt = 0

  function load() {
    if (cache && Date.now() - cacheAt < 5000) return cache
    const flags = readJson(flagsFile, {}) || {}
    const override = readJson(overrideFile, {}) || {}
    const globalEnabled = override?.behavior?.privateChatEnabled === true

    const users = []
    const aiTexts = []
    let dirs = []
    try {
      dirs = fs.readdirSync(usersDir)
    } catch {
      dirs = []
    }
    for (const uid of dirs) {
      if (SKIP_DIR.test(uid)) continue
      const full = path.join(usersDir, uid)
      try {
        if (!fs.statSync(full).isDirectory()) continue
      } catch {
        continue
      }
      const profile = readJson(path.join(full, 'profile.json'), {}) || {}
      const rel = readJson(path.join(full, 'relationship.json'), {}) || {}
      const emo = readJson(path.join(full, 'emotion.json'), {}) || {}
      const self = readJson(path.join(full, 'selfstate.json'), {}) || {}
      const conv = readJson(path.join(full, 'conversation.json'), {}) || {}
      const msgs = Array.isArray(conv.recentMessages) ? conv.recentMessages : []
      const ai = msgs.filter((m) => m?.role === 'assistant').map((m) => String(m.text || ''))
      const user = msgs.filter((m) => m?.role === 'user').map((m) => String(m.text || ''))
      aiTexts.push(...ai)
      const explicit = flags?.[uid]?.enabled
      users.push({
        uid,
        name: profile?.name && profile.name !== '用户' ? profile.name : uid,
        stage: rel?.stage || 'stranger',
        closeness: rel?.closeness ?? 0,
        familiarity: rel?.familiarity ?? 0,
        interactionCount: rel?.interactionCount ?? msgs.length,
        mood: emo?.mood || 'neutral',
        energy: self?.energy ?? null,
        msgs: msgs.length,
        aiMsgs: ai.length,
        userMsgs: user.length,
        lastAt: rel?.lastInteractionAt || profile?.timestamps?.lastSeen || null,
        firstSeen: profile?.timestamps?.firstSeen || null,
        enabled: typeof explicit === 'boolean' ? explicit : globalEnabled,
        explicit: typeof explicit === 'boolean' ? explicit : null,
        style: styleOf(ai),
        sample: ai.slice(-2),
      })
    }
    users.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0) || b.msgs - a.msgs)

    cache = {
      users,
      globalEnabled,
      metrics: styleOf(aiTexts),
      totalMsgs: users.reduce((s, u) => s + u.msgs, 0),
      at: Date.now(),
    }
    cacheAt = Date.now()
    return cache
  }

  function invalidate() {
    cache = null
  }

  function overview() {
    const {users, globalEnabled, metrics, totalMsgs} = load()
    const now = Date.now()
    const week = 7 * 86400000
    const stageDist = {}
    for (const u of users) stageDist[u.stage] = (stageDist[u.stage] || 0) + 1
    return {
      users: users.length,
      withChat: users.filter((u) => u.msgs > 0).length,
      enabled: users.filter((u) => u.enabled).length,
      globalEnabled,
      totalMsgs,
      active7d: users.filter((u) => u.lastAt && now - u.lastAt < week).length,
      avgAiLen: metrics.avgLen,
      questionRate: metrics.questionRate,
      multiLineRate: metrics.multiLineRate,
      repeatOpenRate: metrics.repeatOpenRate,
      stageDist,
      updatedAt: new Date(load().at).toISOString(),
    }
  }

  function users({q = '', enabled = '', page = 1, size = 20} = {}) {
    const all = load().users
    const kw = String(q || '').trim().toLowerCase()
    let list = all
    if (kw) list = list.filter((u) => u.uid.toLowerCase().includes(kw) || String(u.name).toLowerCase().includes(kw))
    if (enabled === '1' || enabled === 'true') list = list.filter((u) => u.enabled)
    if (enabled === '0' || enabled === 'false') list = list.filter((u) => !u.enabled)
    const pageN = Math.max(1, Number(page) || 1)
    const sizeN = Math.min(100, Math.max(5, Number(size) || 20))
    const start = (pageN - 1) * sizeN
    return {total: list.length, page: pageN, size: sizeN, list: list.slice(start, start + sizeN)}
  }

  function messages(uid, {page = 1, size = 50} = {}) {
    const conv = readJson(path.join(usersDir, String(uid), 'conversation.json'), {}) || {}
    const all = (Array.isArray(conv.recentMessages) ? conv.recentMessages : []).map((m, i) => ({
      index: i,
      role: m?.role === 'assistant' ? 'assistant' : 'user',
      text: String(m?.text || ''),
      len: String(m?.text || '').length,
      at: m?.at || m?.time || null,
    }))
    const pageN = Math.max(1, Number(page) || 1)
    const sizeN = Math.min(200, Math.max(10, Number(size) || 50))
    const start = Math.max(0, all.length - pageN * sizeN)
    const end = Math.max(0, all.length - (pageN - 1) * sizeN)
    return {total: all.length, page: pageN, size: sizeN, list: all.slice(start, end)}
  }

  function insights() {
    const {users, metrics, globalEnabled} = load()
    const m = metrics
    const issues = []
    if (m.count >= 5) {
      if (m.avgLen > 90) {
        issues.push({level: 'warn', title: '回复偏长', detail: `平均 ${m.avgLen} 字，仍有小作文倾向`, suggestion: '可把 replyMaxLen 降到 90，或强化层 10 短句约束'})
      }
      if (m.questionRate > 0.6) {
        issues.push({level: 'warn', title: '反问过密', detail: `${Math.round(m.questionRate * 100)}% 的回复带问号`, suggestion: '最多一个问号，允许只接情绪不接话'})
      }
      if (m.multiLineRate > 0.5) {
        issues.push({level: 'warn', title: '爱拆行', detail: `${Math.round(m.multiLineRate * 100)}% 的回复用换行拆成多行`, suggestion: '约束"一句话一条"，禁止用换行拆句'})
      }
      if (m.repeatOpenRate > 0.25 && m.openings?.length) {
        const top = m.openings.map((o) => `${o.prefix}…×${o.count}`).join('、')
        issues.push({level: 'warn', title: '开头模板化', detail: `高频开头：${top}`, suggestion: '注入"最近常用开头"提示，强制换说法'})
      }
      if (m.codeBlockRate > 0.15) {
        issues.push({level: 'info', title: '代码块偏多', detail: `${Math.round(m.codeBlockRate * 100)}% 的回复含代码块`, suggestion: '代码类需求给极短片段或文件'})
      }
    }
    const noName = users.filter((u) => u.msgs > 0 && u.name === u.uid)
    if (noName.length) {
      issues.push({level: 'info', title: '昵称缺失', detail: `${noName.length} 个有聊天记录的用户没采集到昵称`, suggestion: '下次发言可由好友列表补全'})
    }
    const idle = users.filter((u) => u.enabled && u.lastAt && Date.now() - u.lastAt > 7 * 86400000)
    if (idle.length) {
      issues.push({level: 'info', title: '启用但长期未互动', detail: `${idle.length} 位用户已开启但超过 7 天没说话`, suggestion: '可在用户表中按需关闭'})
    }
    if (!globalEnabled) {
      issues.push({level: 'info', title: '全局私聊已关闭', detail: '仅显式开启的用户会得到回复', suggestion: '在配置页打开主开关，或逐个开启'})
    }
    return {
      metrics: {
        aiMessages: m.count,
        avgLen: m.avgLen,
        maxLen: m.maxLen,
        questionRate: m.questionRate,
        multiLineRate: m.multiLineRate,
        codeBlockRate: m.codeBlockRate,
        repeatOpenRate: m.repeatOpenRate,
      },
      openings: m.openings || [],
      issues,
      samples: users.filter((u) => u.msgs > 0).slice(0, 6).map((u) => ({uid: u.uid, name: u.name, sample: u.sample})),
      updatedAt: new Date().toISOString(),
    }
  }

  /** 写用户开关（与全局一致 → 删除覆盖，与插件内 UserFlags 同语义） */
  function setEnabled(uid, enabled) {
    const id = String(uid || '')
    if (!id) throw new Error('uid 不能为空')
    const on = !!enabled
    const {globalEnabled} = load()
    const flags = readJson(flagsFile, {}) || {}
    if (on === globalEnabled) delete flags[id]
    else flags[id] = {...(flags[id] || {}), enabled: on}
    writeJson(flagsFile, flags)
    invalidate()
    return {uid: id, enabled: on, followsGlobal: on === globalEnabled}
  }

  return {overview, users, messages, insights, setEnabled, invalidate}
}
