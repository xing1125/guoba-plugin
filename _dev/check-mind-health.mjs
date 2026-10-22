/**
 * 荧之心智「记忆体检 + 批量清理」源码直载验证
 *
 * 不复制逻辑：把 YingMindService.js 原文丢进 vm 沙箱（剥 import、桩掉 Service/_paths/logger），
 * 验证的就是真实源码。cleanup 只用 __tmp_cleanup_test 假群文件，跑完连备份目录一起删干净。
 *
 * 用法：node _dev/check-mind-health.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const GUOBA = 'D:/trss-yunzai/plugins/Guoba-Plugin'
const SVC = path.join(GUOBA, 'server/service/both/admin/YingMindService.js')
const MEM = 'D:/trss-yunzai/plugins/YingAI/data/memory'
const DATA = path.dirname(MEM)
const TMP_GID = '__tmp_cleanup_test'

let pass = 0
let fail = 0
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✔ ${n}${d ? '  ' + d : ''}`) }
  else { fail++; console.log(`  ✘ ${n}${d ? '  ' + d : ''}`) }
}

/* ---------- 1. 源码载入沙箱 ---------- */
let src = fs.readFileSync(SVC, 'utf8')
const before = src.length
src = src
  .replace(/^import[^\n]*$/gm, '')
  .replace(/^export\s+class\s+/gm, 'class ')
  .replace(/^export\s+default[^\n]*$/gm, '')

const marks = []
const ctx = {
  Service: class Service { constructor(app) { this.app = app } },
  _paths: { pluginRoot: GUOBA },
  fs, path, console, Date, Math, JSON, Number, String, Object, Array, Map, Set, RegExp, Error, Promise,
  logger: { mark: (m) => marks.push(m) },
}
ctx.globalThis = ctx
vm.createContext(ctx)
vm.runInContext(`${src}\n;globalThis.__SVC = YingMindService;`, ctx)
const Svc = ctx.__SVC

ok('源码可加载（剥 import 后 ' + before + ' → ' + src.length + ' 字节）', typeof Svc === 'function')
const svc = new Svc({})
ok('dataDir 指向 YingAI/data', /YingAI[\\/]data$/.test(svc.dataDir), svc.dataDir)

/* ---------- 2. health() 全量 ---------- */
const h = svc.health()
console.log('\n  全量体检：')
console.log(`    scope=${h.scope} total=${h.total} groups=${h.groups} score=${h.score}`)
console.log(`    byTier=${JSON.stringify(h.byTier)}`)
console.log(`    issues=${JSON.stringify(h.issues)}`)
console.log(`    candidates=${h.candidates.length}  probeFiles=${h.probeFiles.length}`)
console.log(`    probeFiles: ${h.probeFiles.map((p) => p.file + ':' + p.count).join(', ')}`)
for (const c of h.candidates.slice(0, 3)) {
  console.log(`    · ${c.gid} #${c.index} v=${c.value.toFixed(3)} age=${c.ageDays}d [${c.reasons.join('|')}] ${c.text.replace(/\s+/g, ' ').slice(0, 28)}...`)
}

let realFiles = 0
let realMem = 0
let probeMem = 0
for (const f of fs.readdirSync(MEM)) {
  const base = f.replace(/\.json$/, '')
  const n = (JSON.parse(fs.readFileSync(path.join(MEM, f), 'utf8'))?.memories ?? []).length
  if (svc._isProbeGid(base)) probeMem += n
  else { realFiles++; realMem += n }
}
console.log(`    磁盘核对：真实群 ${realFiles} 个 / 真实记忆 ${realMem} 条 / 探针记忆 ${probeMem} 条 / 合计 ${realMem + probeMem}`)

ok('total 与磁盘真实群记忆数一致', h.total === realMem, `${h.total} vs ${realMem}`)
ok('groups 与磁盘真实群文件数一致', h.groups === realFiles, `${h.groups} vs ${realFiles}`)
ok('total + issues.probe = 全部文件记忆数', h.total + h.issues.probe === realMem + probeMem, `${h.total}+${h.issues.probe}`)
ok('candidates 非空', h.candidates.length > 0, `${h.candidates.length} 条`)
ok('probeFiles 含 __probe_launchsim(22)', h.probeFiles.some((p) => p.file === '__probe_launchsim' && p.count === 22), JSON.stringify(h.probeFiles.find((p) => p.file === '__probe_launchsim')))
ok('candidates 里没有探针 gid', h.candidates.every((c) => !svc._isProbeGid(c.gid)))
ok('candidates 按 value 升序', h.candidates.every((c, i, a) => i === 0 || a[i - 1].value <= c.value))
ok('score 在 0~100', h.score >= 0 && h.score <= 100, String(h.score))
ok('index 能反查回原文', h.candidates.slice(0, 20).every((c) => {
  const d = JSON.parse(fs.readFileSync(path.join(MEM, svc._diskName(c.gid, 'memory') + '.json'), 'utf8'))
  return String(d.memories[c.index]?.text ?? '').slice(0, 40) === c.text.slice(0, 40)
}))
ok('byTier 合计 = total', h.byTier.short + h.byTier.mid + h.byTier.long + h.byTier.unknown === h.total)

/* 参数清洗 + 单群 scope */
const hq = svc.health('38797933882', {staleDays: 'abc', lowValue: -99, minAge: -5})
ok('单群 scope=group 且 gid 归一', hq.scope === 'group' && hq.gid === '38797933882', `${hq.scope}/${hq.gid}`)
ok('lowValue 负数被夹到 0（不该有 lowValue 命中）', hq.issues.lowValue === 0, JSON.stringify(hq.issues))
ok('探针 gid 不给扫', svc.health('__probe_launchsim').groups === 0)

/* ---------- 2.5 跨群重复 + stale（两个临时假群，真实数据里这两项恰好为 0） ---------- */
console.log('\n  规则验证（临时假群）：')
const dupA = path.join(MEM, '__tmp_cleanup_test_dup_a@chatroom.json')
const dupB = path.join(MEM, '__tmp_cleanup_test_dup_b@chatroom.json')
const oldTs = Date.now() - 400 * 86400000
try {
  fs.writeFileSync(dupA, JSON.stringify({memories: [
    {text: '重复检测：这条记忆同时出现在两个群里，用来验证跨群去重指纹！', value: 0.9, tier: 'mid', createdAt: Date.now() - 10 * 86400000, lastTouched: Date.now(), consolidation: 5},
    {text: '这条很老，应该命中 stale', value: 0.9, tier: 'mid', createdAt: oldTs, lastTouched: oldTs, consolidation: 5},
  ]}, null, 2), 'utf8')
  // 标点与空格不同，但归一化后指纹相同
  fs.writeFileSync(dupB, JSON.stringify({memories: [
    {text: '重复检测 这条记忆同时出现在两个群里 用来验证跨群去重指纹', value: 0.9, tier: 'mid', createdAt: Date.now() - 10 * 86400000, lastTouched: Date.now(), consolidation: 5},
  ]}, null, 2), 'utf8')

  const hd = svc.health()
  const dups = hd.candidates.filter((c) => c.reasons.includes('duplicate'))
  const staleOne = hd.candidates.find((c) => c.gid === '__tmp_cleanup_test_dup_a' && c.text.includes('很老'))
  console.log(`    duplicate 候选=${dups.length}  dupWith=${JSON.stringify(dups.map((d) => d.dupWith))}`)
  ok('跨群同一指纹被标记 duplicate（2 条）', dups.length === 2, String(dups.length))
  ok('dupWith 指向另一个群', dups.length === 2 && dups.every((d) => d.dupWith.length === 1) && dups[0].dupWith[0] !== dups[0].gid)
  ok('标点/空格不同也算同指纹', hd.issues.duplicate === 2, String(hd.issues.duplicate))
  ok('陈年条目命中 stale', !!staleOne && staleOne.reasons.includes('stale'), JSON.stringify(staleOne?.reasons))
  ok('探针文件仍不进 candidates', hd.candidates.every((c) => !svc._isProbeGid(c.gid)))
} finally {
  for (const f of [dupA, dupB]) try { fs.rmSync(f, {force: true}) } catch { /* ignore */ }
}
ok('重复测试假群文件已删除', !fs.existsSync(dupA) && !fs.existsSync(dupB))

/* ---------- 3. cleanupMemories（假群文件） ---------- */
console.log('\n  批量清理（临时假群）：')
const tmpFile = path.join(MEM, `${TMP_GID}@chatroom.json`)
const seed = {
  memories: [
    {text: 'A 测试记忆一', value: 0.1, tier: 'mid', createdAt: 1792418118267, lastTouched: 1792418118267, consolidation: 0},
    {text: 'B 测试记忆二', value: 0.2, tier: 'mid', createdAt: 1792418118267, lastTouched: 1792418118267, consolidation: 0},
    {text: 'C 测试记忆三', value: 0.3, tier: 'mid', createdAt: 1792418118267, lastTouched: 1792418118267, consolidation: 0},
    {text: 'D 测试记忆四', value: 0.4, tier: 'mid', createdAt: 1792418118267, lastTouched: 1792418118267, consolidation: 0},
    {text: 'E 测试记忆五', value: 0.5, tier: 'mid', createdAt: 1792418118267, lastTouched: 1792418118267, consolidation: 0},
  ],
}
fs.writeFileSync(tmpFile, JSON.stringify(seed, null, 2), 'utf8')

let backupDir = ''
let cleaned = null
try {
  cleaned = await svc.cleanupMemories([
    {gid: TMP_GID, index: 0, oldText: 'A 测试记忆一'},
    {gid: TMP_GID + '@chatroom', index: 2, oldText: 'C 测试记忆三'},
    {gid: TMP_GID, index: 3, oldText: '文本已漂移，对不上'},
    {gid: TMP_GID, index: 1, oldText: 'B 测试记忆二'},
  ])
  backupDir = cleaned.backupDir
  const after = JSON.parse(fs.readFileSync(tmpFile, 'utf8'))
  const backupFile = path.join(backupDir, `${TMP_GID}@chatroom.json`)
  console.log(`    removed=${cleaned.removed} skipped=${cleaned.skipped} files=${JSON.stringify(cleaned.files)}`)
  console.log(`    backupDir=${path.basename(cleaned.backupDir)}  remainingTotal=${cleaned.remainingTotal}`)
  console.log(`    剩余文本: ${after.memories.map((m) => m.text).join(' / ')}`)
  ok('removed=3', cleaned.removed === 3, String(cleaned.removed))
  ok('skipped=1（漂移保护生效）', cleaned.skipped === 1, String(cleaned.skipped))
  ok('剩余 2 条且是原 3、4 号', after.memories.length === 2 && after.memories[0].text.startsWith('D') && after.memories[1].text.startsWith('E'))
  ok('备份目录名格式 YYYYMMDD_HHmmss', /^_backup_memory_cleanup_\d{8}_\d{6}$/.test(path.basename(backupDir)), path.basename(backupDir))
  ok('备份文件是清理前原样 5 条', fs.existsSync(backupFile) && JSON.parse(fs.readFileSync(backupFile, 'utf8')).memories.length === 5)
  ok('files 只含该群', cleaned.files.length === 1 && cleaned.files[0] === `${TMP_GID}@chatroom.json`)
  ok('remainingTotal = 清理后真实群总数', cleaned.remainingTotal === realMem + seed.memories.length - 3, `${cleaned.remainingTotal} vs ${realMem + 2}`)
  ok('logger.mark 记了清理日志', marks.some((m) => m.includes('记忆体检清理') && m.includes('删除 3 条')), marks.find((m) => m.includes('记忆体检清理')))
  ok('真实群文件未被改动', h.total === svc.health().total - 2) // 假群还剩 2 条
} finally {
  try { fs.rmSync(tmpFile, {force: true}) } catch { /* ignore */ }
  if (backupDir) try { fs.rmSync(backupDir, {recursive: true, force: true}) } catch { /* ignore */ }
}
ok('临时假群文件已删除', !fs.existsSync(tmpFile))
ok('临时备份目录已删除', !backupDir || !fs.existsSync(backupDir))

/* 3.1 整群全部漂移：不回写、不报错 */
{
  const f2 = path.join(MEM, '__tmp_cleanup_test_all_drift@chatroom.json')
  const body = JSON.stringify({memories: [{text: 'X1', value: 0.1}, {text: 'X2', value: 0.2}]}, null, 2)
  fs.writeFileSync(f2, body, 'utf8')
  const mt = fs.statSync(f2).mtimeMs
  let r = null
  try {
    r = await svc.cleanupMemories([
      {gid: '__tmp_cleanup_test_all_drift', index: 0, oldText: '漂移了'},
      {gid: '__tmp_cleanup_test_all_drift', index: 1, oldText: ''},
    ])
    ok('全部漂移：removed=0 / skipped=2', r.removed === 0 && r.skipped === 2, `removed=${r.removed} skipped=${r.skipped}`)
    ok('全部漂移：不回写该群文件', !r.files.includes('__tmp_cleanup_test_all_drift@chatroom.json'), JSON.stringify(r.files))
    ok('全部漂移：文件内容与 mtime 未变', fs.readFileSync(f2, 'utf8') === body && fs.statSync(f2).mtimeMs === mt)
  } finally {
    try { fs.rmSync(f2, {force: true}) } catch { /* ignore */ }
    if (r?.backupDir) try { fs.rmSync(r.backupDir, {recursive: true, force: true}) } catch { /* ignore */ }
  }
  ok('漂移测试假群已删除', !fs.existsSync(f2))
}

/* 边界：空 keys / 超 300 条 */
let e1 = ''
try { await svc.cleanupMemories([]) } catch (e) { e1 = e.message }
ok('空 keys 抛错', e1 === '没有需要清理的记忆', e1)
let e2 = ''
try { await svc.cleanupMemories(new Array(301).fill({gid: TMP_GID, index: 0, oldText: 'x'})) } catch (e) { e2 = e.message }
ok('超 300 条抛错', e2 === '单次最多清理 300 条', e2)

const finalTotal = svc.health().total
ok('收尾：真实群记忆数回到 ' + realMem, finalTotal === realMem, String(finalTotal))
ok('收尾：没有残留 _backup_memory_cleanup_* 目录', !fs.readdirSync(DATA).some((f) => f.startsWith('_backup_memory_cleanup_') && f !== path.basename(backupDir)))

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
