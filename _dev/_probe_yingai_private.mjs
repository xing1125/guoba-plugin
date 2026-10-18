/**
 * 私聊端「用户对比 · 综合 / 单用户」数据层探针
 * 直连 YingAiData.js（零锅巴框架依赖），跑真实 data/private 数据 + 造临时用户。
 *
 * 用法：node _dev/_probe_yingai_private.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import {createYingAiData} from '../server/service/both/admin/YingAiData.js'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const GUOBA = path.resolve(HERE, '..')
const PRIVATE = path.resolve(GUOBA, '..', 'YingAIPrivate')
const USERS = path.join(PRIVATE, 'data', 'private', 'users')

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${extra ? `  ← ${extra}` : ''}`)
  }
}

// ── 造两个对照用户：tmpprobe_bad（全是机器腔）、tmpprobe_good（干净短句） ──
const bad = 'tmpprobe_bad'
const good = 'tmpprobe_good'
function mkUser(uid, texts) {
  const dir = path.join(USERS, uid)
  fs.mkdirSync(dir, {recursive: true})
  const msgs = []
  texts.forEach((t, i) => {
    msgs.push({role: 'user', name: '探针', text: `第${i}句`, ts: Date.now() - (texts.length - i) * 60000})
    msgs.push({role: 'assistant', text: t, ts: Date.now() - (texts.length - i) * 60000 + 1000})
  })
  fs.writeFileSync(path.join(dir, 'conversation.json'), JSON.stringify({id: uid, recentMessages: msgs}, null, 2))
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({name: uid}, null, 2))
}
const BAD_TEXTS = [
  '你今天怎么啦？是不是不开心？是不是累了？\n要不要跟我说说？\n我一直都在哦。\n你可以慢慢讲。',
  '你今天怎么这么安静呀？是不是有什么心事？\n跟我说说嘛。\n我听着呢。\n别憋着。',
  '你今天怎么突然不说话了？是不是我说错什么了？\n你告诉我。\n我改。\n真的。',
  '你今天怎么这样？是不是不喜欢我了？\n说清楚。\n我需要知道。\n快说。',
  '你今天怎么又这样，是不是又想多了？\n别多想。\n我在的。\n真的在。',
  '你今天怎么不说话，是不是睡着了？\n晚安。\n早点休息。\n记得喝水。',
]
const GOOD_TEXTS = ['嗯。', '哦。', '在呢。', '行。', '哈哈，去你的。', '懒得理你。']
mkUser(bad, BAD_TEXTS)
mkUser(good, GOOD_TEXTS)

const data = createYingAiData(PRIVATE)
data.invalidate()

// ── 1. compare 结构 ──
console.log('\n【1】compare 结构')
const c = data.compare()
ok('返回 list/baseline/total', Array.isArray(c.list) && !!c.baseline && typeof c.total === 'number')
ok('total 与 list 长度一致', c.total === c.list.length, `${c.total} vs ${c.list.length}`)
ok('baseline 含 5 项对照值', ['avg', 'over40', 'question', 'multi', 'tpl'].every((k) => typeof c.baseline[k] === 'number'))
const FIELDS = ['uid', 'name', 'label', 'short', 'n', 'avg', 'over40', 'question', 'multi', 'tpl', 'score']
ok('每项字段完整', c.list.every((r) => FIELDS.every((f) => r[f] !== undefined)), `缺 ${FIELDS.filter((f) => c.list.some((r) => r[f] === undefined))}`)
ok('不含测试/临时用户', !c.list.some((r) => /^(test_|tmp_|dbg|followup|_quarantine)/.test(r.uid)))
ok('只含有荧回复的用户', c.list.every((r) => r.n > 0))
ok('按 score 降序', c.list.every((r, i) => i === 0 || c.list[i - 1].score >= r.score))
ok('score 落在 0~100', c.list.every((r) => r.score >= 0 && r.score <= 100))

// ── 2. score 口径可复算 ──
console.log('\n【2】score 口径')
const badRow = c.list.find((r) => r.uid === bad)
const goodRow = c.list.find((r) => r.uid === good)
const expect = (r) => Math.round(Math.min(100, r.question * 0.4 + r.multi * 0.4 + r.tpl * 0.5 + r.over40 * 0.3) * 10) / 10
ok('bad 用户被算出高分', !!badRow && badRow.score >= 40, `score=${badRow?.score}`)
ok('good 用户被算出低分', !!goodRow && goodRow.score <= 20, `score=${goodRow?.score}`)
ok('bad 排在 good 之前', c.list.findIndex((r) => r.uid === bad) < c.list.findIndex((r) => r.uid === good))
ok('score 与公式复算一致', [badRow, goodRow].filter(Boolean).every((r) => Math.abs(expect(r) - r.score) < 0.11), `${badRow && expect(badRow)} / ${badRow?.score}`)

// ── 3. 综合视角 insights ──
console.log('\n【3】综合视角 insights')
const all = data.insights()
ok('scope = all', all.scope === 'all')
ok('uid 为空', all.uid === '')
ok('带 baseline', !!all.baseline && typeof all.baseline.question === 'number')
ok('metrics 有 over40Rate', typeof all.metrics.over40Rate === 'number')
ok('指标为百分数量级（0~100）', all.metrics.questionRate <= 1 && typeof all.metrics.questionRate === 'number')

// ── 4. 单用户视角 insights ──
console.log('\n【4】单用户视角 insights')
const one = data.insights(bad)
ok('scope = user', one.scope === 'user')
ok('uid 回填正确', one.uid === bad)
ok('metrics.aiMessages = 该用户条数', one.metrics.aiMessages === badRow.n, `${one.metrics.aiMessages} vs ${badRow.n}`)
ok('baseline 与综合一致', JSON.stringify(one.baseline) === JSON.stringify(all.baseline))
ok('有 warn 级问题', one.issues.some((i) => i.level === 'warn'), JSON.stringify(one.issues.map((i) => i.title)))
ok('问题文案含 vs 全体对照', one.issues.some((i) => /vs 全体/.test(i.detail)))
ok('问号率与 compare 行一致', Math.abs(one.metrics.questionRate * 100 - badRow.question) < 1.1, `${one.metrics.questionRate} vs ${badRow.question}`)

const oneGood = data.insights(good)
ok('干净用户判为健康或样本少', oneGood.issues.every((i) => i.level !== 'warn'), JSON.stringify(oneGood.issues.map((i) => i.title)))

const missing = data.insights('__nobody__')
ok('不存在的 uid 标 missing', missing.missing === true)
ok('不存在的 uid 不抛错且有提示', missing.issues.length > 0 && missing.metrics.aiMessages === 0)

// ── 5. 用户表与 compare 口径一致 ──
console.log('\n【5】用户表 / compare 口径一致')
const us = data.users({size: 100})
const row = us.list.find((u) => u.uid === bad)
ok('用户行带 score', !!row && typeof row.score === 'number')
ok('用户行 score 与 compare 一致', row.score === badRow.score, `${row.score} vs ${badRow.score}`)
ok('用户行带 style.over40Rate', typeof row.style.over40Rate === 'number')

// ── 6. 清理 ──
console.log('\n【6】清理探针用户')
let cleaned = 0
for (const uid of [bad, good]) {
  const dir = path.join(USERS, uid)
  try {
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f))
    fs.rmdirSync(dir)
    cleaned++
  } catch {}
}
ok('探针用户已清掉', cleaned === 2, `cleaned=${cleaned}`)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
