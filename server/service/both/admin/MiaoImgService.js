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
 *   - kind=character → miao-plugin/resources/character-img/<角色名>/upload/       （角色图片/写真，多支持 gif）
 *   - kind=art       → miao-plugin/resources/character-img/<角色名>/              （卡面立绘库，png|webp，不含 upload//se/ 子层）
 * 文件名 = 内容 md5 去重，同名跳过；删除移入回收站；全部写操作写审计。
 *
 * 只允许在上述目录内活动（realpath 防逃逸）。
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
      // 卡面立绘库：与 kind=character 同根，但直接落在 <角色名>/ 根目录（不走 upload/ 子层），
      // 对应 miao CharImg.getCardImg 的随机采样目录（miao-char-sync.mjs art 生成的 01..04.webp 就在这里）
      art: {
        base: path.join(this.miaoRes, 'character-img'),
        label: '卡面立绘',
        exts: new Set(['.png', '.webp']),
      },
      // 小清新图库：<角色名>/se/ 子目录（miao 随机图的另一分类）
      se: {
        base: path.join(this.miaoRes, 'character-img'),
        label: '小清新',
        exts: new Set([...IMG_EXT, GIF_EXT]),
      },
    }
    this.trashDir = path.resolve(_paths.pluginRoot, '..', '..', 'temp', 'guoba-trash')
  }

  _kind(kind) {
    const k = this.kindsMap[String(kind || '')]
    if (!k) {
      throw new Error('未知的图片类型，只允许 profile / character / art')
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
    let rel = n
    if (k === this.kindsMap.character) {
      rel = path.join(n, 'upload')
    } else if (k === this.kindsMap.se) {
      rel = path.join(n, 'se')
    }
    const dir = path.join(k.base, rel)
    const realBase = fs.existsSync(k.base) ? fs.realpathSync(k.base) : k.base
    const realDir = fs.existsSync(dir) ? fs.realpathSync(dir) : dir
    if (realDir !== realBase && !realDir.startsWith(realBase + path.sep)) {
      throw new Error('路径越界，拒绝访问')
    }
    if (create && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, {recursive: true})
    }
    // 相对 miaoRes 的 posix 路径（供前端 /img?rel= 预览用）
    const resRel = path.relative(this.miaoRes, dir).replace(/\\/g, '/')
    return {k, dir, charDirRel: rel, resRel}
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
  _countImgsDeep(dir, depth = 0, skipDirs = null) {
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
        // art kind 只管根目录层，跳过 upload/（写真）与 se/（小清新）
        if (skipDirs && skipDirs.has(e.name)) {
          continue
        }
        n += this._countImgsDeep(full, depth + 1, skipDirs)
      } else if (MIME[path.extname(e.name).toLowerCase()]) {
        n += 1
      }
    }
    return n
  }

  /** 有图的角色清单（三类图库各自独立：面板图 / 立绘根层 / 写真 upload 层） */
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
      // 目录分家：写真只数 <角色>/upload/ 层；小清新只数 <角色>/se/ 层；立绘只数 <角色>/ 根层
      // （跳过 upload/、se/）；面板图数自己的目录树。四类列表互不干扰。
      let count = 0
      if (kind === 'character') {
        count = this._imgsIn(path.join(dir, 'upload')).length
      } else if (kind === 'se') {
        count = this._imgsIn(path.join(dir, 'se')).length
      } else if (kind === 'art') {
        count = this._countImgsDeep(dir, 0, new Set(['upload', 'se']))
      } else {
        count = this._countImgsDeep(dir)
      }
      if (count > 0) {
        out.push({name: e.name, count})
      }
    }
    out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'))
    return {kind, label: k.label, list: out}
  }

  /** 某角色图片列表（rel 为相对 miaoRes 的路径，供前端预览/删除用） */
  list(kind, name) {
    const {k, dir, charDirRel, resRel} = this._charDir(kind, name)
    if (!fs.existsSync(dir)) {
      return {kind, label: k.label, name, list: []}
    }
    const list = this._imgsIn(dir).map((it) => ({
      ...it,
      rel: `${resRel}/${it.name}`,
    }))
    return {kind, label: k.label, name, list}
  }

  /** 保存上传的图片（md5 命名去重） */
  async save(kind, name, buffer, originalname = '', ctx = {}) {
    const {k, dir, charDirRel, resRel} = this._charDir(kind, name, true)
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
      rel: `${resRel}/${fileName}`,
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

  /** 真正创建角色目录（幂等）——先建好文件夹，可往里手动复制/上传图片 */
  async mkdir(kind, name, ctx = {}) {
    const {k, charDirRel, resRel} = this._charDir(kind, name, false)
    const existed = fs.existsSync(path.join(k.base, charDirRel))
    if (!existed) {
      this._charDir(kind, name, true)
    }
    this.dbService.writeAudit({
      ...ctx,
      action: 'miaoImg.mkdir',
      target: `miao/${kind}/${charDirRel.replace(/\\/g, '/')}`,
      detail: {existed},
    })
    return {kind, name, existed, dir: resRel}
  }

  /** 重命名图片（可改扩展名，但必须在白名单内；目标重名拒绝） */
  async rename(kind, name, from, to, ctx = {}) {
    const {k, dir, charDirRel, resRel} = this._charDir(kind, name)
    const src = String(from || '').trim()
    const dst = String(to || '').trim()
    if (!src || src.includes('/') || src.includes('\\') || src !== path.basename(src)) {
      throw new Error('原文件名不合法')
    }
    if (!dst || dst.includes('/') || dst.includes('\\') || /[\\/:*?"<>|]/.test(dst) || dst.length > 100) {
      throw new Error('新文件名不合法')
    }
    const srcPath = path.join(dir, src)
    if (!fs.existsSync(srcPath)) {
      throw new Error('图片不存在')
    }
    const extTo = path.extname(dst).toLowerCase()
    if (!extTo) {
      throw new Error(`新名字要带扩展名，${k.label}支持：${[...k.exts].join(' ')}`)
    }
    if (!k.exts.has(extTo) || !MIME[extTo]) {
      throw new Error(`不支持的扩展名 ${extTo}，${k.label}支持：${[...k.exts].join(' ')}`)
    }
    const dstPath = path.join(dir, dst)
    if (fs.existsSync(dstPath)) {
      throw new Error(`目标文件已存在：${dst}`)
    }
    // 改扩展名时校验内容 magic number，防止把非图片改成图片后缀
    if (extTo !== path.extname(src).toLowerCase()) {
      const head = fs.readFileSync(srcPath).subarray(0, 12)
      if (!this._sniffMime(head, extTo)) {
        throw new Error(`文件内容不是 ${extTo.slice(1)} 格式，拒绝改后缀`)
      }
    }
    fs.renameSync(srcPath, dstPath)
    this.dbService.writeAudit({
      ...ctx,
      action: 'miaoImg.rename',
      target: `miao/${kind}/${charDirRel.replace(/\\/g, '/')}/${src}`,
      detail: {to: dst},
    })
    return {kind, name, from: src, to: dst, rel: `${resRel}/${dst}`}
  }

  /** 图片 magic number 快速嗅探（png/jpg/webp/gif） */
  _sniffMime(head, ext) {
    if (ext === '.png') {
      return head.length >= 8 && head[0] === 0x89 && head.toString('ascii', 1, 4) === 'PNG'
    }
    if (ext === '.jpg' || ext === '.jpeg') {
      return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
    }
    if (ext === '.gif') {
      return head.length >= 6 && head.toString('ascii', 0, 3) === 'GIF'
    }
    if (ext === '.webp') {
      return head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP'
    }
    return false
  }

  /** 重命名角色目录（四类共用 base/<角色名> 这一层；写真/小清新的子目录随目录一起移动） */
  async renameDir(kind, from, to, ctx = {}) {
    const k = this._kind(kind)
    const f = this._checkName(from)
    const t = this._checkName(to)
    if (f === t) {
      throw new Error('新名字与原名相同')
    }
    const src = path.join(k.base, f)
    const dst = path.join(k.base, t)
    if (!fs.existsSync(src)) {
      throw new Error('角色目录不存在')
    }
    if (fs.existsSync(dst)) {
      throw new Error(`目标目录已存在：${t}`)
    }
    fs.renameSync(src, dst)
    this.dbService.writeAudit({
      ...ctx,
      action: 'miaoImg.renameDir',
      target: `miao/${kind}/${f}`,
      detail: {to: t},
    })
    return {kind, from: f, to: t}
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
