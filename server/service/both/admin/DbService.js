import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import {Service} from '#guoba.framework'
import {_paths} from '#guoba.platform'

/** 容错 JSON 解析（用于角色 menus/ops 等 TEXT 列） */
function safeJson(str, fallback = null) {
  if (str == null) return fallback
  try {
    return JSON.parse(str)
  } catch {
    return fallback
  }
}

/**
 * 双库连接管理
 *
 * - bot.db ：Bot 主库（data/db/data.db），**只读**打开，绝不写入
 * - admin.db：后台自有库（data/db/admin.db），读写，WAL
 *
 * Bot 主库使用 sequelize + journal_mode=delete，读连接必须设 busy_timeout，
 * 且只做点查/小范围扫描，避免与 Bot 写事务互相阻塞。
 */
export class DbService extends Service {

  constructor(app) {
    super(app)
    this.botDbPath = path.join(_paths.data, 'db', 'data.db')
    this.adminDbPath = path.join(_paths.data, 'db', 'admin.db')
    this._botDb = null
    this._botDbFailed = false
    this._botDbWrite = null
    this._adminDb = null
  }

  /** Bot 主库（只读）。库不存在时返回 null，调用方需自行兜底 */
  getBotDb() {
    if (this._botDb) {
      return this._botDb
    }
    if (this._botDbFailed) {
      return null
    }
    try {
      if (!fs.existsSync(this.botDbPath)) {
        this._botDbFailed = true
        logger.warn(`[admin] Bot 主库不存在，账号相关接口将返回空数据：${this.botDbPath}`)
        return null
      }
      this._botDb = new Database(this.botDbPath, {readonly: true, fileMustExist: true})
      this._botDb.pragma('busy_timeout = 2000')
      return this._botDb
    } catch (e) {
      this._botDbFailed = true
      logger.error(`[admin] 打开 Bot 主库失败：${e.message}`)
      return null
    }
  }

  /**
   * Bot 主库（可写）—— **仅供后台的删除 / 编辑类操作使用**
   *
   * Bot 进程用 sequelize 打开同一文件（journal_mode=delete），
   * 这里只执行单行 UPDATE / DELETE，并设置较大的 busy_timeout，
   * 避免与 Bot 写事务互相阻塞；不做任何 DDL / 批量扫描。
   */
  getBotDbWrite() {
    if (this._botDbWrite) {
      return this._botDbWrite
    }
    if (!fs.existsSync(this.botDbPath)) {
      throw new Error(`Bot 主库不存在：${this.botDbPath}`)
    }
    this._botDbWrite = new Database(this.botDbPath, {fileMustExist: true})
    this._botDbWrite.pragma('busy_timeout = 5000')
    return this._botDbWrite
  }

  /** 后台自有库（读写），首次访问时自动建表 */
  getAdminDb() {
    if (this._adminDb) {
      return this._adminDb
    }
    const dir = path.dirname(this.adminDbPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, {recursive: true})
    }
    this._adminDb = new Database(this.adminDbPath)
    this._adminDb.pragma('journal_mode = WAL')
    this._adminDb.pragma('busy_timeout = 2000')
    this.initSchema()
    return this._adminDb
  }

  initSchema() {
    this._adminDb.exec(`
      CREATE TABLE IF NOT EXISTS sync_meta (
        task       TEXT PRIMARY KEY,
        status     TEXT NOT NULL DEFAULT 'idle',
        last_start TEXT,
        last_end   TEXT,
        scanned    INTEGER DEFAULT 0,
        message    TEXT
      );

      CREATE TABLE IF NOT EXISTS account_status (
        ltuid      INTEGER PRIMARY KEY,
        ck_status  TEXT NOT NULL DEFAULT 'unknown',
        http_code  INTEGER,
        err_msg    TEXT,
        cost_ms    INTEGER,
        checked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_acc_checked ON account_status(checked_at);

      CREATE TABLE IF NOT EXISTS uid_index (
        uid       TEXT NOT NULL,
        game      TEXT NOT NULL,
        ltuid     INTEGER NOT NULL,
        synced_at TEXT,
        PRIMARY KEY (uid, game)
      );
      CREATE INDEX IF NOT EXISTS idx_uid_ltuid ON uid_index(ltuid);
      CREATE INDEX IF NOT EXISTS idx_uid_game  ON uid_index(game);

      CREATE TABLE IF NOT EXISTS group_stats (
        gid        TEXT NOT NULL,
        stat_date  TEXT NOT NULL,
        active_cnt INTEGER DEFAULT 0,
        msg_cnt    INTEGER DEFAULT 0,
        join_cnt   INTEGER DEFAULT 0,
        leave_cnt  INTEGER DEFAULT 0,
        updated_at TEXT,
        PRIMARY KEY (gid, stat_date)
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        actor      TEXT,
        action     TEXT,
        target     TEXT,
        detail     TEXT,
        ip         TEXT,
        created_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

      /* 删除账号前的整行备份，用于误删恢复 */
      CREATE TABLE IF NOT EXISTS deleted_account (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ltuid      INTEGER NOT NULL,
        payload    TEXT NOT NULL,
        actor      TEXT,
        ip         TEXT,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_deleted_ltuid ON deleted_account(ltuid);

      /* 删除「无绑定用户」前的整行备份（Users 表），用于误删恢复 */
      CREATE TABLE IF NOT EXISTS deleted_user (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        uid        TEXT NOT NULL,
        payload    TEXT NOT NULL,
        actor      TEXT,
        ip         TEXT,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_deleted_user_uid ON deleted_user(uid);

      /* 昵称快照：Users.name 全为空，昵称只在 Bot 运行时内存里，
         由 StatsService 周期回写，保证后台随时可查、重启不丢 */
      CREATE TABLE IF NOT EXISTS user_name (
        uid        TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        source     TEXT,
        updated_at TEXT
      );

      /* ---- RBAC：后台管理员账号 ---- */
      CREATE TABLE IF NOT EXISTS admin_user (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        nickname      TEXT,
        role          TEXT NOT NULL DEFAULT 'viewer',
        status        TEXT NOT NULL DEFAULT 'active',
        must_change   INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT,
        last_login_at TEXT
      );

      /* ---- RBAC：角色定义（builtin=1 为内置，不可删） ---- */
      CREATE TABLE IF NOT EXISTS admin_role (
        role        TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        menus       TEXT NOT NULL DEFAULT '[]',
        ops         TEXT NOT NULL DEFAULT '[]',
        builtin     INTEGER NOT NULL DEFAULT 0,
        description TEXT
      );

      /* ---- 登录日志 ---- */
      CREATE TABLE IF NOT EXISTS login_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        username   TEXT,
        ip         TEXT,
        ua         TEXT,
        success    INTEGER NOT NULL DEFAULT 0,
        reason     TEXT,
        created_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_login_created ON login_log(created_at);
    `)
  }

  /** 写入同步任务状态 */
  setTaskStatus(task, patch = {}) {
    const db = this.getAdminDb()
    const exists = db.prepare('SELECT task FROM sync_meta WHERE task = ?').get(task)
    if (!exists) {
      db.prepare('INSERT INTO sync_meta (task, status) VALUES (?, ?)').run(task, patch.status || 'idle')
    }
    const fields = Object.keys(patch)
    if (fields.length === 0) {
      return
    }
    const sql = `UPDATE sync_meta SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE task = ?`
    db.prepare(sql).run(...fields.map((f) => patch[f]), task)
  }

  getTaskStatus(task) {
    return this.getAdminDb().prepare('SELECT * FROM sync_meta WHERE task = ?').get(task) || null
  }

  /** 写操作审计（统一入口；audit 为语义别名） */
  writeAudit({actor = '', action = '', target = '', detail = '', ip = ''} = {}) {
    try {
      this.getAdminDb()
        .prepare('INSERT INTO audit_log (actor, action, target, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(actor, action, String(target), typeof detail === 'string' ? detail : JSON.stringify(detail), ip, new Date().toISOString())
    } catch (e) {
      logger?.warn?.(`[admin] 写入审计日志失败：${e.message}`)
    }
  }

  /** 语义别名：audit({actor, action, target, detail, ip}) */
  audit(entry = {}) {
    this.writeAudit(entry)
  }

  /** 最近审计记录（兼容旧调用：只传 limit 时返回数组） */
  queryAudit({limit = 50} = {}) {
    return this.getAdminDb()
      .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
      .all(Math.min(200, Math.max(1, Number(limit) || 50)))
  }

  /**
   * 审计日志分页查询（筛选：actor / action / 时间区间 / 关键词）
   * @returns {{list: object[], total: number}}
   */
  queryAuditPaged({page = 1, size = 20, actor = '', action = '', from = '', to = '', keyword = ''} = {}) {
    const db = this.getAdminDb()
    const where = []
    const args = []
    if (actor) { where.push('actor LIKE ?'); args.push(`%${actor}%`) }
    if (action) { where.push('action LIKE ?'); args.push(`%${action}%`) }
    if (from) { where.push('created_at >= ?'); args.push(String(from)) }
    if (to) { where.push('created_at <= ?'); args.push(String(to)) }
    if (keyword) {
      where.push('(target LIKE ? OR detail LIKE ?)')
      args.push(`%${keyword}%`, `%${keyword}%`)
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const sizeN = Math.min(200, Math.max(1, Number(size) || 20))
    const pageN = Math.max(1, Number(page) || 1)
    const total = db.prepare(`SELECT count(*) AS c FROM audit_log ${clause}`).get(...args).c
    const list = db
      .prepare(`SELECT * FROM audit_log ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...args, sizeN, (pageN - 1) * sizeN)
    return {list, total}
  }

  /** 审计概览：总数、今日数、按 action 前缀分布、高危操作数 */
  auditStats() {
    const db = this.getAdminDb()
    const today = new Date().toISOString().slice(0, 10)
    const total = db.prepare('SELECT count(*) AS c FROM audit_log').get().c
    const todayCount = db.prepare("SELECT count(*) AS c FROM audit_log WHERE created_at >= ?").get(today).c
    const risky = db.prepare("SELECT count(*) AS c FROM audit_log WHERE action LIKE '%delete%' OR action LIKE '%clear%' OR action LIKE '%quit%'").get().c
    const byAction = db
      .prepare("SELECT action, count(*) AS c FROM audit_log GROUP BY action ORDER BY c DESC LIMIT 12")
      .all()
    return {total, today: todayCount, risky, byAction}
  }

  /** 备份被删除的账号（整行 + 关联记录） */
  backupDeletedAccount(ltuid, payload, {actor = '', ip = ''} = {}) {
    this.getAdminDb()
      .prepare('INSERT INTO deleted_account (ltuid, payload, actor, ip, deleted_at) VALUES (?, ?, ?, ?, ?)')
      .run(ltuid, JSON.stringify(payload), actor, ip, new Date().toISOString())
  }

  /** 被删除账号的备份列表 */
  listDeletedAccounts({limit = 100} = {}) {
    return this.getAdminDb()
      .prepare('SELECT id, ltuid, actor, deleted_at FROM deleted_account ORDER BY id DESC LIMIT ?')
      .all(Math.min(500, Math.max(1, Number(limit) || 100)))
  }

  /** 取某条删除备份 */
  getDeletedAccount(id) {
    const row = this.getAdminDb().prepare('SELECT * FROM deleted_account WHERE id = ?').get(Number(id))
    if (!row) {
      return null
    }
    try {
      row.payload = JSON.parse(row.payload)
    } catch {}
    return row
  }

  /** 备份被清理的「无效用户」（Users 整行 + 相关线索） */
  backupDeletedUser(uid, payload, {actor = '', ip = ''} = {}) {
    this.getAdminDb()
      .prepare('INSERT INTO deleted_user (uid, payload, actor, ip, deleted_at) VALUES (?, ?, ?, ?, ?)')
      .run(String(uid), JSON.stringify(payload), actor, ip, new Date().toISOString())
  }

  /** 被清理用户的备份列表 */
  listDeletedUsers({limit = 100} = {}) {
    return this.getAdminDb()
      .prepare('SELECT id, uid, actor, deleted_at FROM deleted_user ORDER BY id DESC LIMIT ?')
      .all(Math.min(500, Math.max(1, Number(limit) || 100)))
  }

  /** 取某条用户删除备份 */
  getDeletedUser(id) {
    const row = this.getAdminDb().prepare('SELECT * FROM deleted_user WHERE id = ?').get(Number(id))
    if (!row) {
      return null
    }
    try {
      row.payload = JSON.parse(row.payload)
    } catch {}
    return row
  }

  /* ----------------------------- RBAC 用户 ----------------------------- */

  /** 按用户名取后台账号（含密码哈希），不存在返回 null */
  getUserByUsername(username) {
    return this.getAdminDb().prepare('SELECT * FROM admin_user WHERE username = ?').get(username) || null
  }

  /** 按 id 取后台账号 */
  getUserById(id) {
    return this.getAdminDb().prepare('SELECT * FROM admin_user WHERE id = ?').get(Number(id)) || null
  }

  /** 列出后台账号（脱敏：不含 password_hash） */
  listUsers({keyword = '', limit = 200} = {}) {
    const db = this.getAdminDb()
    const kw = String(keyword || '').trim()
    const rows = kw
      ? db.prepare('SELECT id, username, nickname, role, status, must_change, created_at, last_login_at FROM admin_user WHERE username LIKE ? OR nickname LIKE ? ORDER BY id LIMIT ?').all(`%${kw}%`, `%${kw}%`, Math.min(500, Number(limit) || 200))
      : db.prepare('SELECT id, username, nickname, role, status, must_change, created_at, last_login_at FROM admin_user ORDER BY id LIMIT ?').all(Math.min(500, Number(limit) || 200))
    return rows.map((r) => ({...r, must_change: !!r.must_change}))
  }

  /** 新建 / 更新后台账号（password_hash 由调用方用 scrypt 生成后传入） */
  upsertUser({id, username, password_hash, nickname = '', role = 'viewer', status = 'active', must_change = 0} = {}) {
    const db = this.getAdminDb()
    if (id) {
      db.prepare('UPDATE admin_user SET password_hash = ?, nickname = ?, role = ?, status = ?, must_change = ? WHERE id = ?')
        .run(password_hash, nickname, role, status, must_change ? 1 : 0, Number(id))
      return this.getUserById(id)
    }
    const info = db.prepare('INSERT INTO admin_user (username, password_hash, nickname, role, status, must_change, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(username, password_hash, nickname, role, status, must_change ? 1 : 0, new Date().toISOString())
    return this.getUserById(info.lastInsertRowid)
  }

  /** 更新最后登录时间 / 改密状态 */
  updateUserMeta(id, {last_login_at, must_change} = {}) {
    const sets = []
    const vals = []
    if (last_login_at != null) { sets.push('last_login_at = ?'); vals.push(last_login_at) }
    if (must_change != null) { sets.push('must_change = ?'); vals.push(must_change ? 1 : 0) }
    if (!sets.length) return
    vals.push(Number(id))
    this.getAdminDb().prepare(`UPDATE admin_user SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  }

  /** 删除后台账号 */
  deleteUser(id) {
    this.getAdminDb().prepare('DELETE FROM admin_user WHERE id = ?').run(Number(id))
  }

  /* ----------------------------- RBAC 角色 ----------------------------- */

  /** 取角色定义（含解析后的 menus/ops 数组） */
  getRole(role) {
    const row = this.getAdminDb().prepare('SELECT * FROM admin_role WHERE role = ?').get(role)
    if (!row) return null
    return this._decodeRole(row)
  }

  listRoles() {
    return this.getAdminDb().prepare('SELECT * FROM admin_role ORDER BY role').all().map((r) => this._decodeRole(r))
  }

  upsertRole({role, name, menus = [], ops = [], builtin = 0, description = ''} = {}) {
    const db = this.getAdminDb()
    const exist = db.prepare('SELECT role FROM admin_role WHERE role = ?').get(role)
    if (exist) {
      db.prepare('UPDATE admin_role SET name = ?, menus = ?, ops = ?, builtin = ?, description = ? WHERE role = ?')
        .run(name, JSON.stringify(menus), JSON.stringify(ops), builtin ? 1 : 0, description, role)
    } else {
      db.prepare('INSERT INTO admin_role (role, name, menus, ops, builtin, description) VALUES (?, ?, ?, ?, ?, ?)')
        .run(role, name, JSON.stringify(menus), JSON.stringify(ops), builtin ? 1 : 0, description)
    }
    return this.getRole(role)
  }

  deleteRole(role) {
    this.getAdminDb().prepare('DELETE FROM admin_role WHERE role = ? AND builtin = 0').run(role)
  }

  _decodeRole(row) {
    return {
      ...row,
      menus: safeJson(row.menus, []),
      ops: safeJson(row.ops, []),
      builtin: !!row.builtin,
    }
  }

  /* ----------------------------- 登录日志 ----------------------------- */

  writeLoginLog({username = '', ip = '', ua = '', success = false, reason = ''} = {}) {
    try {
      this.getAdminDb()
        .prepare('INSERT INTO login_log (username, ip, ua, success, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(username, ip, String(ua || '').slice(0, 300), success ? 1 : 0, reason, new Date().toISOString())
    } catch (e) {
      logger?.warn?.(`[admin] 写登录日志失败：${e.message}`)
    }
  }

  queryLoginLog({limit = 50} = {}) {
    return this.getAdminDb()
      .prepare('SELECT * FROM login_log ORDER BY id DESC LIMIT ?')
      .all(Math.min(500, Math.max(1, Number(limit) || 50)))
  }

  /** 登录日志分页（可按用户名/结果筛选） */
  queryLoginLogPaged({page = 1, size = 20, username = '', success = null} = {}) {
    const db = this.getAdminDb()
    const where = []
    const args = []
    if (username) { where.push('username LIKE ?'); args.push(`%${username}%`) }
    if (success === true || success === 'true') { where.push('success = 1') }
    if (success === false || success === 'false') { where.push('success = 0') }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const sizeN = Math.min(200, Math.max(1, Number(size) || 20))
    const pageN = Math.max(1, Number(page) || 1)
    const total = db.prepare(`SELECT count(*) AS c FROM login_log ${clause}`).get(...args).c
    const list = db
      .prepare(`SELECT * FROM login_log ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...args, sizeN, (pageN - 1) * sizeN)
    return {list, total}
  }

  close() {
    try {
      this._botDb?.close()
    } catch {}
    try {
      this._botDbWrite?.close()
    } catch {}
    try {
      this._adminDb?.close()
    } catch {}
    this._botDb = null
    this._botDbWrite = null
    this._adminDb = null
  }
}
