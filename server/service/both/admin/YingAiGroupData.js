import fs from 'fs'
import path from 'path'
import {pathToFileURL} from 'url'

/**
 * YingAI 群聊（diag 聊天记录）数据层 —— 纯 fs + 动态载入口径模块，不依赖锅巴框架，可独立测试
 *
 * 数据源：<pluginDir>/data/diag/YYYY-MM-DD.jsonl
 * 口径：<pluginDir>/dashboard/diagStats.mjs（离线构建与后端共用同一份实现，避免双份漂移）
 */

const CACHE_TTL = 5000

let _statsMod = null
async function loadStats(pluginDir) {
  if (_statsMod) return _statsMod
  const file = path.join(pluginDir, 'dashboard', 'diagStats.mjs')
  _statsMod = await import(pathToFileURL(file).href)
  return _statsMod
}

/** 群名映射：优先运行时 Bot.gl，其次 data/groups 目录里能查到的昵称字段，最后退回 gid 尾号 */
function buildGroupNames(pluginDir) {
  const map = new Map()
  try {
    const gl = globalThis.Bot?.gl
    if (gl && typeof gl.forEach === 'function') {
      gl.forEach((v, k) => {
        const name = v?.group_name || v?.groupName || v?.name
        if (k && name) map.set(String(k), String(name))
      })
    }
  } catch {}
  try {
    const dir = path.join(pluginDir, 'data', 'groups')
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || f.startsWith('__probe') || /probe/i.test(f)) continue
      const gid = f.replace(/\.json$/, '')
      if (map.has(gid)) continue
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
        const name = j?.groupName || j?.group_name || j?.name
        if (name) map.set(gid, String(name))
      } catch {}
    }
  } catch {}
  return map
}

export function createYingAiGroupData(pluginDir) {
  const diagDir = path.join(pluginDir, 'data', 'diag')

  let cache = null
  let cacheAt = 0
  let inflight = null

  /**
   * 缓存键 = days|from|to|gid；同一组合 5s 内复用
   * @param {{days?:number, from?:string, to?:string, gid?:string}} q
   */
  async function load(q = {}) {
    const key = `${q.days || 0}|${q.from || ''}|${q.to || ''}|${q.gid || ''}`
    if (cache && cache.key === key && Date.now() - cacheAt < CACHE_TTL) return cache
    if (inflight && inflight.key === key) return inflight.promise

    const promise = (async () => {
      const stats = await loadStats(pluginDir)
      const {rows, files} = stats.readRows(diagDir, {days: q.days, from: q.from, to: q.to})
      const names = buildGroupNames(pluginDir)
      const decorated = rows.map((r) => ({...r, _gname: names.get(String(r.gid || '')) || ''}))
      const out = {
        key,
        stats,
        rows: decorated,
        files,
        names,
        at: Date.now(),
      }
      cache = out
      cacheAt = Date.now()
      return out
    })()

    inflight = {key, promise}
    try {
      return await promise
    } finally {
      if (inflight?.key === key) inflight = null
    }
  }

  function invalidate() {
    cache = null
    cacheAt = 0
  }

  /** 可选筛选元信息：可用日期 + 群（带真名） */
  async function meta() {
    const {stats, rows, files, names} = await load({})
    // V47.39：rows 现在也含主动发言行（source='proactive'）。群列表与「总轮次」保持 chat 口径，
    //   主动维度单独由 dashboard().proactive 提供，避免两套数字互相打架。
    const chatRows = rows.filter((r) => String(r.source || '') !== 'proactive')
    const gids = [...new Set(chatRows.map((r) => String(r.gid || '')))].filter(Boolean)
    const groups = gids.map((gid) => {
      const name = names.get(gid) || ''
      const short = gid.replace('@chatroom', '')
      return {
        gid,
        name,
        label: name || `群 ${short.slice(-6)}`,
        short: short.slice(-6),
        n: chatRows.filter((r) => String(r.gid) === gid).length,
      }
    }).sort((a, b) => b.n - a.n)
    return {
      dates: files.map((f) => ({date: f.date, sizeKB: Math.round(f.size / 1024)})),
      groups,
      total: chatRows.length,
      proactiveTotal: rows.length - chatRows.length,
      updatedAt: new Date().toISOString(),
    }
  }

  /** 大屏主数据 */
  async function dashboard(q = {}) {
    const {stats, rows, files} = await load(q)
    const data = stats.computeStats(rows, {gid: q.gid})
    // 群分布补真名
    const names = new Map(rows.map((r) => [String(r.gid || ''), r._gname || '']))
    data.groups = data.groups.map((g) => ({
      ...g,
      name: names.get(g.gid) || '',
      label: names.get(g.gid) || `群 ${g.short}`,
    }))
    // 综合对比补真名与标签
    data.compare = (data.compare || []).map((g) => ({
      ...g,
      name: names.get(g.gid) || '',
      label: names.get(g.gid) || `群 ${g.short}`,
    }))
    return {
      ...data,
      range: {
        days: q.days || 0,
        from: q.from || '',
        to: q.to || '',
        gid: q.gid || '',
        files: files.map((f) => f.date),
      },
      generated: new Date().toLocaleString('zh-CN', {hour12: false}),
    }
  }

  /** 原始轮次表格（分页） */
  async function turns(q = {}) {
    const {stats, rows} = await load(q)
    return stats.pageTurns(rows, {
      gid: q.gid,
      q: q.q,
      onlyAbnormal: !!q.onlyAbnormal,
      page: q.page,
      size: q.size,
    })
  }

  return {meta, dashboard, turns, invalidate}
}

export default createYingAiGroupData
