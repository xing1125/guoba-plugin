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
    return !g || /^__probe_/.test(g) || /^test_/.test(g)
  }

  /** 目录里所有「真实群」的 gid（去掉 @chatroom 后缀，剔除探针文件） */
  _realGids(dir) {
    let files = []
    try { files = fs.readdirSync(dir) } catch { return [] }
    return files
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .map((g) => g.replace('@chatroom', ''))
      .filter((g) => !this._isProbeGid(g))
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
    for (const gid of gidSet) {
      const mem = this._readJson(path.join(this.dataDir, 'memory', `${gid}.json`))
      const rel = this._readJson(path.join(this.dataDir, 'relationships', gid, 'bot.json'))
      const emo = this._readJson(path.join(this.dataDir, 'emotion', `${gid}.json`))
      out.push({
        gid,
        name: this._groupName(gid),
        memoryCount: mem?.memories?.length ?? 0,
        relationCount: rel ? Object.keys(rel).length : 0,
        mood: emo?.mood ?? '',
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
    const g = String(gid || '').replace('@chatroom', '')
    if (this._isProbeGid(g)) return []
    const d = this._readJson(path.join(this.dataDir, 'memory', `${g}.json`))
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
    const g = String(gid || '').replace('@chatroom', '')
    if (this._isProbeGid(g)) return { list: [], milestones: {} }
    const bot = this._readJson(path.join(this.dataDir, 'relationships', g, 'bot.json'))
    const ms = this._readJson(path.join(this.dataDir, 'relationships', g, 'milestones.json'))
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
    const g = String(gid || '').replace('@chatroom', '')
    if (this._isProbeGid(g)) return { mood: '', value: 0, updatedAt: 0 }
    const d = this._readJson(path.join(this.dataDir, 'emotion', `${g}.json`))
    return {
      mood: String(d?.mood ?? ''),
      value: Number(d?.value) || 0,
      updatedAt: Number(d?.updatedAt) || 0,
    }
  }
}

export default YingMindService
