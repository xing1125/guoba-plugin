import fs from 'node:fs'
import path from 'node:path'
import {Service} from '#guoba.framework'
import {_paths} from '#guoba.platform'

/**
 * 鸣潮签到数据服务
 *
 * 数据源：Cloudtide Waves-plugin 的签到计划归档
 *   `<Yunzai>/app/plugins/Cloudtide Waves-plugin/data/schedules/YYYY-MM-DD.json`
 * 单文件结构：
 *   { version, date, mode, fixedTime, window, generatedAt, groupTime, groupDone, entries: [...] }
 * entry：
 *   { qq, time, mode, done, result: { ok, msg },
 *     groupUser: { roleName, roleId, signed, sigInNum, omissionNnm, rewards: [{name, num, icon}] } }
 *
 * result.ok=false 时 msg 形如「[鸣潮] token 已失效，请重新绑定（#ww登录 + token）」
 *
 * 本服务只读文件，不写入任何数据；解析结果按全目录 (mtime+size 之和) 缓存。
 * 输出形状与 SignService 对齐，方便前端复用同一套页面骨架。
 */

const RE_FILE = /^\d{4}-\d{2}-\d{2}\.json$/

export class WavesSignService extends Service {

  constructor(app) {
    super(app)
    const pluginsRoot = path.dirname(_paths.pluginRoot || path.join(_paths.data, '..', 'plugins'))
    this.dirPath = path.join(pluginsRoot, 'Cloudtide Waves-plugin', 'data', 'schedules')
    this._cache = null
    this._cacheKey = ''
  }

  get available() {
    try {
      return fs.existsSync(this.dirPath)
    } catch {
      return false
    }
  }

  /** 读取并展平所有日程归档（按目录指纹缓存） */
  _load() {
    if (!this.available) {
      return {records: [], days: new Map(), meta: {available: false, path: this.dirPath}}
    }

    let files = []
    try {
      files = fs.readdirSync(this.dirPath).filter((f) => RE_FILE.test(f)).sort()
    } catch {
      return {records: [], days: new Map(), meta: {available: false, path: this.dirPath}}
    }
    if (!files.length) {
      return {records: [], days: new Map(), meta: {available: false, path: this.dirPath}}
    }

    /* 目录指纹：逐文件 mtime+size 求和，任何一个文件被插件重写都会失效缓存 */
    let fingerprint = 0
    const stats = {}
    for (const f of files) {
      try {
        const st = fs.statSync(path.join(this.dirPath, f))
        stats[f] = st
        fingerprint += st.mtimeMs + st.size
      } catch {}
    }
    fingerprint = Math.round(fingerprint)
    if (this._cache && this._cacheKey === String(fingerprint)) {
      return this._cache
    }

    const records = []
    const days = new Map()
    let fixedTime = ''
    let mode = ''
    for (const f of files) {
      let doc
      try {
        doc = JSON.parse(fs.readFileSync(path.join(this.dirPath, f), 'utf8'))
      } catch {
        continue
      }
      const date = String(doc.date || f.replace('.json', '')).slice(0, 10)
      /* 文件按日期序解析，后面的覆盖前面的 → fixedTime/mode 取最新一天的配置 */
      if (doc.fixedTime) {
        fixedTime = String(doc.fixedTime)
      }
      if (doc.mode) {
        mode = String(doc.mode)
      }
      const list = []
      for (const e of Array.isArray(doc.entries) ? doc.entries : []) {
        const gu = e.groupUser || {}
        const rewards = Array.isArray(gu.rewards)
          ? gu.rewards.map((r) => ({name: String(r?.name || ''), num: Number(r?.num) || 0})).filter((r) => r.name)
          : []
        const row = {
          date,
          time: String(e.time || doc.fixedTime || ''),
          qq: String(e.qq || ''),
          done: Boolean(e.done),
          ok: Boolean(e.result?.ok),
          msg: String(e.result?.msg || ''),
          name: String(gu.roleName || ''),
          roleId: gu.roleId != null ? String(gu.roleId) : '',
          sigInNum: Number(gu.sigInNum) || 0,
          omission: Number(gu.omissionNnm) || 0,
          rewards,
          rewardText: rewards.map((r) => `${r.name}×${r.num}`).join('、'),
        }
        list.push(row)
        records.push(row)
      }
      days.set(date, list)
    }

    records.sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : a.date + a.time > b.date + b.time ? 1 : 0))

    const dates = [...days.keys()].sort()
    const lastDate = dates[dates.length - 1] || null
    const lastRows = lastDate ? days.get(lastDate) : []
    const lastAt = lastRows.length ? `${lastDate}T${lastRows[lastRows.length - 1].time || '00:00'}:00` : null

    const parsed = {
      records,
      days,
      meta: {
        available: true,
        path: this.dirPath,
        files: files.length,
        firstDate: dates[0] || null,
        lastDate,
        lastAt,
        fixedTime,
        mode,
        updatedAt: lastDate && stats[`${lastDate}.json`] ? new Date(stats[`${lastDate}.json`].mtimeMs).toISOString() : undefined,
      },
    }
    this._cache = parsed
    this._cacheKey = String(fingerprint)
    return parsed
  }

  /** 单日聚合 */
  _aggDay(list) {
    const users = new Set()
    let ok = 0
    let fail = 0
    let pending = 0
    let maxSigIn = 0
    let omission = 0
    for (const r of list) {
      users.add(r.qq)
      if (!r.done) {
        pending += 1
        continue
      }
      if (r.ok) {
        ok += 1
      } else {
        fail += 1
      }
      if (r.sigInNum > maxSigIn) {
        maxSigIn = r.sigInNum
      }
      omission += r.omission
    }
    return {total: list.length, ok, fail, pending, users: users.size, maxSigIn, omission}
  }

  /** 概览：今日 + 近 N 天趋势 + 最近流水（形状对齐 SignService.getOverview） */
  getOverview(days = 14) {
    const {records, days: byDate, meta} = this._load()
    if (!meta.available) {
      return {
        available: false,
        meta,
        today: null,
        trend: [],
        recent: [],
        summary: undefined,
      }
    }

    const allDates = [...byDate.keys()].sort()
    const span = Math.max(1, Math.min(120, Number(days) || 14))
    const windowDates = allDates.slice(-span)

    const trend = windowDates.map((d) => {
      const agg = this._aggDay(byDate.get(d))
      return {
        date: d,
        total: agg.total,
        ok: agg.ok,
        fail: agg.fail,
        pending: agg.pending,
        users: agg.users,
        maxSigIn: agg.maxSigIn,
        omission: agg.omission,
      }
    })

    const todayDate = allDates[allDates.length - 1] || null
    const todayAgg = todayDate ? this._aggDay(byDate.get(todayDate)) : null
    const today = todayDate && todayAgg
      ? {
          date: todayDate,
          ...todayAgg,
          rate: todayAgg.total ? Math.round((todayAgg.ok / todayAgg.total) * 1000) / 10 : 0,
        }
      : null

    const recent = records.slice(-8).reverse().map((r) => ({
      time: `${r.date}T${r.time}`,
      date: r.date,
      qq: r.qq,
      name: r.name,
      ok: r.ok,
      done: r.done,
      sigInNum: r.sigInNum,
      omission: r.omission,
      rewardText: r.rewardText,
      msg: r.msg.slice(0, 200),
    }))

    const doneRecords = records.filter((r) => r.done)
    return {
      available: true,
      meta,
      today,
      trend,
      recent,
      summary: {
        days: allDates.length,
        records: doneRecords.length,
        users: new Set(records.map((r) => r.qq)).size,
        avgOkRate: doneRecords.length
          ? Math.round((doneRecords.filter((r) => r.ok).length / doneRecords.length) * 1000) / 10
          : 0,
      },
    }
  }

  /** 明细查询：日期 / 关键字 / 成败 */
  queryRecords({date = '', q = '', ok = '', page = 1, size = 20} = {}) {
    const {records} = this._load()
    const kw = String(q || '').trim().toLowerCase()
    let list = records
    if (date) {
      list = list.filter((r) => r.date === String(date))
    }
    if (ok === 'ok' || ok === '1') {
      list = list.filter((r) => r.done && r.ok)
    } else if (ok === 'fail' || ok === '0') {
      list = list.filter((r) => r.done && !r.ok)
    } else if (ok === 'pending') {
      list = list.filter((r) => !r.done)
    }
    if (kw) {
      list = list.filter(
        (r) =>
          r.qq.toLowerCase().includes(kw) ||
          r.name.toLowerCase().includes(kw) ||
          r.roleId.toLowerCase().includes(kw) ||
          r.msg.toLowerCase().includes(kw) ||
          r.rewardText.toLowerCase().includes(kw) ||
          r.date.includes(kw),
      )
    }

    const total = list.length
    const p = Math.max(1, Number(page) || 1)
    const s = Math.min(200, Math.max(5, Number(size) || 20))
    const start = (p - 1) * s
    const rows = list
      .slice()
      .reverse()
      .slice(start, start + s)
    return {total, page: p, size: s, list: rows}
  }

  /** 某一天的完整聚合（含账号列表） */
  getDay(date) {
    const {days: byDate} = this._load()
    const d = String(date || '').slice(0, 10)
    const list = d ? byDate.get(d) || [] : []
    if (!list.length) {
      return {date: d, available: false, userList: []}
    }
    const agg = this._aggDay(list)
    const userMap = new Map()
    for (const r of list) {
      const prev = userMap.get(r.qq) || {
        qq: r.qq,
        name: '',
        roleId: '',
        ok: 0,
        fail: 0,
        sigInNum: 0,
        omission: 0,
        rewards: '',
        msg: '',
      }
      if (r.name) {
        prev.name = r.name
      }
      if (r.roleId) {
        prev.roleId = r.roleId
      }
      if (r.done) {
        if (r.ok) {
          prev.ok += 1
        } else {
          prev.fail += 1
        }
      }
      if (r.sigInNum > prev.sigInNum) {
        prev.sigInNum = r.sigInNum
      }
      prev.omission = Math.max(prev.omission, r.omission)
      if (r.rewardText) {
        prev.rewards = r.rewardText
      }
      if (r.msg) {
        prev.msg = r.msg
      }
      userMap.set(r.qq, prev)
    }
    return {
      date: d,
      available: true,
      ...agg,
      rate: agg.total ? Math.round((agg.ok / agg.total) * 1000) / 10 : 0,
      userList: [...userMap.values()].sort((a, b) => b.ok - a.ok || b.sigInNum - a.sigInNum),
    }
  }
}
