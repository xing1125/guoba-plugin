import {autowired, Service} from '#guoba.framework'

/**
 * 后台数据同步任务
 *
 * - uid       ：把 MysUsers.uids 展开物化到 admin.db 的 uid_index（毫秒级，每小时）
 * - group     ：Redis SCAN 群活跃 key，落 group_stats 快照（每 10 分钟，单轮上限 2 万 key）
 *
 * 所有任务串行执行，失败只记录不抛出，避免影响 Bot 主流程。
 */
export class SyncService extends Service {

  dbService = autowired('dbService')
  statsService = autowired('statsService')

  constructor(app) {
    super(app)
    this._running = new Set()
    this._timer = null
  }

  /** 启动定时任务：启动后 8 秒重建一次 UID 索引，之后每 10 分钟跑一轮 */
  start() {
    if (this._timer) return
    const safe = (fn) => Promise.resolve().then(fn).catch(() => {})
    setTimeout(() => safe(() => this.run('uid')), 8_000)?.unref?.()
    this._timer = setInterval(() => safe(() => this.run('all')), 10 * 60 * 1000)
    this._timer?.unref?.()
  }

  _today() {
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }

  _wrap(task, fn) {
    if (this._running.has(task)) {
      return {task, skipped: true, message: '任务正在执行中'}
    }
    this._running.add(task)
    const now = new Date().toISOString()
    this.dbService.setTaskStatus(task, {status: 'running', last_start: now, message: null})
    return Promise.resolve()
      .then(fn)
      .then((res) => {
        this.dbService.setTaskStatus(task, {
          status: 'ok',
          last_end: new Date().toISOString(),
          scanned: res?.scanned ?? 0,
          message: res?.message ?? null,
        })
        return {task, status: 'ok', ...res}
      })
      .catch((e) => {
        logger.error(`[admin] 同步任务 ${task} 失败：${e.message}`)
        this.dbService.setTaskStatus(task, {
          status: 'failed',
          last_end: new Date().toISOString(),
          message: e.message,
        })
        return {task, status: 'failed', message: e.message}
      })
      .finally(() => this._running.delete(task))
  }

  /** 重建 UID 索引 */
  async rebuildUidIndex() {
    return this._wrap('uid', async () => {
      const bot = this.dbService.getBotDb()
      if (!bot) return {scanned: 0, message: 'Bot 主库不可用'}

      const rows = bot
        .prepare(
          `SELECT m.ltuid AS ltuid, g.key AS game, u.value AS uid
           FROM MysUsers m, json_each(m.uids) g, json_each(g.value) u
           WHERE g.key <> '_meta' AND json_type(g.value) = 'array'`,
        )
        .all()

      const admin = this.dbService.getAdminDb()
      const insert = admin.prepare(
        'INSERT OR REPLACE INTO uid_index (uid, game, ltuid, synced_at) VALUES (?, ?, ?, ?)',
      )
      const now = new Date().toISOString()
      const tx = admin.transaction((list) => {
        admin.prepare('DELETE FROM uid_index').run()
        for (const r of list) {
          insert.run(String(r.uid), r.game, Number(r.ltuid), now)
        }
      })
      tx(rows)

      return {scanned: rows.length, message: `已索引 ${rows.length} 个 UID`}
    })
  }

  /** 聚合 Redis 群数据，写入当日快照 */
  async scanGroupStats() {
    return this._wrap('group', async () => {
      if (!globalThis.redis) {
        return {scanned: 0, message: 'Redis 不可用'}
      }
      const today = this._today()
      const admin = this.dbService.getAdminDb()
      const upsert = admin.prepare(
        `INSERT INTO group_stats (gid, stat_date, active_cnt, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(gid, stat_date) DO UPDATE SET
           active_cnt = excluded.active_cnt,
           updated_at = excluded.updated_at`,
      )

      const groups = await this.statsService.snapshotGroups()
      let written = 0
      const now = new Date().toISOString()
      const tx = admin.transaction((list) => {
        for (const g of list) {
          // 活跃人数优先取今日榜，退回最近日榜
          const active = g.active?.N ?? g.active?.D ?? g.active?.W ?? g.active?.M ?? g.active?.all ?? 0
          upsert.run(String(g.gid), today, Number(active) || 0, now)
          written++
        }
      })
      tx(groups)

      return {scanned: groups.length, message: `聚合 ${groups.length} 个群，写入 ${written} 条快照`}
    })
  }

  /** 执行指定任务，task 为 all 时依次执行 */
  async run(task = 'all') {
    const result = []
    if (task === 'uid' || task === 'all') {
      result.push(await this.rebuildUidIndex())
    }
    if (task === 'group' || task === 'all') {
      result.push(await this.scanGroupStats())
    }
    if (result.length === 0) {
      return [{task, status: 'ignored', message: '未知任务'}]
    }
    return result
  }

  /** 任务状态 */
  getStatus() {
    try {
      const rows = this.dbService
        .getAdminDb()
        .prepare('SELECT task, status, last_start, last_end, scanned, message FROM sync_meta')
        .all()
      return {tasks: rows}
    } catch (e) {
      return {tasks: [], message: e.message}
    }
  }
}
