/**
 * Guoba 配置「版本化 / 对比 / 导出导入」源码直载验证
 *
 * 不复制逻辑：把 ConfigServiceImpl.js 原文丢进 vm 沙箱（剥 import、桩掉 Guoba/_paths/
 * YamlReader/getConfigReader/configFile/coreCfg 等），验证的就是真实源码。
 *
 * 真实 key（system.bot）只读取；restore / import 的写盘只用假 key test.version / test.big，
 * 临时配置与临时备份目录跑完整个删干净，绝不动 bot.yaml 等真实配置。
 *
 * 用法：node _dev/check-config-version.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import {createRequire} from 'node:module'
import {execFileSync} from 'node:child_process'

const require = createRequire('D:/trss-yunzai/package.json')
const GUOBA = 'D:/trss-yunzai/plugins/Guoba-Plugin'
const APP = 'D:/trss-yunzai'
const SVC = path.join(GUOBA, 'server/service/v3/config/ConfigServiceImpl.js')
const CTRL = path.join(GUOBA, 'server/controller/biz/ConfigController.js')
const TMP_DIR = path.join(APP, 'data/__cfgver_test')
const BACKUP_ROOT = path.join(APP, 'data/guobaConfigBackup')

let pass = 0
let fail = 0
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✔ ${n}${d ? '  ' + d : ''}`) } else { fail++; console.log(`  ✘ ${n}${d ? '  ' + d : ''}`) }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/* ---------- 1. 源码载入沙箱 ---------- */

let src = fs.readFileSync(SVC, 'utf8')
const before = src.length
src = src
  .replace(/^import[^\n]*$/gm, '')                    // 去掉 ESM import
  .replace(/^export\s+default\s+class\s+/gm, 'class ') // export default class → class
  .replace(/import\.meta\.url/g, '__metaUrl')          // vm 里没有 import.meta

const marks = []
const warns = []
const readers = new Map()
const CF = {
  'system.bot': '/config/config/bot.yaml',
  'system.qq': '/config/config/qq.yaml',
  'system.group': '/config/config/group.yaml',
  'system.redis': '/config/config/redis.yaml',
  'system.other': '/config/config/other.yaml',
  'system.server': '/config/config/server.yaml',
  'genshin.gacha': '/plugins/genshin/config/config/gacha.set.yaml',
  /* 假 key：只活在本次自测里 */
  'test.version': '/data/__cfgver_test/test.version.yaml',
  'test.big': '/data/__cfgver_test/test.big.yaml',
}

const getConfigReader = (key, map) => {
  const rel = map[key]
  if (!rel) throw new Error(`没有找到配置文件：${key}`)
  if (!readers.has(key)) readers.set(key, {yamlPath: path.join(APP, rel)})
  return readers.get(key)
}

const GI = async (p) => {
  if (p === './utils/ConfigUtils.js') return {getConfigReader}
  if (p === './model/useConfig.js') return {getConfigTabs: () => [], configFile: CF}
  if (p === './utils/MiaoConfigUtils.js') return {
    handleConfigData: (action, key, field, value) => ({field, value}),
    handleGroupConfig: (action, obj) => obj,
  }
  throw new Error(`沙箱未桩的模块：${p}`)
}
const GID = async () => class IConfigService {
  constructor(app) { this.app = app }
}

const ctx = {
  __metaUrl: 'file:///dev/ConfigServiceImpl.js',
  Guoba: {createImport: () => ({GI, GID})},
  isTRSS: false,
  _paths: {root: APP},
  coreCfg: {config: {}},
  lodash: require(path.join(APP, 'lib/modules/lodash')),
  YAML: require('yaml'),
  YamlReader: {CONFIG_INTEGER_KEY: 'INTEGER__'},
  logger: {
    mark: (m) => marks.push(m),
    info: () => {},
    warn: (m) => warns.push(m),
    error: (m) => warns.push(m),
  },
  fs, path, Buffer, console, Date, Math, JSON, Number, String, Object, Array, Map, Set, RegExp, Error, Promise, Int32Array,
}
ctx.globalThis = ctx
vm.createContext(ctx)
const Svc = await vm.runInContext(`(async () => {\n${src}\n;return ConfigServiceImpl\n})()`, ctx)

ok('源码可加载（剥 import 后 ' + before + ' → ' + src.length + ' 字节）', typeof Svc === 'function')
const svc = new Svc({})
ok('6 个新方法都在原型上', ['listVersions', 'readVersion', 'diffVersion', 'restoreVersion', 'exportConfig', 'importConfig']
  .every((m) => typeof svc[m] === 'function'))
ok('5 个私有工具都在原型上', ['_backupRoot', '_safeKey', '_checkVersionFile', '_stampToMs', '_currentPath']
  .every((m) => typeof svc[m] === 'function'))
ok('原有 NO_HOT / checkHot / applyHot / backupConfigFile 未被改动', Svc.NO_HOT['system.redis'] && typeof svc.checkHot === 'function'
  && typeof svc.applyHot === 'function' && typeof svc.backupConfigFile === 'function' && Svc.BACKUP_KEEP === 10)

const splitLines = (text) => {
  const s = String(text ?? '').replace(/\r\n?/g, '\n')
  if (!s) return []
  const lines = s.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

const isSubseq = (sub, arr) => {
  let i = 0
  for (const x of arr) {
    if (i < sub.length && x === sub[i]) i++
  }
  return i === sub.length
}

try {

  /* ---------- 2. listVersions（真实 key，只读） ---------- */
  console.log('\n  listVersions(system.bot)：')
  const lv = svc.listVersions('system.bot')
  console.log(`    currentFile=${lv.currentFile}`)
  console.log(`    currentPath=${lv.currentPath}`)
  console.log(`    versions.length=${lv.versions.length}`)
  console.log(`    首条=${JSON.stringify(lv.versions[0])}`)
  ok('currentFile 取 configFile 的相对路径', lv.currentFile === '/config/config/bot.yaml', lv.currentFile)
  ok('currentPath 是绝对路径且真实存在', path.isAbsolute(lv.currentPath) && fs.existsSync(lv.currentPath), lv.currentPath)
  ok('versions 非空', lv.versions.length > 0, `${lv.versions.length} 条`)
  ok('时间倒序（最新在前）', lv.versions.every((v, i, a) => i === 0 || a[i - 1].time >= v.time))
  ok('target 去掉 stamp 前缀', lv.versions.every((v) => v.target === v.file.slice(16) && v.target === 'bot.yaml'))
  ok('stamp / time / size 自洽', lv.versions.every((v) => /^\d{8}-\d{6}$/.test(v.stamp)
    && v.stamp === v.file.slice(0, 15) && v.time > 0 && v.size > 0))
  ok('目录不存在的 key → versions: []，不抛错', (() => {
    try { const r = svc.listVersions('system.qq'); return Array.isArray(r.versions) && r.versions.length === 0 } catch { return false }
  })())

  const first = lv.versions[0].file

  /* ---------- 3. readVersion ---------- */
  console.log('\n  readVersion(system.bot, ' + first + ')：')
  const rv = svc.readVersion('system.bot', first)
  console.log(`    size=${rv.size}  content=${rv.content.length} 字  currentContent=${rv.currentContent.length} 字`)
  console.log(`    原文首行=${JSON.stringify(rv.content.split('\n')[0])}`)
  ok('content 非空', rv.content.length > 0)
  ok('content 含 log_level', rv.content.includes('log_level'))
  ok('保留注释（原文里有 #）', rv.content.includes('#'))
  ok('size = 文件字节数', rv.size === fs.statSync(path.join(BACKUP_ROOT, 'system.bot', first)).size)
  ok('currentContent 是当前磁盘原文', rv.currentContent === fs.readFileSync(path.join(APP, 'config/config/bot.yaml'), 'utf8'))
  ok('file / stamp / time 回填正确', rv.file === first && first.startsWith(rv.stamp) && rv.time === lv.versions[0].time)

  let e = ''
  try { svc.readVersion('system.bot', '20200101-000000_nope.yaml') } catch (err) { e = err.message }
  ok('不存在的版本 → 版本文件不存在', e === '版本文件不存在', e)

  /* ---------- 4. diffVersion（LCS） ---------- */
  console.log('\n  diffVersion(system.bot, ' + first + ')：')
  const dv = svc.diffVersion('system.bot', first)
  const oldLines = splitLines(rv.content)
  const newLines = splitLines(rv.currentContent)
  console.log(`    added=${dv.added} removed=${dv.removed} unchanged=${dv.unchanged} lines=${dv.lines.length}`)
  console.log('    前 5 行：')
  for (const l of dv.lines.slice(0, 5)) console.log(`      ${l.type} ${JSON.stringify(l.text)}`)
  ok('unchanged + removed = 旧文件行数', dv.unchanged + dv.removed === oldLines.length, `${dv.unchanged}+${dv.removed} vs ${oldLines.length}`)
  ok('unchanged + added = 新文件行数', dv.unchanged + dv.added === newLines.length, `${dv.unchanged}+${dv.added} vs ${newLines.length}`)
  ok('lines 条数 = 三态之和', dv.lines.length === dv.added + dv.removed + dv.unchanged)
  /* 用 lines 还原两边文件，必须与原文件逐行相同 —— 这才是 LCS 真自洽 */
  ok('去掉 "+" 还原旧文件', eq(dv.lines.filter((l) => l.type !== '+').map((l) => l.text), oldLines))
  ok('去掉 "-" 还原新文件', eq(dv.lines.filter((l) => l.type !== '-').map((l) => l.text), newLines))
  const keep = dv.lines.filter((l) => l.type === ' ').map((l) => l.text)
  ok('unchanged 行两边都是子序列', isSubseq(keep, oldLines) && isSubseq(keep, newLines), `${keep.length} 行`)
  ok('没有未知 type', dv.lines.every((l) => [' ', '+', '-'].includes(l.type)))
  ok('无行尾 \\r', dv.lines.every((l) => !l.text.includes('\r')))

  /* ---------- 5. 白名单 ---------- */
  console.log('\n  白名单 _checkVersionFile：')
  for (const bad of ['../../etc/passwd', 'abc.yaml', '20260101-000000_..', '20260101-000000_a/b',
    '20260101-000000_a\\b', '/etc/passwd', '', null, '20260101-000000_']) {
    let msg = ''
    try { svc._checkVersionFile(bad) } catch (err) { msg = err.message }
    ok(`拒绝 ${JSON.stringify(bad)}`, msg === '版本文件名不合法', msg || '（没抛错！）')
  }
  ok('放行合法文件名', svc._checkVersionFile('20261021-050132_bot.yaml') === '20261021-050132_bot.yaml')
  ok('_stampToMs 走本地时间', svc._stampToMs('20261021-042840') === new Date(2026, 9, 21, 4, 28, 40).getTime())
  ok('_stampToMs 非法输入给 0', svc._stampToMs('abc') === 0 && svc._stampToMs(null) === 0)
  ok('_safeKey 与 backupConfigFile 同规则', svc._safeKey('system.bot') === 'system.bot' && svc._safeKey('a b/c') === 'a_b_c')

  /* ---------- 6. exportConfig ---------- */
  console.log('\n  exportConfig(system.bot)：')
  const ex = svc.exportConfig('system.bot')
  const exBytes = Buffer.byteLength(ex.content)
  console.log(`    filename=${ex.filename}  bytes=${exBytes}`)
  ok('filename 格式 key + 时间戳', /^system-bot_\d{8}-\d{6}\.yaml$/.test(ex.filename), ex.filename)
  ok('content = 当前磁盘原文（含注释）', ex.content === fs.readFileSync(path.join(APP, 'config/config/bot.yaml'), 'utf8') && ex.content.includes('#'))
  ok('bytes 合理（>100）', exBytes > 100, String(exBytes))

  /* ---------- 7. 假 key：restore / import 写盘 ---------- */
  console.log('\n  假 key 写盘测试（' + TMP_DIR + '）：')
  fs.mkdirSync(TMP_DIR, {recursive: true})
  const tmpCfg = path.join(TMP_DIR, 'test.version.yaml')
  const tmpBackupDir = path.join(BACKUP_ROOT, 'test.version')
  fs.rmSync(tmpBackupDir, {recursive: true, force: true})
  const seed = '# 假配置，仅自测\nfoo: 1\nbar: two\nlist:\n  - a\n  - b\n'
  fs.writeFileSync(tmpCfg, seed, 'utf8')
  ok('假 key 初始没有版本', svc.listVersions('test.version').versions.length === 0)

  /* 手工造一份「历史版本」 */
  fs.mkdirSync(tmpBackupDir, {recursive: true})
  const histName = '20260101-010101_test.version.yaml'
  const histBody = '# 历史版本\nfoo: 0\nbar: two\nlist:\n  - a\n'
  fs.writeFileSync(path.join(tmpBackupDir, histName), histBody, 'utf8')
  const lv2 = svc.listVersions('test.version')
  ok('造版本后 listVersions 能看见', lv2.versions.length === 1 && lv2.versions[0].file === histName, JSON.stringify(lv2.versions))
  ok('target = test.version.yaml', lv2.versions[0].target === 'test.version.yaml', lv2.versions[0].target)
  ok('currentFile 是假 key 映射', lv2.currentFile === '/data/__cfgver_test/test.version.yaml')

  const dv2 = svc.diffVersion('test.version', histName)
  console.log(`    假 key diff: added=${dv2.added} removed=${dv2.removed} unchanged=${dv2.unchanged}  lines=${dv2.lines.length}`)
  console.log(`      ${dv2.lines.map((l) => l.type + JSON.stringify(l.text)).join(' ')}`)
  ok('假 key diff 语义：- 是版本里有、现在没有的', dv2.lines.some((l) => l.type === '-' && l.text === 'foo: 0'))
  ok('假 key diff 语义：+ 是现在有、版本里没有的', dv2.lines.some((l) => l.type === '+' && l.text === 'foo: 1'))
  ok('假 key diff 计数 = 3/2/3', dv2.added === 3 && dv2.removed === 2 && dv2.unchanged === 3,
    `${dv2.added}/${dv2.removed}/${dv2.unchanged}`)

  /* 7.1 restore */
  const rs = await svc.restoreVersion('test.version', histName)
  const afterRestore = fs.readFileSync(tmpCfg, 'utf8')
  console.log(`    restore: hot=${rs.hot} backupOf=${rs.backupOf} restoredFrom=${rs.restoredFrom}`)
  ok('restore 后磁盘内容 = 历史版本原文', afterRestore === histBody)
  ok('restore 返回 hot=true（假 key 不触发重启）', rs.hot === true && rs.reason === '', JSON.stringify(rs))
  ok('backupOf 是刚生成的回滚前备份', /^\d{8}-\d{6}_test\.version\.yaml$/.test(rs.backupOf), rs.backupOf)
  ok('回滚前备份里是 restore 之前的内容', fs.readFileSync(path.join(tmpBackupDir, rs.backupOf), 'utf8') === seed)
  ok('restore 记了 logger.mark', marks.some((m) => m.includes('配置已回滚') && m.includes('test.version')),
    marks.find((m) => m.includes('配置已回滚')))
  ok('restore 后版本数 +1（备份本身也是一个版本）', svc.listVersions('test.version').versions.length === 2)

  /* 7.2 import 通过 */
  /* 备份文件名精确到秒（沿用 backupConfigFile 的既有格式），隔开一秒再导，避免与 restore 的备份同名 */
  await new Promise((r) => setTimeout(r, 1100))
  const importBody = '# 导入的配置\nfoo: 9\nnested:\n  k: v\n'
  const im = await svc.importConfig('test.version', importBody)
  console.log(`    import: bytes=${im.bytes} backupOf=${im.backupOf} hot=${im.hot}`)
  ok('import 落盘内容一致', fs.readFileSync(tmpCfg, 'utf8') === importBody)
  ok('bytes = Buffer.byteLength', im.bytes === Buffer.byteLength(importBody), String(im.bytes))
  ok('import 的 backupOf 有效且存的是导入前内容', /^\d{8}-\d{6}_test\.version\.yaml$/.test(im.backupOf)
    && fs.readFileSync(path.join(tmpBackupDir, im.backupOf), 'utf8') === histBody)
  ok('import 记了 logger.mark', marks.some((m) => m.includes('配置已导入') && m.includes('test.version')))
  ok('import 后版本数 +1', svc.listVersions('test.version').versions.length === 3)

  /* 7.2.1 同秒连续写盘：备份名精确到秒会撞车，backupOf 退化为 ''（最近一份备份仍是最新一次操作的前置状态） */
  const im2 = await svc.importConfig('test.version', '# 第二次\nfoo: 10\n')
  console.log(`    同秒第二次 import: backupOf=${JSON.stringify(im2.backupOf)}`)
  ok('同秒第二次 import：backupOf 为空串（无法区分新增）', im2.backupOf === '', im2.backupOf || '（空）')
  ok('同秒第二次 import：内容仍正确落盘', fs.readFileSync(tmpCfg, 'utf8') === '# 第二次\nfoo: 10\n')
  ok('同秒第二次 import：备份数不增（同名覆盖）', svc.listVersions('test.version').versions.length === 3)

  /* 7.3 import 校验失败：一律不写盘 */
  console.log('\n  import 拒绝路径（都不该写盘）：')
  const beforeCount = fs.readdirSync(tmpBackupDir).length
  const beforeBody = fs.readFileSync(tmpCfg, 'utf8')
  const bads = [
    ['非字符串', 123],
    ['null', null],
    ['对象不是字符串', {foo: 1}],
    ['超 256KB', 'a: 1\n' + '#'.repeat(262144)],
    ['YAML 语法错', 'foo: [1,'],
    ['顶层是数组', '- 1\n- 2\n'],
    ['顶层是标量', '123'],
    ['顶层是 null（空内容）', ''],
    ['只有注释', '# nothing\n'],
  ]
  for (const [label, value] of bads) {
    let msg = ''
    try { await svc.importConfig('test.version', value) } catch (err) { msg = err.message }
    ok(`拒绝 ${label}`, msg !== '', msg || '（没抛错！）')
  }
  ok('全部拒绝后磁盘文件一字未改', fs.readFileSync(tmpCfg, 'utf8') === beforeBody)
  ok('全部拒绝后没多出备份', fs.readdirSync(tmpBackupDir).length === beforeCount)

  /* 7.4 超大文件降级 */
  console.log('\n  diff 降级（>3000 行）：')
  const bigCfg = path.join(TMP_DIR, 'test.big.yaml')
  const bigBackupDir = path.join(BACKUP_ROOT, 'test.big')
  fs.rmSync(bigBackupDir, {recursive: true, force: true})
  fs.mkdirSync(bigBackupDir, {recursive: true})
  const oldBig = Array.from({length: 1600}, (_, i) => `k${i}: old`).join('\n') + '\n'
  const newBig = Array.from({length: 1600}, (_, i) => `k${i}: new`).join('\n') + '\n'
  fs.writeFileSync(bigCfg, newBig, 'utf8')
  fs.writeFileSync(path.join(bigBackupDir, '20260101-020202_test.big.yaml'), oldBig, 'utf8')
  const dvBig = svc.diffVersion('test.big', '20260101-020202_test.big.yaml')
  console.log(`    truncated=${dvBig.truncated} added=${dvBig.added} removed=${dvBig.removed} unchanged=${dvBig.unchanged} lines=${dvBig.lines.length}`)
  ok('降级标记 truncated=true', dvBig.truncated === true)
  ok('降级时 lines 为空数组', Array.isArray(dvBig.lines) && dvBig.lines.length === 0)
  ok('降级计数仍合理（1600 全改）', dvBig.added === 1600 && dvBig.removed === 1600 && dvBig.unchanged === 0,
    `${dvBig.added}/${dvBig.removed}/${dvBig.unchanged}`)

} finally {
  /* ---------- 清理：临时配置 + 临时备份目录全删 ---------- */
  fs.rmSync(TMP_DIR, {recursive: true, force: true})
  for (const k of ['test.version', 'test.big']) fs.rmSync(path.join(BACKUP_ROOT, k), {recursive: true, force: true})
}
ok('临时配置目录已删除', !fs.existsSync(TMP_DIR))
ok('临时备份目录已删除', !fs.existsSync(path.join(BACKUP_ROOT, 'test.version')) && !fs.existsSync(path.join(BACKUP_ROOT, 'test.big')))
ok('真实备份目录仍在', fs.existsSync(path.join(BACKUP_ROOT, 'system.bot')))
ok('真实配置 system.bot 未被改动（仍含 log_level）',
  fs.readFileSync(path.join(APP, 'config/config/bot.yaml'), 'utf8').includes('log_level'))

/* ---------- 8. 语法检查 ---------- */
console.log('\n  node --check：')
for (const f of [SVC, CTRL]) {
  try {
    execFileSync(process.execPath, ['--check', f], {stdio: 'pipe'})
    ok(path.basename(f), true)
  } catch (err) {
    ok(path.basename(f), false, String(err.stderr || err.message).slice(0, 200))
  }
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
