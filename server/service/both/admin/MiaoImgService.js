import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {autowired, Service} from '#guoba.framework'
import {_paths} from '#guoba.platform'

/**
 * 喵喵面板图 / 角色图片管理服务
 *
 * 与 miao-plugin 聊天指令 `#上传xx面板图` / `#上传xx图片` 落盘约定完全一致：
 *   - kind=profile   → miao-plugin/resources/profile/normal-character/<角色名>/   （面板图，png|jpg|jpeg|webp）
 *   - kind=character → miao-plugin/resources/character-img/<角色名>/upload/       （角色图片，多支持 gif）
 * 文件名 = 内容 md5 去重，同名跳过；删除移入回收站；全部写操作写审计。
 *
 * 只允许在上述两类目录内活动（realpath 防逃逸）。
 */

const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const GIF_EXT = '.gif'
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

export class MiaoImgService extends Service {

  dbService = autowired('dbService')

  constructor(app) {
    super(app)
    // _paths.pluginRoot = .../app/plugins/Guoba-Plugin → 同级 miao-plugin
    this.miaoRes = path.resolve(_paths.pluginRoot, '..', 'miao-plugin', 'resources')
    /** @type {Record<string,{base:string, label:string, exts:Set<string>}>} */
    this.kindsMap = {
      profile: {
        base: path.join(this.miaoRes, 'profile', 'normal-character'),
        label: '面板图',
        exts: IMG_EXT,
      },
      character: {
        base: path.join(this.miaoRes, 'character-img'),
        label: '角色图片',
        exts: new Set([...IMG_EXT, GIF_EXT]),
      },
    }
    this.trashDir = path.resolve(_paths.pluginRoot, '..', '..', 'temp', 'guoba-trash')
  }

  _kind(kind) {
    const k = this.kindsMap[String(kind || '')]
    if (!k) {
      throw new Error('未知的图片类型，只允许 profile / character')
    }
    return k
  }

  /** 角色目录名校验（单段、合法字符） */
  _checkName(name) {
    const n = String(name || '').trim()
    if (!n || n === '.' || n === '..' || /[\\/:*?"<>|]/.test(n) || n.length > 60) {
      throw new Error(`角色名不合法：${name}`)
    }
    return n
  }

  /** 角色 dir 绝对路径 + realpath 防逃逸（不存在则创建） */
  _charDir(kind, name, create = false) {
    const k = this._kind(kind)
    const n = this._checkName(name)
    const rel = k === this.kindsMap.character ? path.join(n, 'upload') : n
    const dir = path.join(k.base, rel)
    const realBase = fs.existsSync(k.base) ? fs.realpathSync(k.base) : k.base
    const realDir = fs.existsSync(dir) ? fs.realpathSync(dir) : dir
    if (realDir !== realBase && !realDir.startsWith(realBase + path.sep)) {
      throw new Error('路径越界，拒绝访问')
    }
    if (create && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, {recursive: true})
    }
    return {k, dir, charDirRel: rel}
  }

  /** 扫描目录内图片（不含子目录） */
  _imgsIn(dir) {
    const out = []
    let entries = []
    try {
      entries = fs.readdirSync(dir, {withFileTypes: true})
    } catch {
      return out
    }
    for (const e of entries) {
      if (!e.isFile()) {
        continue
      }
      const ext = path.extname(e.name).toLowerCase()
      if (!MIME[ext]) {
        continue
      }
      let st = null
      try {
        st = fs.statSync(path.join(dir, e.name))
      } catch {}
      out.push({
        name: e.name,
        size: st?.size ?? 0,
        mtime: st ? new Date(st.mtimeMs).toISOString() : null,
        ext,
      })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 递归统计目录内图片数（character 类型图片在 <角色>/upload 子层） */
  _countImgsDeep(dir, depth = 0) {
    if (depth > 3) {
      return 0
    }
    let n = 0
    let entries = []
    try {
      entries = fs.readdirSync(dir, {withFileTypes: true})
    } catch {
      return 0
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        n += this._countImgsDeep(full, depth + 1)
      } else if (MIME[path.extname(e.name).toLowerCase()]) {
        n += 1
      }
    }
    return n
  }

  /** 有图的角色清单 */
  characters(kind) {
    const k = this._kind(kind)
    if (!fs.existsSync(k.base)) {
      return {kind, label: k.label, list: []}
    }
    const out = []
    for (const e of fs.readdirSync(k.base, {withFileTypes: true})) {
      if (!e.isDirectory() || e.name.startsWith('.')) {
        continue
      }
      const dir = path.join(k.base, e.name)
      const count = this._countImgsDeep(dir)
      if (count > 0) {
        out.push({name: e.name, count})
      }
    }
    out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'))
    return {kind, label: k.label, list: out}
  }

  /** 某角色图片列表（相对路径供前端预览/删除用） */
  list(kind, name) {
    const {k, dir, charDirRel} = this._charDir(kind, name)
    if (!fs.existsSync(dir)) {
      return {kind, label: k.label, name, list: []}
    }
    const list = this._imgsIn(dir).map((it) => ({
      ...it,
      rel: `${charDirRel.replace(/\\/g, '/')}/${it.name}`,
    }))
    return {kind, label: k.label, name, list}
  }

  /** 保存上传的图片（md5 命名去重） */
  async save(kind, name, buffer, originalname = '', ctx = {}) {
    const {k, dir, charDirRel} = this._charDir(kind, name, true)
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
      throw new Error('图片内容为空')
    }
    if (buffer.length > MAX_UPLOAD_BYTES) {
      throw new Error(`图片超过 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB，拒绝保存`)
    }
    let ext = path.extname(String(originalname || '')).toLowerCase()
    if (!k.exts.has(ext)) {
      throw new Error(`不支持的图片格式 ${ext || '(无扩展名)'}，${k.label}支持：${[...k.exts].join(' ')}`)
    }
    const md5 = crypto.createHash('md5').update(buffer).digest('hex')
    const fileName = `${md5}${ext}`
    const target = path.join(dir, fileName)
    const existed = fs.existsSync(target)
    if (!existed) {
      fs.writeFileSync(target, buffer)
    }
    this.dbService.writeAudit({
      ...ctx,
      action: 'miaoImg.upload',
      target: `miao/${kind}/${charDirRel.replace(/\\/g, '/')}/${fileName}`,
      detail: {bytes: buffer.length, existed},
    })
    return {
      kind,
      name,
      file: fileName,
      rel: `${charDirRel.replace(/\\/g, '/')}/${fileName}`,
      existed,
      bytes: buffer.length,
    }
  }

  /** 删除（移入回收站） */
  async remove(kind, name, file, ctx = {}) {
    const {dir, charDirRel} = this._charDir(kind, name)
    const base = path.basename(String(file || ''))
    if (!base || base.includes('/') || base.includes('\\')) {
      throw new Error('文件名不合法')
    }
    const target = path.join(dir, base)
    const realDir = fs.existsSync(dir) ? fs.realpathSync(dir) : dir
    const realTarget = fs.existsSync(target) ? fs.realpathSync(target) : target
    if (!realTarget.startsWith(realDir + path.sep)) {
      throw new Error('路径越界，拒绝访问')
    }
    if (!fs.existsSync(target)) {
      throw new Error('图片不存在')
    }
    fs.mkdirSync(this.trashDir, {recursive: true})
    const trashName = `${Date.now()}_${base}`
    fs.renameSync(target, path.join(this.trashDir, trashName))
    this.dbService.writeAudit({
      ...ctx,
      action: 'miaoImg.delete',
      target: `miao/${kind}/${charDirRel.replace(/\\/g, '/')}/${base}`,
      detail: {trash: `temp/guoba-trash/${trashName}`},
    })
    return {kind, name, file: base, trash: `temp/guoba-trash/${trashName}`}
  }

  /** 读取图片二进制（供浏览器预览）；rel 限定在两类图片目录内 */
  readImage(rel) {
    const relNorm = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '')
    if (!relNorm || relNorm.split('/').some((s) => !s || s === '.' || s === '..')) {
      throw new Error('路径不合法')
    }
    const target = path.join(this.miaoRes, relNorm)
    // 只允许两类图片目录
    const allowed = [this.kindsMap.profile.base, this.kindsMap.character.base]
    const realTarget = fs.realpathSync(target)
    const inAllow = allowed.some((base) => {
      if (!fs.existsSync(base)) {
        return false
      }
      const realBase = fs.realpathSync(base)
      return realTarget === realBase || realTarget.startsWith(realBase + path.sep)
    })
    if (!inAllow) {
      throw new Error('路径越界，拒绝访问')
    }
    const ext = path.extname(realTarget).toLowerCase()
    if (!MIME[ext]) {
      throw new Error('不是图片文件')
    }
    return {mime: MIME[ext], buffer: fs.readFileSync(realTarget)}
  }
}
