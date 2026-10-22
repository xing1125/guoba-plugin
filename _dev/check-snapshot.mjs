/**
 * 每日快照采集（SnapshotService）源码直载验证
 *
 * 不复制逻辑：把 SnapshotService.js 原文丢进 vm 沙箱（剥 import、桩 Service/autowired/_paths/logger），
 * 验证的就是真实源码。yingMindService / rankService 用固定桩数据，不连真实 Redis / miao。
 *
 * 所有读写都在沙箱目录 _dev/__snap_tmp 里，跑完整个目录删掉，不碰真实 data/snapshots。
 *
 * 用法：node _dev/check-snapshot.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const GUOBA = 'D:/trss-yunzai/plugins/Guoba-Plugin'
const SVC = path.join(GUOBA, 'server/service/both/admin/SnapshotService.js')
const SANDBOX = path.join(GUOBA, `_dev/__snap_tmp_${process.pid}`)
const REAL_DIR = path.join(GUOBA, 'data', 'snapshots')
const REAL_EXISTED = fs.existsSync(REAL_DIR)

let pass = 0
let fail = 0
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✔ ${n}${d ? '  ' + d : ''}`) }
  else { fail++; console.log(`  ✘ ${n}${d ? '  ' + d : ''}`) }
}

/* ---------- 桩数据 ---------- */
const EMOTION_ROWS = [
  {gid: '43172716343', name: '测试群A', memoryCount: 12, relationCount: 3, mood: '愉悦', moodValue: 66.5},
  {gid: '38797933882', name: '测试群B', memoryCount: 5, relationCount: 1, mood: '平静', moodValue: 50},
  {gid: '111222333', name: '测试群C', memoryCount: 2, relationCount: 0, mood: '愉悦', moodValue: 71.2},
]
const RANK_ROWS = {
  available: true,
  types: [{key: 'dmg', label: '伤害', groups: 2}],
  groups: [
    {gid: '43172716343', name: '测试群A', rawGid: '43172716343@chatroom', boardGid: '43172716343@chatroom', charCount: 18, keys: 40, members: 25, types: ['dmg'], topChar: {id: '10000002', name: '神里绫华', count: 12}},
    {gid: '38797933882', name: '测试群B', rawGid: '38797933882@chatroom', boardGid: '38797933882@chatroom', charCount: 9, keys: 21, members: 10, types: ['dmg'], topChar: {id: '10000003', name: '胡桃', count: 6}},
  ],
  scannedAt: new Date().toISOString(),
}
const EMOTION_TOTAL = EMOTION_ROWS.length
const RANK_TOTAL = RANK_ROWS.groups.length
const MEMBERS_SUM = RANK_ROWS.groups.reduce((s, g) => s + g.members, 0)
const VALUE_AVG = Math.round((EMOTION_ROWS.reduce((s, g) => s + g.moodValue, 0) / EMOTION_ROWS.length) * 10) / 10

/* ---------- 1. 源码载入沙箱 ---------- */
let src = fs.readFileSync(SVC, 'utf8')
const before = src.length
src = src
  .replace(/^import[^\n]*$/gm, '')
  .replace(/^export\s+class\s+/gm, 'class ')
  .replace(/^export\s+default[^\n]*$/gm, '')

const marks = []
const warns = []
const stubs = {
  yingMindService: {groups: () => EMOTION_ROWS.map((g) => ({...g}))},
  rankService: {overview: async () => JSON.parse(JSON.stringify(RANK_ROWS))},
}
const ctx = {
  Service: class Service { constructor(app) { this.app = app } },
  autowired: (name) => stubs[name],
  _paths: {root: SANDBOX},
  fs, path, console, Date, Math, JSON, Number, String, Object, Array, Map, Set, RegExp, Error, Promise,
  setTimeout: (fn) => 0,
  setInterval: (fn) => 0,
  clearInterval: () => {},
  logger: {mark: (m) => marks.push(m), warn: (m) => warns.push(m)},
}
ctx.globalThis = ctx
vm.createContext(ctx)
vm.runInContext(`${src}\n;globalThis.__SVC = SnapshotService;`, ctx)
const Svc = ctx.__SVC

ok('源码可加载（剥 import 后 ' + before + ' → ' + src.length + ' 字节）', typeof Svc === 'function')
const svc = new Svc({})
ok('dir 落在沙箱 data/snapshots', svc.dir === path.join(SANDBOX, 'data', 'snapshots'), svc.dir)
ok('真实 data/snapshots 未被触碰（测试前存在=' + REAL_EXISTED + '）', fs.existsSync(REAL_DIR) === REAL_EXISTED)

const today = (() => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})()
const listFiles = () => (fs.existsSync(svc.dir) ? fs.readdirSync(svc.dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)) : [])

try {
  /* ---------- 2. 首次 take ---------- */
  console.log('\n  首次 take：')
  ok('沙箱开始时是空的（没有历史残留）', !fs.existsSync(svc.dir))
  const snap = await svc.take()
  const file = path.join(svc.dir, `${today}.json`)
  const parsed = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
  console.log(`    文件名=${today}.json  目录=${path.relative(GUOBA, svc.dir)}`)
  console.log(`    takenAt=${snap.takenAt} emotion=${snap.emotion.length} rank=${snap.rank.length}`)
  console.log(`    emotion[0]=${JSON.stringify(snap.emotion[0])}`)
  console.log(`    rank[0]=${JSON.stringify(snap.rank[0])}`)
  ok('文件已生成', fs.existsSync(file), `${today}.json`)
  ok('内容是合法 JSON 且字段齐全', !!parsed && parsed.date === today && typeof parsed.takenAt === 'number' && Array.isArray(parsed.emotion) && Array.isArray(parsed.rank))
  ok('emotion 条数 = 桩数据 ' + EMOTION_TOTAL, parsed?.emotion.length === EMOTION_TOTAL, String(parsed?.emotion.length))
  ok('rank 条数 = 桩数据 ' + RANK_TOTAL, parsed?.rank.length === RANK_TOTAL, String(parsed?.rank.length))
  ok('emotion 字段映射 gid/name/mood/value', JSON.stringify(parsed?.emotion[0]) === JSON.stringify({gid: '43172716343', name: '测试群A', mood: '愉悦', value: 66.5}), JSON.stringify(parsed?.emotion[0]))
  ok('rank 字段映射含 topCharName/topCharCount', parsed?.rank[0].topCharName === '神里绫华' && parsed?.rank[0].topCharCount === 12 && parsed?.rank[0].members === 25, JSON.stringify(parsed?.rank[0]))
  ok('logger.mark 记录了采集日志', marks.some((m) => m.includes('[Snapshot] 已采集') && m.includes(`情绪 ${EMOTION_TOTAL} 条`)), marks[marks.length - 1])

  /* ---------- 3. 同一天二次 take ---------- */
  console.log('\n  同日重复采集：')
  await svc.take()
  const files2 = listFiles()
  console.log(`    目录内快照文件：${files2.join(', ')}  共 ${files2.length} 个`)
  ok('仍然只有一个文件（覆盖而非追加）', files2.length === 1 && files2[0] === `${today}.json`, files2.join(','))

  /* ---------- 4. 伪造历史 + emotionTrend ---------- */
  console.log('\n  伪造 3 天历史 + 情绪曲线：')
  const fakeDays = ['2026-10-18', '2026-10-19', '2026-10-20']
  const fakeValues = {'2026-10-18': 40, '2026-10-19': 55.5, '2026-10-20': 60.25}
  const fakeMoods = {'2026-10-18': '低落', '2026-10-19': '平静', '2026-10-20': '愉悦'}
  for (const date of fakeDays) {
    fs.writeFileSync(path.join(svc.dir, `${date}.json`), JSON.stringify({
      date,
      takenAt: Date.parse(`${date}T12:00:00+08:00`),
      emotion: [
        {gid: '43172716343', name: '测试群A', mood: fakeMoods[date], value: fakeValues[date]},
        {gid: '38797933882', name: '测试群B', mood: '平静', value: 50},
      ],
      rank: [
        {gid: '43172716343', name: '测试群A', members: 20, charCount: 15, topCharName: '雷电将军', topCharCount: 9},
        {gid: '38797933882', name: '测试群B', members: 8, charCount: 7, topCharName: '胡桃', topCharCount: 5},
      ],
    }, null, 2), 'utf8')
  }
  const et = svc.emotionTrend({gid: '43172716343', days: 30})
  console.log(`    points=${et.count}  ${et.points.map((p) => `${p.date}:${p.mood}/${p.value}`).join('  ')}`)
  ok('points 长度 = 3 假 + 今天 = 4', et.count === 4, String(et.count))
  ok('日期正序（旧 → 新）', et.points.every((p, i, a) => i === 0 || a[i - 1].date < p.date), et.points.map((p) => p.date).join(' < '))
  ok('首尾日期正确', et.points[0].date === '2026-10-18' && et.points[et.count - 1].date === today)
  ok('gid 归一后回显', et.gid === '43172716343' && et.days === 30, `${et.gid}/${et.days}`)
  ok('历史值 1 位小数', et.points[2].value === 60.3 && et.points[1].value === 55.5, String(et.points[2].value))

  /* 带 @chatroom 也能匹配 */
  const etSuffix = svc.emotionTrend({gid: '43172716343@chatroom', days: 30})
  ok('gid 带 @chatroom 也能匹配', etSuffix.count === 4 && etSuffix.gid === '43172716343', `${etSuffix.count}/${etSuffix.gid}`)

  /* ---------- 5. 全站平均 ---------- */
  console.log('\n  全站平均（gid 空）：')
  const etAll = svc.emotionTrend({gid: '', days: 30})
  const todayPoint = etAll.points.find((p) => p.date === today)
  console.log(`    points=${etAll.count}  今天=${todayPoint.mood}/${todayPoint.value}  期望均值=${VALUE_AVG}`)
  console.log(`    ${etAll.points.map((p) => `${p.date}:${p.mood}/${p.value}`).join('  ')}`)
  ok('全站也有 4 个点', etAll.count === 4, String(etAll.count))
  ok('今天 value = 3 群平均（1 位小数）', todayPoint.value === VALUE_AVG, `${todayPoint.value} vs ${VALUE_AVG}`)
  ok('今天 mood = 出现最多的「愉悦」（2/3）', todayPoint.mood === '愉悦', todayPoint.mood)
  ok('全部 value 都是 1 位小数', etAll.points.every((p) => Math.round(p.value * 10) === p.value * 10), JSON.stringify(etAll.points.map((p) => p.value)))

  /* ---------- 6. 战力汇总 ---------- */
  console.log('\n  战力趋势：')
  const rtAll = svc.rankTrend({gid: '', days: 30})
  const rtToday = rtAll.points.find((p) => p.date === today)
  console.log(`    points=${rtAll.count}  今天 members=${rtToday.members}（=25+10）charCount=${rtToday.charCount} top=${rtToday.topCharName}/${rtToday.topCharCount}`)
  ok('全站 members 是求和', rtToday.members === MEMBERS_SUM, `${rtToday.members} vs ${MEMBERS_SUM}`)
  ok('全站 charCount 是求和', rtToday.charCount === 27, String(rtToday.charCount))
  ok('topChar 取当天人数最高的（神里绫华 12 > 胡桃 6）', rtToday.topCharName === '神里绫华' && rtToday.topCharCount === 12, `${rtToday.topCharName}/${rtToday.topCharCount}`)
  ok('日期正序', rtAll.points.every((p, i, a) => i === 0 || a[i - 1].date < p.date))
  const rtOne = svc.rankTrend({gid: '38797933882', days: 30})
  console.log(`    单群 38797933882 → ${rtOne.points.map((p) => `${p.date}:m=${p.members}/c=${p.charCount}`).join('  ')}`)
  ok('单群逐日', rtOne.count === 4 && rtOne.points[3].members === 10 && rtOne.points[3].topCharName === '胡桃', String(rtOne.count))

  /* ---------- 7. list ---------- */
  console.log('\n  list：')
  const ls = svc.list(30)
  console.log(`    dir=${path.relative(GUOBA, ls.dir)}  count=${ls.count}  files=${ls.files.join(', ')}`)
  console.log(`    latest=${JSON.stringify(ls.latest)}`)
  ok('files 倒序', ls.files.join(',') === [...ls.files].sort().reverse().join(','), ls.files.join(','))
  ok('latest 是今天且条数正确', ls.latest?.date === today && ls.latest.emotionCount === EMOTION_TOTAL && ls.latest.rankCount === RANK_TOTAL, JSON.stringify(ls.latest))
  ok('list(days=2) 只给 2 个', svc.list(2).count === 2, String(svc.list(2).count))

  /* ---------- 8. 过期清理 ---------- */
  console.log('\n  过期清理（造 95 个假日期）：')
  const base = new Date('2026-10-17T00:00:00')
  for (let i = 0; i < 95; i++) {
    const d = new Date(base.getTime() - i * 86400000)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    fs.writeFileSync(path.join(svc.dir, `${key}.json`), JSON.stringify({date: key, takenAt: Date.now(), emotion: [], rank: []}), 'utf8')
  }
  const beforeCount = listFiles().length
  await svc.take()
  const afterCount = listFiles().length
  const remain = listFiles().sort()
  console.log(`    清理前 ${beforeCount} 个 → 清理后 ${afterCount} 个`)
  console.log(`    最旧=${remain[0]}  最新=${remain[remain.length - 1]}  今天在=${remain.includes(`${today}.json`)}`)
  ok('清理后正好 90 个（KEEP_DAYS）', afterCount === 90, String(afterCount))
  ok('今天那份被保留', remain.includes(`${today}.json`))
  ok('最旧的是 90 天前而不是造的最老文件', remain[0] > '2026-01-01', `最旧=${remain[0]}`)
  ok('清理后仍能正常查曲线', svc.emotionTrend({gid: '43172716343', days: 30}).count === 4, String(svc.emotionTrend({gid: '43172716343', days: 30}).count))

  /* ---------- 9. 不可用降级 ---------- */
  console.log('\n  降级：rank 不可用 / groups 抛错：')
  stubs.rankService.overview = async () => ({available: false, types: [], groups: [], scannedAt: ''})
  stubs.yingMindService.groups = () => { throw new Error('模拟 readdir 炸了') }
  const degraded = await svc.take()
  console.log(`    emotion=${degraded.emotion.length} rank=${degraded.rank.length} warn=${warns.length} 条`)
  console.log(`    warn: ${warns.join(' | ')}`)
  ok('rank 不可用 → rank 空数组，不整体失败', degraded.rank.length === 0 && degraded.emotion.length === 0)
  ok('情绪采集抛错只走 logger.warn', warns.some((w) => w.includes('[Snapshot] 情绪采集失败')), warns.join(' | '))
  ok('降级快照仍然落盘', !!JSON.parse(fs.readFileSync(path.join(svc.dir, `${today}.json`), 'utf8')).date)

  /* rank 真抛错时也不能把快照带崩 */
  stubs.rankService.overview = async () => { throw new Error('模拟 redis 挂了') }
  const degraded2 = await svc.take()
  ok('rank 抛错也只给空数组并记 warn', degraded2.rank.length === 0 && warns.some((w) => w.includes('[Snapshot] 战力采集失败')), warns[warns.length - 1])

  /* ---------- 10. start/stop 幂等 ---------- */
  console.log('\n  start/stop：')
  let intervals = 0
  let cleared = 0
  ctx.setInterval = () => { intervals++; return {unref: () => {}} }
  ctx.clearInterval = () => { cleared++ }
  svc.start()
  svc.start()
  ok('start 幂等（只起一个 interval）', intervals === 1, String(intervals))
  svc.stop()
  ok('stop 清掉 timer', cleared === 1 && svc._timer === null, `${cleared}/${svc._timer}`)
} finally {
  /* ---------- 11. 清理沙箱 ---------- */
  try { fs.rmSync(SANDBOX, {recursive: true, force: true}) } catch { /* ignore */ }
}

console.log('\n  清理：')
ok('沙箱目录已删除', !fs.existsSync(SANDBOX), SANDBOX)
ok('真实 data/snapshots 仍' + (REAL_EXISTED ? '存在且未新增测试文件' : '不存在'), fs.existsSync(REAL_DIR) === REAL_EXISTED &&
  (!REAL_EXISTED || !fs.readdirSync(REAL_DIR).some((f) => f.startsWith('__snap'))))

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
