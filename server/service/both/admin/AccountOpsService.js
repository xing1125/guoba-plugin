import {autowired, Service} from '#guoba.framework'

/**
 * 账号写操作服务
 *
 * 提供后台对 Bot 主库（data.db）的**受限写能力**：
 *   - 删除账号（先整行备份到 admin.db 的 deleted_account，再删主库）
 *   - 编辑账号（CK / device / device_fp / uids）
 *   - 解绑单个 UID
 *   - 批量清理失效账号
 *   - 从备份恢复
 *
 * 约束：
 *   - 只做单行 UPDATE / DELETE，开短事务，busy_timeout 5s
 *   - 每次写操作都落 audit_log，可追溯
 *   - 删除前必有备份，payload 含 MysUsers 行 + Users 关联 + UserGames 关联
 */
export class AccountOpsService extends Service {

  dbService = autowired('dbService')

  // ---------------------------------------------------------------- 工具

  _safeJson(text, fallback) {
    if (text == null) {
      return fallback
    }
    if (typeof text === 'object') {
      return text
    }
    try {
      return JSON.parse(text)
    } catch {
      return fallback
    }
  }

  /**
   * 解析 Users.ltuids —— 实测是**逗号分隔字符串**（如 "7184612,290389857"），
   * 兼容历史数据里可能出现的 JSON 数组写法。
   */
  _parseLtuids(text) {
    if (text == null || text === '') {
      return []
    }
    if (Array.isArray(text)) {
      return text.map(Number).filter(Boolean)
    }
    const raw = String(text).trim()
    if (raw.startsWith('[')) {
      const arr = this._safeJson(raw, [])
      return Array.isArray(arr) ? arr.map(Number).filter(Boolean) : []
    }
    return raw
      .split(',')
      .map((x) => Number(String(x).trim()))
      .filter(Boolean)
  }

  /** 读一个账号的完整快照（主库行 + Users 关联 + UserGames） */
  _snapshot(ltuid) {
    const db = this.dbService.getBotDb()
    if (!db) {
      throw new Error('Bot 主库不可用')
    }
    const mys = db.prepare('SELECT * FROM MysUsers WHERE ltuid = ?').get(Number(ltuid))
    if (!mys) {
      return null
    }
    const uids = this._safeJson(mys.uids, {})
    const uidList = []
    for (const [game, arr] of Object.entries(uids || {})) {
      if (game === '_meta' || !Array.isArray(arr)) {
        continue
      }
      for (const u of arr) {
        uidList.push({game, uid: String(u)})
      }
    }

    // Users 表里 ltuids 是 JSON 数组
    const users = []
    const rows = db.prepare('SELECT * FROM Users').all()
    for (const row of rows) {
      if (this._parseLtuids(row.ltuids).includes(Number(ltuid))) {
        users.push(row)
      }
    }

    const userGames = []
    for (const u of users) {
      const list = db.prepare('SELECT * FROM UserGames WHERE userId = ?').all(u.id)
      userGames.push(...list)
    }

    return {mys, uids, uidList, users, userGames}
  }

  /** 从 Users.ltuids 里摘掉某个 ltuid */
  _detachLtuid(userRow, ltuid) {
    const arr = this._parseLtuids(userRow.ltuids)
    if (arr.length === 0) {
      return null
    }
    const next = arr.filter((x) => Number(x) !== Number(ltuid))
    if (next.length === arr.length) {
      return null
    }
    // 与 Bot 侧保持一致：逗号分隔字符串
    return next.join(',')
  }

  // ---------------------------------------------------------------- 删除

  /**
   * 删除账号（含备份）
   * @param {number[]} ltuids
   * @param {{actor?:string, ip?:string}} ctx
   */
  deleteAccounts(ltuids, ctx = {}) {
    const ids = [...new Set((ltuids || []).map(Number).filter(Boolean))]
    if (ids.length === 0) {
      return {deleted: 0, failed: [], detail: []}
    }
    const write = this.dbService.getBotDbWrite()
    const admin = this.dbService.getAdminDb()
    const detail = []
    const failed = []
    let deleted = 0

    const delMys = write.prepare('DELETE FROM MysUsers WHERE ltuid = ?')
    const updUser = write.prepare('UPDATE Users SET ltuids = ?, updatedAt = ? WHERE id = ?')
    const delGame = write.prepare('DELETE FROM UserGames WHERE userId = ? AND game = ? AND uid = ?')

    for (const ltuid of ids) {
      let snap
      try {
        snap = this._snapshot(ltuid)
      } catch (e) {
        failed.push({ltuid, error: e.message})
        continue
      }
      if (!snap) {
        failed.push({ltuid, error: '账号不存在'})
        continue
      }

      try {
        // 1) 备份（主库外的 admin.db，独立文件，安全）
        this.dbService.backupDeletedAccount(
          ltuid,
          {
            mys: snap.mys,
            users: snap.users,
            userGames: snap.userGames,
          },
          ctx,
        )

        // 2) 主库写事务
        const now = new Date().toISOString()
        const tx = write.transaction(() => {
          delMys.run(ltuid)
          for (const u of snap.users) {
            const next = this._detachLtuid(u, ltuid)
            if (next != null) {
              updUser.run(next, now, u.id)
            }
          }
          for (const g of snap.userGames) {
            // 仅删除属于该账号的 UID 记录
            if (snap.uidList.some((x) => x.game === g.game && x.uid === String(g.uid))) {
              delGame.run(g.userId, g.game, g.uid)
            }
          }
        })
        tx()

        // 3) 清理后台索引
        try {
          admin.prepare('DELETE FROM uid_index WHERE ltuid = ?').run(ltuid)
          admin.prepare('DELETE FROM account_status WHERE ltuid = ?').run(ltuid)
        } catch {}

        deleted += 1
        detail.push({
          ltuid,
          uids: snap.uidList.length,
          users: snap.users.length,
          games: snap.userGames.length,
        })
      } catch (e) {
        failed.push({ltuid, error: e.message})
      }
    }

    this.dbService.writeAudit({
      ...ctx,
      action: 'account.delete',
      target: ids.join(','),
      detail: {deleted, failed: failed.length, detail},
    })
    return {deleted, failed, detail}
  }

  /** 批量清理「CK 已失效」的账号 */
  deleteExpired(ctx = {}) {
    const admin = this.dbService.getAdminDb()
    const rows = admin.prepare("SELECT ltuid FROM account_status WHERE ck_status = 'expired'").all()
    const ids = rows.map((r) => Number(r.ltuid)).filter(Boolean)
    if (ids.length === 0) {
      return {deleted: 0, failed: [], detail: [], scanned: 0}
    }
    const res = this.deleteAccounts(ids, {...ctx, action: 'account.deleteExpired'})
    return {...res, scanned: ids.length}
  }

  /**
   * 清理「无效用户」（Users 表里的微信号）
   *
   * 只删 Users 行 + 它自己的 UserGames 行，**不动 MysUsers**（米游社账号是共享资源，
   * 可能还被别的微信号绑着）。删前整行备份到 admin.db 的 deleted_user。
   *
   * @param {string[]} userIds Users.id（wxid / xml 号）
   * @param {{actor?:string, ip?:string}} ctx
   */
  deleteOrphanUsers(userIds, ctx = {}) {
    const ids = [...new Set((userIds || []).map((x) => String(x || '').trim()).filter(Boolean))]
    if (ids.length === 0) {
      return {deleted: 0, failed: [], detail: []}
    }
    const write = this.dbService.getBotDbWrite()
    const detail = []
    const failed = []
    let deleted = 0

    const selUser = write.prepare('SELECT * FROM Users WHERE id = ?')
    const selGames = write.prepare('SELECT * FROM UserGames WHERE userId = ?')
    const delUser = write.prepare('DELETE FROM Users WHERE id = ?')
    const delGames = write.prepare('DELETE FROM UserGames WHERE userId = ?')

    for (const uid of ids) {
      let row
      try {
        row = selUser.get(uid)
      } catch (e) {
        failed.push({uid, error: e.message})
        continue
      }
      if (!row) {
        failed.push({uid, error: '用户不存在'})
        continue
      }

      try {
        const games = selGames.all(uid)
        // 1) 先备份（admin.db 独立文件）
        this.dbService.backupDeletedUser(uid, {user: row, userGames: games}, ctx)

        // 2) 主库事务
        const tx = write.transaction(() => {
          delGames.run(uid)
          delUser.run(uid)
        })
        tx()

        // 3) 后台侧的昵称缓存一并清掉，避免列表里留幽灵
        try {
          this.dbService.getAdminDb().prepare('DELETE FROM user_name WHERE uid = ?').run(uid)
        } catch {}

        deleted += 1
        detail.push({uid, name: row.name || '', ltuids: this._parseLtuids(row.ltuids), games: games.length})
      } catch (e) {
        failed.push({uid, error: e.message})
      }
    }

    this.dbService.writeAudit({
      ...ctx,
      action: 'user.deleteOrphan',
      target: ids.join(','),
      detail: {deleted, failed: failed.length, detail},
    })
    return {deleted, failed, detail}
  }

  /** 从用户删除备份恢复 */
  restoreUser(id, ctx = {}) {
    const row = this.dbService.getDeletedUser(id)
    if (!row) {
      throw new Error('备份记录不存在')
    }
    const payload = row.payload || {}
    const user = payload.user
    if (!user) {
      throw new Error('备份数据不完整')
    }
    const write = this.dbService.getBotDbWrite()
    if (write.prepare('SELECT id FROM Users WHERE id = ?').get(user.id)) {
      throw new Error(`用户 ${user.id} 已存在，无需恢复`)
    }
    const cols = Object.keys(user)
    write.prepare(`INSERT INTO Users (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .run(...cols.map((c) => user[c]))

    let games = 0
    for (const g of payload.userGames || []) {
      const gc = Object.keys(g)
      try {
        write.prepare(`INSERT INTO UserGames (${gc.join(',')}) VALUES (${gc.map(() => '?').join(',')})`)
          .run(...gc.map((c) => g[c]))
        games += 1
      } catch {}
    }

    this.dbService.writeAudit({
      ...ctx,
      action: 'user.restore',
      target: String(user.id),
      detail: {backupId: id, games},
    })
    return {uid: user.id, restored: true, games}
  }

  /** 从删除备份恢复账号 */
  restoreAccount(id, ctx = {}) {
    const row = this.dbService.getDeletedAccount(id)
    if (!row) {
      throw new Error('备份记录不存在')
    }
    const payload = row.payload || {}
    const mys = payload.mys
    if (!mys) {
      throw new Error('备份数据不完整')
    }
    const write = this.dbService.getBotDbWrite()
    const exists = write.prepare('SELECT ltuid FROM MysUsers WHERE ltuid = ?').get(mys.ltuid)
    if (exists) {
      throw new Error(`账号 ${mys.ltuid} 已存在，无需恢复`)
    }
    const cols = Object.keys(mys)
    const sql = `INSERT INTO MysUsers (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
    write.prepare(sql).run(...cols.map((c) => mys[c]))

    // 恢复 Users.ltuids 关联（只在原用户仍存在时补回）
    const now = new Date().toISOString()
    for (const u of payload.users || []) {
      const cur = write.prepare('SELECT * FROM Users WHERE id = ?').get(u.id)
      if (!cur) {
        continue
      }
      const arr = this._parseLtuids(cur.ltuids)
      if (!arr.includes(Number(mys.ltuid))) {
        arr.push(Number(mys.ltuid))
        write.prepare('UPDATE Users SET ltuids = ?, updatedAt = ? WHERE id = ?').run(arr.join(','), now, u.id)
      }
    }

    this.dbService.writeAudit({
      ...ctx,
      action: 'account.restore',
      target: String(mys.ltuid),
      detail: {backupId: id},
    })
    return {ltuid: mys.ltuid, restored: true}
  }

  // ---------------------------------------------------------------- 编辑

  /**
   * 编辑账号字段
   * 允许：ck、device、device_fp、uids
   */
  updateAccount(ltuid, patch = {}, ctx = {}) {
    const db = this.dbService.getBotDbWrite()
    const row = db.prepare('SELECT * FROM MysUsers WHERE ltuid = ?').get(Number(ltuid))
    if (!row) {
      throw new Error(`账号 ${ltuid} 不存在`)
    }
    const allow = ['ck', 'device', 'device_fp', 'uids']
    const sets = []
    const args = []
    const changed = []

    for (const key of allow) {
      if (!(key in patch)) {
        continue
      }
      let value = patch[key]
      if (key === 'uids') {
        if (typeof value === 'string') {
          try {
            value = JSON.parse(value)
          } catch {
            throw new Error('uids 不是合法 JSON')
          }
        }
        // 只保留数组值 + _meta
        const clean = {}
        for (const [g, arr] of Object.entries(value || {})) {
          if (g === '_meta') {
            clean._meta = arr
          } else if (Array.isArray(arr)) {
            clean[g] = arr.map(String)
          }
        }
        value = JSON.stringify(clean)
      }
      if (value === row[key]) {
        continue
      }
      sets.push(`${key} = ?`)
      args.push(value)
      changed.push(key)
    }

    if (sets.length === 0) {
      return {ltuid: Number(ltuid), changed: []}
    }
    args.push(new Date().toISOString())
    args.push(Number(ltuid))
    db.prepare(`UPDATE MysUsers SET ${sets.join(', ')}, updatedAt = ? WHERE ltuid = ?`).run(...args)

    this.dbService.writeAudit({
      ...ctx,
      action: 'account.update',
      target: String(ltuid),
      detail: {changed},
    })
    return {ltuid: Number(ltuid), changed}
  }

  /**
   * 手动添加 / 修改一个 UID
   * @param origin 编辑时传原 UID（替换它）；新增时不传
   */
  upsertUid({ltuid, game, uid, origin = '', ctx = {}} = {}) {
    const db = this.dbService.getBotDbWrite()
    const row = db.prepare('SELECT * FROM MysUsers WHERE ltuid = ?').get(Number(ltuid))
    if (!row) {
      throw new Error(`账号 ${ltuid} 不存在，只能为已存在的米游社账号维护 UID`)
    }
    if (!game || game === '_meta') {
      throw new Error('game 不合法')
    }
    const uidStr = String(uid || '').trim()
    if (!/^\d{4,20}$/.test(uidStr)) {
      throw new Error('UID 需为 4~20 位纯数字')
    }
    const originStr = origin ? String(origin).trim() : ''

    const uids = this._safeJson(row.uids, {})
    const arr = Array.isArray(uids[game]) ? uids[game].map(String) : []

    if (originStr) {
      const i = arr.indexOf(originStr)
      if (i === -1) {
        throw new Error(`原 UID ${originStr} 在该账号的 ${game} 下不存在`)
      }
      if (uidStr !== originStr && arr.includes(uidStr)) {
        throw new Error(`UID ${uidStr} 已存在于该账号`)
      }
      arr[i] = uidStr
    } else {
      if (arr.includes(uidStr)) {
        throw new Error(`UID ${uidStr} 已存在于该账号`)
      }
      arr.push(uidStr)
    }

    uids[game] = arr
    db.prepare('UPDATE MysUsers SET uids = ?, updatedAt = ? WHERE ltuid = ?').run(
      JSON.stringify(uids),
      new Date().toISOString(),
      Number(ltuid),
    )

    // 同步 UserGames（与 deleteUid 对称：编辑 = 删旧插新，新增 = 直接插入）
    const userIds = []
    for (const u of db.prepare('SELECT * FROM Users').all()) {
      if (this._parseLtuids(u.ltuids).includes(Number(ltuid))) {
        userIds.push(u.id)
      }
    }
    for (const uid2 of userIds) {
      try {
        if (originStr) {
          db.prepare('DELETE FROM UserGames WHERE userId = ? AND game = ? AND uid = ?').run(uid2, game, originStr)
        }
        db.prepare('INSERT OR IGNORE INTO UserGames (userId, game, uid) VALUES (?, ?, ?)').run(uid2, game, uidStr)
      } catch {}
    }
    try {
      const adb = this.dbService.getAdminDb()
      if (originStr) {
        adb.prepare('DELETE FROM uid_index WHERE uid = ? AND game = ?').run(originStr, game)
      }
      adb.prepare('INSERT INTO uid_index (uid, game) VALUES (?, ?)').run(uidStr, game)
    } catch {}

    this.dbService.writeAudit({
      ...ctx,
      action: originStr ? 'uid.update' : 'uid.add',
      target: `${ltuid}/${game}/${uidStr}`,
      detail: {ltuid, game, uid: uidStr, origin: originStr || null},
    })
    return {ltuid: Number(ltuid), game, uid: uidStr, origin: originStr || null, bound: arr.length}
  }

  /** 解绑一个 UID（从 uids JSON 移除） */
  deleteUid(ltuid, game, uid, ctx = {}) {    const db = this.dbService.getBotDbWrite()
    const row = db.prepare('SELECT * FROM MysUsers WHERE ltuid = ?').get(Number(ltuid))
    if (!row) {
      throw new Error(`账号 ${ltuid} 不存在`)
    }
    const uids = this._safeJson(row.uids, {})
    const arr = Array.isArray(uids[game]) ? uids[game] : []
    const next = arr.filter((x) => String(x) !== String(uid))
    if (next.length === arr.length) {
      throw new Error(`该账号下没有 ${game} 的 UID ${uid}`)
    }
    uids[game] = next
    db.prepare('UPDATE MysUsers SET uids = ?, updatedAt = ? WHERE ltuid = ?').run(
      JSON.stringify(uids),
      new Date().toISOString(),
      Number(ltuid),
    )

    // 同步删除 UserGames 对应记录
    const userIds = []
    for (const u of db.prepare('SELECT * FROM Users').all()) {
      if (this._parseLtuids(u.ltuids).includes(Number(ltuid))) {
        userIds.push(u.id)
      }
    }
    for (const uid2 of userIds) {
      try {
        db.prepare('DELETE FROM UserGames WHERE userId = ? AND game = ? AND uid = ?').run(uid2, game, String(uid))
      } catch {}
    }
    try {
      this.dbService.getAdminDb().prepare('DELETE FROM uid_index WHERE uid = ? AND game = ?').run(String(uid), game)
    } catch {}

    this.dbService.writeAudit({
      ...ctx,
      action: 'uid.delete',
      target: `${ltuid}/${game}/${uid}`,
      detail: {ltuid, game, uid},
    })
    return {ltuid: Number(ltuid), game, uid: String(uid), bound: next.length}
  }

  /** 删除操作审计列表 */
  listAudit(limit) {
    return this.dbService.queryAudit({limit})
  }

  /** 可恢复的删除记录 */
  listDeleted(limit) {
    return this.dbService.listDeletedAccounts({limit})
  }
}
