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
  const over40 = list.filter((t) => String(t).length > 40).length
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
    over40Rate: Math.round((over40 / n) * 1000) / 1000,
    questionRate: Math.round((question / n) * 1000) / 1000,
    multiLineRate: Math.round((multiLine / n) * 1000) / 1000,
    codeBlockRate: Math.round((codeBlock / n) * 1000) / 1000,
    // 语义：含高频模板片段（3-gram）的回复占比，不是"开头重复率"
    repeatOpenRate: Math.round((hotReplyCount / n) * 1000) / 1000,
    openings: templates.map(([k, c]) => ({prefix: k, count: c})),
  }
}

/** 比例 → 百分数（保留 1 位） */
const pct = (x) => Math.round((x || 0) * 1000) / 10

/**
 * 打磨优先级打分（0~100，越大越该修）
 * 与群聊端 `diagStats.groupCompare` 同构：越像 AI 的签名权重越高。
 * 私聊端没有 review/重答/回退这类运行时信号，只有文本，故只用 4 个文本签名。
 */
function scoreOf(s) {
  if (!s || !s.count) return 0
  const v = pct(s.questionRate) * 0.4 + pct(s.multiLineRate) * 0.4
    + pct(s.repeatOpenRate) * 0.5 + pct(s.over40Rate) * 0.3
  return Math.round(Math.min(100, v) * 10) / 10
}

/** 全体均值（单用户视角的对照基准） */
function baselineOf(m) {
  return {
    avg: m.avgLen,
    over40: pct(m.over40Rate),
    question: pct(m.questionRate),
    multi: pct(m.multiLineRate),
    tpl: pct(m.repeatOpenRate),
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
      const style = styleOf(ai)
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
        style,
        score: scoreOf(style),
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

  /**
   * 用户对比（综合视图）：每个有回复的用户一行，按打磨优先级降序。
   * 与群聊端 `groupCompare` 同构——label/n/avg/over40/score 字段名保持一致，便于两边心智统一。
   */
  function compare() {
    const {users, metrics} = load()
    const list = users
      .filter((u) => u.aiMsgs > 0)
      .map((u) => {
        const s = u.style
        // uid 后缀去掉再取尾号：否则 2598…@openim 一律变成 "openim"，互相撞名
        const stem = String(u.uid).replace(/@(openim|chatroom)$/i, '')
        const short = stem.length > 6 ? stem.slice(-6) : stem
        return {
          uid: u.uid,
          name: u.name,
          label: u.name !== u.uid ? u.name : `…${short}`,
          short,
          n: u.aiMsgs,
          avg: s.avgLen,
          over40: pct(s.over40Rate),
          question: pct(s.questionRate),
          multi: pct(s.multiLineRate),
          tpl: pct(s.repeatOpenRate),
          score: u.score,
          stage: u.stage,
          enabled: u.enabled,
          lastAt: u.lastAt,
        }
      })
      .sort((a, b) => b.score - a.score || b.n - a.n)
    return {
      total: list.length,
      baseline: {
        avg: metrics.avgLen,
        over40: pct(metrics.over40Rate),
        question: pct(metrics.questionRate),
        multi: pct(metrics.multiLineRate),
        tpl: pct(metrics.repeatOpenRate),
      },
      list,
    }
  }

  /** 诊断结论：uid 为空 = 综合（全体），否则 = 单用户视角（与全体均值逐项对照） */
  function insights(uid = '') {
    const {users, metrics, globalEnabled} = load()
    const all = users.filter((u) => u.aiMsgs > 0)
    const key = String(uid || '')
    const target = key ? all.find((u) => u.uid === key) : null
    if (key && !target) {
      return {
        uid: key,
        missing: true,
        metrics: {aiMessages: 0, avgLen: 0, maxLen: 0, over40Rate: 0, questionRate: 0, multiLineRate: 0, codeBlockRate: 0, repeatOpenRate: 0},
        baseline: baselineOf(metrics),
        openings: [],
        issues: [{level: 'info', title: '该用户暂无回复记录', detail: '当前视角下没有可统计的荧回复', suggestion: '切回"全体"，或等该用户产生对话后再看'}],
        samples: [],
        updatedAt: new Date().toISOString(),
      }
    }
    const m = target ? target.style : metrics
    const base = baselineOf(metrics)
    const issues = []
    const vs = (mine, their) => `本视角 ${mine}% vs 全体 ${their}%`

    if (target) {
      // ── 单用户：只报「比全体更差」的项，避免把全局问题重复塞给每个人 ──
      if (m.count < 5) {
        issues.push({level: 'info', title: '样本偏少', detail: `仅 ${m.count} 条回复，比例类指标波动大`, suggestion: '先积累对话再判断，别急着调'})
      }
      if (m.avgLen > 40 && m.avgLen > base.avg * 1.2) {
        issues.push({level: 'warn', title: '回复偏长', detail: `平均 ${m.avgLen} 字（全体 ${base.avg} 字）`, suggestion: '该用户对话更该短句，检查是否被长上下文带着写作文'})
      }
      if (pct(m.questionRate) >= 50 && pct(m.questionRate) > base.question) {
        issues.push({level: 'warn', title: '反问过密', detail: `${vs(pct(m.questionRate), base.question)}，${m.count} 条里 ${Math.round(m.questionRate * m.count)} 条带问号`, suggestion: '一轮最多一个问号，允许只接情绪不接话'})
      }
      if (pct(m.multiLineRate) >= 30 && pct(m.multiLineRate) > base.multi) {
        issues.push({level: 'warn', title: '爱拆行', detail: `${vs(pct(m.multiLineRate), base.multi)}，用换行把一句话拆成多行`, suggestion: '约束"一句话一条"，禁止用换行拆句'})
      }
      if (pct(m.repeatOpenRate) >= 30 && pct(m.repeatOpenRate) > base.tpl) {
        const top = (m.openings || []).slice(0, 3).map((o) => `${o.prefix}…×${o.count}`).join('、')
        issues.push({level: 'warn', title: '模板句复发', detail: `${vs(pct(m.repeatOpenRate), base.tpl)}${top ? `；高频片段：${top}` : ''}`, suggestion: '反模板提示对该用户生效不足，可单独关注其对话'})
      }
      if (m.codeBlockRate > 0.15) {
        issues.push({level: 'info', title: '代码块偏多', detail: `${pct(m.codeBlockRate)}% 的回复含代码块`, suggestion: '代码类需求给极短片段或文件'})
      }
      if (!issues.some((i) => i.level === 'warn') && m.count >= 5) {
        issues.push({level: 'ok', title: '风格健康', detail: '四项签名均未高于全体均值', suggestion: '可作为其他用户的对照样本'})
      }
      if (target.enabled === false) {
        issues.push({level: 'info', title: '该用户私聊已关闭', detail: '不会得到任何回复', suggestion: '需要时在用户表打开开关'})
      }
    } else {
      // ── 综合：全局规则 + 跨用户结论 ──
      // 阈值按私聊实况定标（实测全体：均长 30 字 / 问号 59% / 换行 34% / 模板 22%），
      // 原来的 90 字 / 60% 问号这类"网站文案级"阈值在私聊里永远不触发，等于没诊断。
      if (m.count >= 5) {
        if (m.avgLen > 50) {
          issues.push({level: 'warn', title: '回复偏长', detail: `平均 ${m.avgLen} 字，仍有小作文倾向`, suggestion: '可把 replyMaxLen 降到 90，或强化层 10 短句约束'})
        }
        if (m.questionRate > 0.4) {
          issues.push({level: 'warn', title: '反问过密', detail: `${pct(m.questionRate)}% 的回复带问号`, suggestion: '最多一个问号，允许只接情绪不接话'})
        }
        if (m.multiLineRate > 0.3) {
          issues.push({level: 'warn', title: '爱拆行', detail: `${pct(m.multiLineRate)}% 的回复用换行拆成多行`, suggestion: '约束"一句话一条"，禁止用换行拆句'})
        }
        if (m.repeatOpenRate > 0.2 && m.openings?.length) {
          const top = m.openings.map((o) => `${o.prefix}…×${o.count}`).join('、')
          issues.push({level: 'warn', title: '模板句复发', detail: `含高频片段的回复占 ${pct(m.repeatOpenRate)}%：${top}`, suggestion: '注入"最近常用片段"提示，强制换说法'})
        }
        if (m.over40Rate > 0.25) {
          issues.push({level: 'warn', title: '超 40 字偏多', detail: `${pct(m.over40Rate)}% 的回复超过 40 字`, suggestion: '私聊更像微信，控制在 1~2 句'})
        }
        if (m.codeBlockRate > 0.15) {
          issues.push({level: 'info', title: '代码块偏多', detail: `${pct(m.codeBlockRate)}% 的回复含代码块`, suggestion: '代码类需求给极短片段或文件'})
        }
      }
      // 跨用户结论：最需打磨 / 最像真人（样本 >=3 才有意义；私聊对话天生比群聊短）
      const eligible = all.filter((u) => u.aiMsgs >= 3)
      if (eligible.length >= 2) {
        const worst = eligible.reduce((a, b) => (b.score > a.score ? b : a))
        const best = eligible.reduce((a, b) => (b.score < a.score ? b : a))
        if (worst.score > 0) {
          issues.push({
            level: 'warn',
            title: '最需打磨的用户',
            detail: `${worst.name}（${worst.aiMsgs} 条，优先级 ${worst.score}：问号 ${pct(worst.style.questionRate)}% / 模板 ${pct(worst.style.repeatOpenRate)}%）`,
            suggestion: '点下方"用户对比"里该行可切到单人视角看细节',
          })
        }
        if (best.uid !== worst.uid) {
          issues.push({
            level: 'ok',
            title: '最像真人的用户',
            detail: `${best.name}（${best.aiMsgs} 条，优先级 ${best.score}）`,
            suggestion: '对照这组对话的句式，反推该收什么、该放什么',
          })
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
    }

    return {
      uid: target ? target.uid : '',
      scope: target ? 'user' : 'all',
      metrics: {
        aiMessages: m.count,
        avgLen: m.avgLen,
        maxLen: m.maxLen,
        over40Rate: m.over40Rate,
        questionRate: m.questionRate,
        multiLineRate: m.multiLineRate,
        codeBlockRate: m.codeBlockRate,
        repeatOpenRate: m.repeatOpenRate,
      },
      baseline: base,
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

  return {overview, users, messages, compare, insights, setEnabled, invalidate}
}
