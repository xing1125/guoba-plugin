/**
 * 群战力榜扩展接口（overview / char-usage / compare）源码直载验证
 *
 * 不复制逻辑：把 RankService.js 原文丢进 vm 沙箱（剥 import、桩掉 Service/autowired/_paths/statsService），
 * 跑的就是真源码；Redis 用真实客户端连 127.0.0.1:6379 db0，全程只读（SCAN / ZCARD / ZREVRANGE / GET）。
 *
 * 用法：node _dev/check-rank-ext.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import {createClient} from 'redis'

const GUOBA = 'D:/trss-yunzai/plugins/Guoba-Plugin'
const SVC = path.join(GUOBA, 'server/service/both/admin/RankService.js')
const RANK_KEY_RE = /^miao:rank:(.+):(dmg|mark|crit|valid):(\d+)$/
const normGid = (gid) => String(gid ?? '').replace(/^group-/, '').trim()
const displayGid = (gid) => normGid(gid).replace(/@chatroom$/, '')

let pass = 0
let fail = 0
const ok = (n, c, d = '') => {
  if (c) {
    pass++
    console.log(`  ✔ ${n}${d ? '  ' + d : ''}`)
  } else {
    fail++
    console.log(`  ✘ ${n}${d ? '  ' + d : ''}`)
  }
}
const ms = (t) => `${t}ms`

/* ---------- 1. Redis（只读） ---------- */
const client = createClient({url: 'redis://127.0.0.1:6379', database: 0})
client.on('error', (e) => console.log('  redis error:', e.message))
await client.connect()
ok('Redis 已连接（db0，只读用途）', client.isReady)
const dbSizeBefore = await client.dbSize()

/* ---------- 2. 源码载入沙箱 ---------- */
let src = fs.readFileSync(SVC, 'utf8')
const before = src.length
src = src
  .replace(/^import[^\n]*$/gm, '')
  .replace(/import\.meta\.url/g, '__req.url')
  .replace(/^export\s+class\s+/gm, 'class ')
  .replace(/^export\s+default[^\n]*$/gm, '')

const marks = []
// 群名/昵称都在 Bot 内存里，沙箱里拿不到，留空 Map（名称字段退化为 ''，不影响数字验证）
const statsStub = {
  userNameMap: () => new Map(),
  groupNameMap: () => new Map(),
}
const ctx = {
  Service: class Service {
    constructor(app) {
      this.app = app
    }
  },
  autowired: () => statsStub,
  _paths: {pluginRoot: GUOBA, data: path.join(GUOBA, 'data')},
  fs, path, console, Date, Math, JSON, Number, String, Object, Array, Map, Set, RegExp, Error, Promise,
  __req: {url: 'file://' + SVC},
  logger: {mark: (m) => marks.push(m)},
}
ctx.globalThis = ctx
ctx.redis = client
vm.createContext(ctx)
vm.runInContext(`${src}\n;globalThis.__SVC = RankService;`, ctx)
const Svc = ctx.__SVC

ok('源码可加载（剥 import 后 ' + before + ' → ' + src.length + ' 字节）', typeof Svc === 'function')
const svc = new Svc({})
ok('available=true（miao 资源目录存在）', svc.available === true, svc.miaoRoot)

/* ---------- 3. 独立地面真相：自己扫一遍键 ---------- */
const rawKeys = await client.keys('miao:rank:*')
const truth = new Map() // displayGid -> {pairs:Set, rawGids:Map}
for (const key of rawKeys) {
  const m = RANK_KEY_RE.exec(key)
  if (!m) continue
  const gid = displayGid(m[1])
  if (!gid) continue
  if (!truth.has(gid)) truth.set(gid, {pairs: new Set(), rawGids: new Map()})
  const t = truth.get(gid)
  t.pairs.add(`${m[2]}:${m[3]}`)
  t.rawGids.set(m[1], (t.rawGids.get(m[1]) || 0) + 1)
}
const truthKeys = [...truth.keys()]
console.log(`\n  地面真相：scan 到 ${rawKeys.length} 个 miao:rank:* 键，正则命中后归一出 ${truth.size} 个群`)
for (const [gid, t] of truth) {
  console.log(`    ${gid}  pairs=${t.pairs.size}  ${[...t.rawGids].map(([r, n]) => r + '=' + n).join(' ')}`)
}

/* ---------- 4. overview() ---------- */
console.log('\n  overview()：')
const t1 = Date.now()
const ov = await svc.overview({force: true})
const d1 = Date.now() - t1
const totalMembers = ov.groups.reduce((a, g) => a + g.members, 0)
const totalKeys = ov.groups.reduce((a, g) => a + g.keys, 0)
const totalChars = ov.groups.reduce((a, g) => a + g.charCount, 0)
console.log(`    耗时 ${ms(d1)}  groups=${ov.groups.length}  members=${totalMembers}  keys=${totalKeys}  charCount(去重)=${totalChars}`)
console.log(`    types=${JSON.stringify(ov.types)}`)
for (const g of ov.groups.slice(0, 3)) {
  console.log(`    · ${g.gid} rawGid=${g.rawGid} keys=${g.keys} charCount=${g.charCount} members=${g.members} types=${JSON.stringify(g.types)} topChar=${g.topChar ? g.topChar.name + '(' + g.topChar.id + ')' + g.topChar.count : 'null'}`)
}
const dual = ov.groups.filter((g) => g.rawGids.length > 1)
console.log(`    双前缀群 ${dual.length} 个：${dual.map((g) => g.gid + '[' + g.rawGids.join('|') + ']').join('  ')}`)

ok('groups.length 与地面真相一致', ov.groups.length === truth.size, `${ov.groups.length} vs ${truth.size}`)
ok('每个群的 gid 都不带 group- / @chatroom', ov.groups.every((g) => !g.gid.startsWith('group-') && !g.gid.includes('@chatroom')))
ok('members 总量 > 0', totalMembers > 0, String(totalMembers))
ok('按 members 降序', ov.groups.every((g, i, a) => i === 0 || a[i - 1].members >= g.members))
ok('至少一个群带 group- 前缀的原始键', ov.groups.some((g) => g.rawGids.some((r) => r.startsWith('group-'))),
  ov.groups.filter((g) => g.rawGids.some((r) => r.startsWith('group-'))).map((g) => g.gid).join(','))
ok('每个群 rawGid 属于自己的 rawGids', ov.groups.every((g) => g.rawGids.includes(g.rawGid)))
ok('charCount 与地面真相 pairs 数一致', ov.groups.every((g) => g.charCount === truth.get(g.gid).pairs.size))
ok('keys 与地面真相键数一致', ov.groups.every((g) => g.keys === [...truth.get(g.gid).rawGids.values()].reduce((a, b) => a + b, 0)))
ok('topChar 都非 null 且 count>0', ov.groups.every((g) => g.topChar && g.topChar.count > 0))

/* ---------- 5. charUsage() ---------- */
console.log('\n  charUsage({type:"dmg"})：')
const t2 = Date.now()
const cu = await svc.charUsage({type: 'dmg', limit: 30, force: true})
const d2 = Date.now() - t2
console.log(`    耗时 ${ms(d2)}  type=${cu.type}/${cu.typeLabel}  total=${cu.total}  chars=${cu.chars.length}`)
for (const c of cu.chars.slice(0, 5)) {
  console.log(`    · ${c.name}(${c.id}) ${c.game} ${c.star}星 ${c.elem}  groups=${c.groups} count=${c.count} avg=${c.avg}`)
}
ok('chars 非空', cu.chars.length > 0, String(cu.chars.length))
ok('按 count 降序', cu.chars.every((c, i, a) => i === 0 || a[i - 1].count >= c.count))
ok('groups <= 群数', cu.chars.every((c) => c.groups <= truth.size), `max groups=${Math.max(...cu.chars.map((c) => c.groups))}`)
ok('avg = count/groups（1 位小数）', cu.chars.every((c) => Math.abs(c.avg - Math.round((c.count / c.groups) * 10) / 10) < 1e-9))
ok('角色名不是 #id（meta 读到了）', cu.chars.every((c) => !c.name.startsWith('#')), cu.chars[0]?.name)
const truthDmgChars = new Set()
for (const t of truth.values()) for (const p of t.pairs) if (p.startsWith('dmg:')) truthDmgChars.add(p.slice(4))
ok('total = 地面真相里的 dmg 角色数', cu.total === truthDmgChars.size, `${cu.total} vs ${truthDmgChars.size}`)
const cuSr = await svc.charUsage({type: 'dmg', game: 'sr', limit: 5})
ok('game 过滤生效', cuSr.chars.every((c) => c.game === 'sr'), `sr ${cuSr.total} 个角色 / 前 5 条 ${cuSr.chars.length}`)
const cuMark = await svc.charUsage({type: 'mark', limit: 5})
ok('type=mark 可用', cuMark.type === 'mark' && cuMark.chars.length > 0, `total=${cuMark.total}`)

/* ---------- 6. compareGroups() ---------- */
console.log('\n  compareGroups({type:"dmg"})（自动选角色）：')
const t3 = Date.now()
const cmp = await svc.compareGroups({type: 'dmg'})
const d3 = Date.now() - t3
console.log(`    耗时 ${ms(d3)}  自动选中 ${cmp.char?.name}(${cmp.char?.id}) ${cmp.char?.game} ${cmp.char?.star}星`)
const withTop = cmp.groups.filter((g) => g.top)
console.log(`    groups=${cmp.groups.length}  有榜首 ${withTop.length} 个，前 3：`)
for (const g of cmp.groups.slice(0, 3)) {
  console.log(`    · ${g.gid} rawGid=${g.rawGid} count=${g.count} top=${g.top ? g.top.uid + ' score=' + g.top.score : 'null'}`)
}
ok('groups 有行', cmp.groups.length > 0, String(cmp.groups.length))
ok('自动选中了角色', !!cmp.char && !!cmp.char.id, JSON.stringify(cmp.char))
ok('有 top 的群按 score 降序', withTop.every((g, i, a) => i === 0 || a[i - 1].top.score >= g.top.score),
  withTop.map((g) => g.top.score).join(' > '))
ok('无 top 的群排在最后', cmp.groups.slice(withTop.length).every((g) => !g.top))
ok('count>0 的群都有 top', cmp.groups.every((g) => !(g.count > 0 && !g.top)))
ok('count 与 zCard 一致（抽第 1 个有 top 的群）', await (async () => {
  const g = withTop[0]
  if (!g) return false
  const n = await client.zCard(`miao:rank:${g.rawGid}:${cmp.type}:${cmp.char.id}`)
  return Number(n) >= g.count
})(), `rawGid=${withTop[0]?.rawGid}`)
const cmp2 = await svc.compareGroups({type: 'dmg', charId: cu.chars[0].id})
ok('指定 charId 时生效', cmp2.char.id === cu.chars[0].id, `${cmp2.char.name}(${cmp2.char.id})`)

/* ---------- 7. 原始 key 正确性专项 ---------- */
console.log('\n  原始 key 正确性（两种前缀）：')
const probe =
  ov.groups.find((g) => g.rawGid.startsWith('group-') && g.rawGids.length > 1) ||
  ov.groups.find((g) => g.rawGid.startsWith('group-'))
const probeChar = probe.topChar.id
const keyRaw = `miao:rank:${probe.rawGid}:dmg:${probeChar}`
const keyOther = `miao:rank:${probe.gid}@chatroom:dmg:${probeChar}`
const keySpliced = `miao:rank:${probe.gid}:dmg:${probeChar}` // board() 现在的拼法
const [nRaw, nOther, nSpliced] = await Promise.all([
  client.zCard(keyRaw).catch(() => -1),
  client.zCard(keyOther).catch(() => -1),
  client.zCard(keySpliced).catch(() => -1),
])
console.log(`    群 ${probe.gid}（rawGid=${probe.rawGid}，共 ${probe.rawGids.length} 种前缀）角色 ${probe.topChar.name}(${probeChar})`)
console.log(`      A 原始键        ${keyRaw}  → zCard=${nRaw}`)
console.log(`      B 另一前缀       ${keyOther}  → zCard=${nOther}`)
console.log(`      C 归一 gid 拼接  ${keySpliced}  → zCard=${nSpliced}   ← board() 的写法`)
ok('A 原始键 zCard > 0（真的是有效键）', nRaw > 0, String(nRaw))
ok('C 归一拼接 zCard = 0（证明反推 key 会丢数据）', nSpliced === 0, String(nSpliced))
ok('probe 群 rawGid 带 group- 前缀', probe.rawGid.startsWith('group-'), probe.rawGid)

console.log('\n  双前缀群的同角色 zCard 对比（dmg，取该群 topChar）：')
const dualCmp = []
for (const g of ov.groups.filter((x) => x.rawGids.length > 1)) {
  const cards = await Promise.all(g.rawGids.map((r) => client.zCard(`miao:rank:${r}:dmg:${g.topChar.id}`)))
  dualCmp.push({gid: g.gid, char: g.topChar.name, rawGids: g.rawGids, cards})
  console.log(`    ${g.gid} ${g.topChar.name}(${g.topChar.id})  ${g.rawGids.map((r, i) => r + '=' + cards[i]).join('  ')}`)
}
ok('双前缀下两种键人数不同（不是镜像，不能直接相加）',
  dualCmp.length > 0 && dualCmp.some((d) => d.cards[0] !== d.cards[1]),
  dualCmp.map((d) => d.gid + ':' + d.cards.join('/')).join(' '))

/* ---------- 8. 缓存与耗时 ---------- */
console.log('\n  缓存与耗时：')
const t4 = Date.now()
const ov2 = await svc.overview()
const d4 = Date.now() - t4
const t5 = Date.now()
const cu2 = await svc.charUsage({type: 'dmg'})
const d5 = Date.now() - t5
const t6 = Date.now()
const ov3 = await svc.overview({force: true})
const d6 = Date.now() - t6
console.log(`    overview()  首次(force)=${ms(d1)}  命中缓存=${ms(d4)}  再次 force=${ms(d6)}`)
console.log(`    charUsage() 首次(force)=${ms(d2)}  命中缓存=${ms(d5)}`)
ok('overview 命中缓存明显更快', d4 < d1, `${d4} < ${d1}`)
ok('charUsage 命中缓存明显更快', d5 < d2, `${d5} < ${d2}`)
ok('命中缓存返回同样的群数', ov2.groups.length === ov.groups.length)
ok('命中缓存返回同样的角色数', cu2.total === cu.total)
ok('force 能刷新（内容仍一致）', ov3.groups.length === ov.groups.length)
ok('compareGroups 结果与缓存一致', cmp.groups.length === (await svc.compareGroups({type: 'dmg'})).groups.length)

/* ---------- 9. 回归：listGroups / board 结构没被改坏 ---------- */
console.log('\n  回归（原有接口）：')
const lg = await svc.listGroups()
ok('listGroups 结构不变', Array.isArray(lg.groups) && lg.groups.every((g) => 'gid' in g && 'types' in g && 'charCount' in g && !('rawKeys' in g)),
  `${lg.groups.length} 个群`)
const bd = await svc.board({gid: '38797933882@chatroom', type: 'dmg', limit: 5})
ok('board() 对普通前缀群仍能出榜', Array.isArray(bd.rows) && bd.rows.length > 0, `${bd.rows?.length} 行 / ${bd.chars?.length} 角色 / ${bd.gidName || '(无名)'}`)
const bdGroup = await svc.board({gid: '57740408044@chatroom', type: 'dmg', limit: 5})
console.log(`    （已知遗留问题，本次未改）board() 对只有 group- 前缀的群 57740408044：empty=${!!bdGroup.empty} rows=${bdGroup.rows?.length ?? 0}`)

/* ---------- 10. 收尾：只读校验 ---------- */
const dbSizeAfter = await client.dbSize()
ok('Redis 全程只读（dbSize 前后一致）', dbSizeAfter === dbSizeBefore, `${dbSizeBefore} → ${dbSizeAfter}`)

await client.disconnect()
console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
