import {Service} from '#guoba.framework'
import {_paths} from '#guoba.platform'
import path from 'node:path'
import fs from 'node:fs'

/**
 * 荧（YingAI）心智服务 —— 记忆 / 关系 / 情绪的只读观测面板数据源
 *
 * 数据目录（零侵入，只读 YingAI 落盘数据）：
 *   <plugins>/YingAI/data/
 *     memory/<gid>.json          { memories: [{text, value, tier, createdAt, lastTouched, consolidation}] }
 *     relationships/<gid>/bot.json       { [uid]: {trust, affection, affinity, friction, interactionCount, ...} }
 *     relationships/<gid>/milestones.json{ [uid]: [{type, description, importance, timestamp}] }
 *     emotion/<gid>.json         { mood, value, updatedAt }
 *     groups/<gid>.json          { enabled, driveEnabled, ... }
 *
 * 只读 + 容错：文件可能在 Bot 运行时被 YingAI 并发重写，读失败就跳过该文件，绝不抛错影响后台。
 * 探针/测试文件（__probe_ / test_ 前缀）一律剔除。
 */
export class YingMindService extends Service {

  constructor(app) {
    super(app)
    this.dataDir = path.resolve(_paths.pluginRoot, '..', 'YingAI', 'data')
  }

  get bot() {
    return globalThis.Bot ?? null
  }

  /* ---------------------------------------------------------------- 工具 */

  _readJson(file) {
    try {
      const raw = fs.readFileSync(file, 'utf8')
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  _isProbeGid(gid) {
    const g = String(gid || '')
    if (!g) return true
    // 探针/测试：__probe_、probe_、test_ 前缀，以及 v10p5 这类版本探针
    return /^__probe_/.test(g) || /^probe_/.test(g) || /^test_/.test(g) || /^v\d+p\d+/.test(g)
  }

  /** 目录里所有「真实群」的磁盘基名（文件去 .json，目录保留原名；剔除探针） */
  _realGids(dir) {
    let files = []
    try { files = fs.readdirSync(dir) } catch { return [] }
    return files
      .map((f) => f.replace(/\.json$/, ''))
      .filter((g) => !this._isProbeGid(g))
  }

  /** 对外 gid 归一（去 @chatroom） */
  _norm(g) {
    return String(g || '').replace('@chatroom', '')
  }

  /** 把归一 gid 还原成磁盘名：优先带 @chatroom 的文件/目录，否则原名 */
  _diskName(gid, dir) {
    const g = this._norm(gid)
    for (const c of [g + '@chatroom', g]) {
      const base = path.join(this.dataDir, dir, c)
      if (fs.existsSync(base) || fs.existsSync(base + '.json')) return c
    }
    return g
  }

  /** 数值清洗：非有限值回落默认值，再夹到 [min, max] */
  _num(v, def, min, max) {
    const n = Number(v)
    if (!Number.isFinite(n)) return def
    return Math.min(max, Math.max(min, n))
  }

  /** 备份目录时间戳：YYYYMMDD_HHmmss */
  _stamp(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  }

  /** 重复检测指纹：去空白与常见标点、转小写，取前 40 字 */
  _fingerprint(text) {
    return String(text || '')
      .replace(/\s+/g, '')
      .replace(/[，。、；：！？…—～·,.;:!?()\[\]{}<>《》【】（）「」“”"'`~@#$%^&*_+=|\\/-]/g, '')
      .toLowerCase()
      .slice(0, 40)
  }

  /** 群名：群名无持久化，唯一来源是运行时 Bot[uin].gl */
  _groupName(gid) {
    const raw = String(gid || '')
    if (!raw) return ''
    for (const bot of Object.values(this.bot ?? {})) {
      const gl = bot?.gl
      if (!gl?.get) continue
      for (const k of [raw, Number(raw), raw + '@chatroom']) {
        const g = gl.get(k)
        if (g?.group_name) return String(g.group_name)
      }
    }
    return ''
  }

  /* ---------------------------------------------------------------- 对外查询 */

  /**
   * 有记忆/关系/情绪数据的群列表，附群名 + 各维度概览（记忆条数 / 关系人数 / 情绪值）
   */
  groups() {
    const gidSet = new Set([
      ...this._realGids(path.join(this.dataDir, 'memory')),
      ...this._realGids(path.join(this.dataDir, 'relationships')),
      ...this._realGids(path.join(this.dataDir, 'emotion')),
    ])
    const out = []
    for (const diskGid of gidSet) {
      const gid = this._norm(diskGid)
      const mem = this._readJson(path.join(this.dataDir, 'memory', `${diskGid}.json`))
      const rel = this._readJson(path.join(this.dataDir, 'relationships', diskGid, 'bot.json'))
      const emo = this._readJson(path.join(this.dataDir, 'emotion', `${diskGid}.json`))
      const memoryCount = mem?.memories?.length ?? 0
      const relationCount = rel ? Object.keys(rel).length : 0
      const mood = emo?.mood ?? ''
      // 三样全空的群（如空目录 tg_dim）不展示
      if (!memoryCount && !relationCount && !mood) continue
      out.push({
        gid,
        name: this._groupName(gid),
        memoryCount,
        relationCount,
        mood,
        moodValue: Number(emo?.value) || 0,
      })
    }
    // 记忆条数多的排前
    out.sort((a, b) => b.memoryCount - a.memoryCount || b.relationCount - a.relationCount)
    return out
  }

  /**
   * 某群的记忆列表（按 value 重要度降序）
   */
  memories(gid) {
    const g = this._norm(gid)
    if (this._isProbeGid(g)) return []
    const disk = this._diskName(g, 'memory')
    const d = this._readJson(path.join(this.dataDir, 'memory', `${disk}.json`))
    const list = (d?.memories ?? []).map((m, i) => ({
      id: i,
      text: String(m.text ?? ''),
      value: Number(m.value) || 0,
      tier: String(m.tier ?? ''),
      createdAt: Number(m.createdAt) || 0,
      lastTouched: Number(m.lastTouched) || 0,
      consolidation: Number(m.consolidation) || 0,
    }))
    list.sort((a, b) => b.value - a.value)
    return list
  }

  /**
   * 某群的关系列表（按 affinity 亲密度降序）+ 里程碑
   */
  relations(gid) {
    const g = this._norm(gid)
    if (this._isProbeGid(g)) return { list: [], milestones: {} }
    const disk = this._diskName(g, 'relationships')
    const bot = this._readJson(path.join(this.dataDir, 'relationships', disk, 'bot.json'))
    const ms = this._readJson(path.join(this.dataDir, 'relationships', disk, 'milestones.json'))
    const list = Object.entries(bot ?? {}).map(([uid, r]) => ({
      uid,
      trust: Number(r?.trust) || 0,
      affection: Number(r?.affection) || 0,
      affinity: Number(r?.affinity) || 0,
      friction: Number(r?.friction) || 0,
      interactionCount: Number(r?.interactionCount) || 0,
      activeDays: Array.isArray(r?.activeDays) ? r.activeDays.length : 0,
      lastInteractionAt: Number(r?.lastInteractionAt) || 0,
      interactionTypes: r?.interactionTypes ?? {},
    }))
    list.sort((a, b) => b.affinity - a.affinity)
    return { list, milestones: ms ?? {} }
  }

  /** 某群的情绪快照 */
  emotion(gid) {
    const g = this._norm(gid)
    if (this._isProbeGid(g)) return { mood: '', value: 0, updatedAt: 0 }
    const disk = this._diskName(g, 'emotion')
    const d = this._readJson(path.join(this.dataDir, 'emotion', `${disk}.json`))
    return {
      mood: String(d?.mood ?? ''),
      value: Number(d?.value) || 0,
      updatedAt: Number(d?.updatedAt) || 0,
    }
  }

  /**
   * 记忆体检（只读）：扫出低价值 / 陈旧 / 未巩固 / 跨群重复的候选清理条目。
   *
   * 探针/测试文件只统计条数（probeFiles），既不进 candidates 也不参与清理。
   * candidates.index 是该群 memories 数组的原始下标，清理接口直接拿它删，所以先记下标再排序。
   */
  health(gid = '', opts = {}) {
    const now = Date.now()
    const staleDays = this._num(opts?.staleDays, 45, 1, 3650)
    const lowValue = this._num(opts?.lowValue, 0.35, 0, 1)
    const minAge = this._num(opts?.minAge, 7, 0, 3650)
    const staleMs = staleDays * 86400000
    const minAgeMs = minAge * 86400000

    const normGid = this._norm(gid)
    const scope = normGid ? 'group' : 'all'
    const memDir = path.join(this.dataDir, 'memory')

    let bases = []
    try {
      bases = fs.readdirSync(memDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''))
    } catch { bases = [] }

    // 探针文件：单独归档，不进 candidates、不参与清理（整文件删风险太高）
    const probeFiles = []
    for (const base of bases) {
      if (!this._isProbeGid(base)) continue
      const d = this._readJson(path.join(memDir, `${base}.json`))
      probeFiles.push({file: base, count: (d?.memories ?? []).length})
    }
    probeFiles.sort((a, b) => b.count - a.count)
    const probeTotal = probeFiles.reduce((s, p) => s + p.count, 0)

    // 真实群：all 扫全量；group 只扫一个（探针 gid 不给扫）
    const targets = scope === 'group'
      ? (this._isProbeGid(normGid) ? [] : [this._diskName(normGid, 'memory')])
      : this._realGids(memDir)

    const byTier = {short: 0, mid: 0, long: 0, unknown: 0}
    const entries = []
    let groups = 0

    for (const disk of targets) {
      const d = this._readJson(path.join(memDir, `${disk}.json`))
      if (!Array.isArray(d?.memories)) continue
      groups++
      const g = this._norm(disk)
      const gname = this._groupName(g)
      d.memories.forEach((m, index) => {
        const tier = String(m?.tier ?? '')
        const createdAt = Number(m?.createdAt) || 0
        const lastTouched = Number(m?.lastTouched) || 0
        const value = Number(m?.value) || 0
        const consolidation = Number(m?.consolidation) || 0
        const ageDays = createdAt ? Math.floor((now - createdAt) / 86400000) : 0
        const reasons = []
        if (value < lowValue) reasons.push('lowValue')
        if (now - (lastTouched || createdAt) > staleMs) reasons.push('stale')
        if (consolidation === 0 && now - createdAt > minAgeMs) reasons.push('unconsolidated')
        entries.push({
          gid: g,
          gname,
          index,
          text: String(m?.text ?? ''),
          value,
          tier,
          createdAt,
          lastTouched,
          consolidation,
          ageDays,
          reasons,
          dupWith: [],
        })
        byTier[tier === 'short' || tier === 'mid' || tier === 'long' ? tier : 'unknown']++
      })
    }

    // 跨群重复：同一指纹出现在 ≥2 个不同 gid 才算重复（同群内重复不算）
    const fpMap = new Map()
    for (const e of entries) {
      const fp = this._fingerprint(e.text)
      if (!fp) continue
      if (!fpMap.has(fp)) fpMap.set(fp, [])
      fpMap.get(fp).push(e)
    }
    for (const list of fpMap.values()) {
      const gids = [...new Set(list.map((e) => e.gid))]
      if (gids.length < 2) continue
      for (const e of list) {
        e.reasons.push('duplicate')
        e.dupWith = gids.filter((g) => g !== e.gid).slice(0, 5)
      }
    }

    const issues = {lowValue: 0, stale: 0, unconsolidated: 0, duplicate: 0, probe: probeTotal}
    for (const e of entries) {
      for (const r of e.reasons) if (issues[r] !== undefined) issues[r]++
    }

    const total = entries.length
    const flagged = entries.filter((e) => e.reasons.length > 0)
    // 分数按「全部命中数」算，列表只截断展示，避免候选 >200 时分数失真
    const score = total ? Math.max(0, Math.min(100, Math.round(100 * (1 - flagged.length / total)))) : 100

    flagged.sort((a, b) => a.value - b.value || b.ageDays - a.ageDays)

    return {
      scope,
      gid: scope === 'group' ? normGid : '',
      total,
      groups,
      byTier,
      score,
      issues,
      candidates: flagged.slice(0, 200).map((e) => ({
        gid: e.gid,
        gname: e.gname,
        index: e.index,
        text: e.text,
        value: e.value,
        tier: e.tier,
        createdAt: e.createdAt,
        lastTouched: e.lastTouched,
        ageDays: e.ageDays,
        reasons: e.reasons,
        dupWith: e.dupWith,
      })),
      probeFiles,
    }
  }

  /* ---------------------------------------------------------------- 干预（写操作） */

  /**
   * 原子写 JSON：tmp + rename，YingAI 整文件重写时最坏只丢一次我们的小改动，
   * 不会留半截文件。调用前先重读最新内容，把竞态窗口压到毫秒级。
   */
  _writeJson(file, data) {
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  }

  _memoryFile(gid) {
    const g = this._norm(gid)
    if (this._isProbeGid(g)) throw new Error('不存在的记忆文件')
    const disk = this._diskName(g, 'memory')
    const file = path.join(this.dataDir, 'memory', `${disk}.json`)
    if (!fs.existsSync(file)) throw new Error('这个群还没有记忆文件')
    return file
  }

  /**
   * 删除一条记忆。oldText 用于校验列表没有漂移（YingAI 会在后台增删记忆）。
   */
  async deleteMemory(gid, index, oldText = '') {
    const file = this._memoryFile(gid)
    const d = this._readJson(file)
    if (!d || !Array.isArray(d.memories)) throw new Error('记忆文件结构异常')
    const i = Number(index)
    if (!Number.isInteger(i) || i < 0 || i >= d.memories.length) throw new Error('记忆序号越界，请刷新后重试')
    if (oldText && String(d.memories[i]?.text || '').slice(0, 60) !== String(oldText).slice(0, 60)) {
      throw new Error('记忆列表已发生变化，请刷新后重试')
    }
    const [removed] = d.memories.splice(i, 1)
    this._writeJson(file, d)
    logger?.mark?.(`[YingMind] 已删除记忆 ${this._norm(gid)}#${i}: ${String(removed?.text || '').slice(0, 30)}...`)
    return { text: String(removed?.text || ''), remaining: d.memories.length }
  }

  /**
   * 批量清理记忆（体检候选）。
   *
   * keys = [{gid, index, oldText}]，index 来自 health().candidates 的原始下标。
   * 流程：先整文件备份 → 按群分组、每群只读一次 → 组内 index 降序删（防数组位移）→ 原子写回。
   * oldText 前 60 字对不上就跳过该条（YingAI 并发增删导致的漂移），不抛错。
   */
  async cleanupMemories(keys, opts = {}) {
    const list = Array.isArray(keys) ? keys : []
    if (!list.length) throw new Error('没有需要清理的记忆')
    if (list.length > 300) throw new Error('单次最多清理 300 条')

    // 按群分组（探针 gid / 空 gid 直接忽略）
    const byGid = new Map()
    for (const k of list) {
      const g = this._norm(k?.gid)
      if (!g || this._isProbeGid(g)) continue
      if (!byGid.has(g)) byGid.set(g, [])
      byGid.get(g).push(k)
    }
    if (!byGid.size) throw new Error('没有可清理的记忆')

    const backupDir = path.join(this.dataDir, '_backup_memory_cleanup_' + this._stamp())
    fs.mkdirSync(backupDir, {recursive: true})

    let removed = 0
    let skipped = 0
    const files = []

    for (const [g, arr] of byGid) {
      const disk = this._diskName(g, 'memory')
      const file = path.join(this.dataDir, 'memory', `${disk}.json`)
      if (!fs.existsSync(file)) {
        skipped += arr.length
        continue
      }
      // 备份必须先成功，失败则整群不动
      try {
        fs.copyFileSync(file, path.join(backupDir, `${disk}.json`))
      } catch {
        skipped += arr.length
        continue
      }
      const d = this._readJson(file)
      if (!d || !Array.isArray(d.memories)) {
        skipped += arr.length
        continue
      }
      const seen = new Set()
      const items = []
      for (const k of arr) {
        const i = Number(k?.index)
        if (!Number.isInteger(i) || i < 0) { skipped++; continue }
        if (seen.has(i)) continue
        seen.add(i)
        items.push([i, k])
      }
      items.sort((a, b) => b[0] - a[0])
      let removedInGroup = 0
      for (const [i, k] of items) {
        const m = d.memories[i]
        if (!m) { skipped++; continue }
        if (String(m.text ?? '').slice(0, 60) !== String(k?.oldText ?? '').slice(0, 60)) {
          skipped++
          continue
        }
        d.memories.splice(i, 1)
        removed++
        removedInGroup++
      }
      // 整群全部漂移跳过时不回写，避免把读到的旧快照盖回 YingAI 的新内容
      if (!removedInGroup) continue
      // 删空也写回 {memories: []}，保持文件结构
      this._writeJson(file, d)
      files.push(path.basename(file))
    }

    // 重新扫一遍真实群，给出清理后的总量
    const memDir = path.join(this.dataDir, 'memory')
    let remainingTotal = 0
    for (const disk of this._realGids(memDir)) {
      const d = this._readJson(path.join(memDir, `${disk}.json`))
      if (Array.isArray(d?.memories)) remainingTotal += d.memories.length
    }

    logger?.mark?.(`[YingMind] 记忆体检清理：删除 ${removed} 条，备份 ${backupDir}`)
    return {removed, skipped, files, backupDir, remainingTotal}
  }

  /**
   * 编辑记忆（文本 / 重要度 0~1）。oldText 同样做漂移校验。
   */
  async updateMemory(gid, index, patch = {}, oldText = '') {
    const file = this._memoryFile(gid)
    const d = this._readJson(file)
    if (!d || !Array.isArray(d.memories)) throw new Error('记忆文件结构异常')
    const i = Number(index)
    if (!Number.isInteger(i) || i < 0 || i >= d.memories.length) throw new Error('记忆序号越界，请刷新后重试')
    if (oldText && String(d.memories[i]?.text || '').slice(0, 60) !== String(oldText).slice(0, 60)) {
      throw new Error('记忆列表已发生变化，请刷新后重试')
    }
    const m = d.memories[i]
    if (typeof patch.text === 'string' && patch.text.trim()) {
      m.text = patch.text.trim()
    }
    if (patch.value !== undefined && patch.value !== null && patch.value !== '') {
      const v = Number(patch.value)
      if (!Number.isFinite(v) || v < 0 || v > 100) throw new Error('重要度需在 0~100 之间')
      m.value = v / 100
    }
    this._writeJson(file, d)
    logger?.mark?.(`[YingMind] 已编辑记忆 ${this._norm(gid)}#${i}`)
    return { text: m.text, value: m.value }
  }

  /**
   * 手动校正情绪（mood 文案 / value 0~100）。
   */
  async setEmotion(gid, {mood, value} = {}) {
    const g = this._norm(gid)
    if (this._isProbeGid(g)) throw new Error('不存在的情绪文件')
    const disk = this._diskName(g, 'emotion')
    const file = path.join(this.dataDir, 'emotion', `${disk}.json`)
    let d = this._readJson(file) || {}
    if (mood !== undefined && mood !== null && mood !== '') {
      d.mood = String(mood).trim().slice(0, 12)
    }
    if (value !== undefined && value !== null && value !== '') {
      const v = Number(value)
      if (!Number.isFinite(v) || v < 0 || v > 100) throw new Error('情绪值需在 0~100 之间')
      d.value = v
    }
    d.updatedAt = Date.now()
    this._writeJson(file, d)
    logger?.mark?.(`[YingMind] 已校正情绪 ${g}: ${d.mood} ${d.value}`)
    return { mood: d.mood, value: d.value }
  }
}

export default YingMindService
