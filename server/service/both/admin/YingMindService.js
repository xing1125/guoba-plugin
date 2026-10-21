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
