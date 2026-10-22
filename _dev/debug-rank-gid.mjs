import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const require = createRequire('D:/trss-yunzai/plugins/Guoba-Plugin/package.json')
const { createClient } = require('redis')
const GUOBA = 'D:/trss-yunzai/plugins/Guoba-Plugin'
const APP = 'D:/trss-yunzai'

const client = createClient({ socket: { host: '127.0.0.1', port: 6379 }, database: 0 })
await client.connect()
globalThis.redis = client

let src = fs.readFileSync(path.join(GUOBA, 'server/service/both/admin/RankService.js'), 'utf8')
src = src.replace(/^import[^\n]*$/gm, '')
  .replace(/^export\s+class\s+/gm, 'class ')
  .replace(/^export\s+default[^\n]*$/gm, '')
  .replace(/createRequire\(import\.meta\.url\)/g, '__req')

const statsStub = {
  groupNameMap: () => new Map(),
  userNameMap: () => new Map(),
  _iterBots: () => [],
}
const ctx = {
  __req: require, fs, path, console, Date, Map, Set, Math, JSON, RegExp, String, Number, Object, Array, Promise,
  Service: class { constructor() {} },
  autowired: () => statsStub,
  _paths: { pluginRoot: GUOBA, data: path.join(APP, 'data') },
  __stats: statsStub,
  redis: client,
}
ctx.globalThis = ctx
vm.createContext(ctx)
vm.runInContext(`${src}\n;globalThis.__SVC = RankService;`, ctx)
const svc = new ctx.__SVC({})
svc.statsService = statsStub

const scan = await svc._scanRank(true)
console.log('groups 键:', [...scan.groups.keys()].map(k => JSON.stringify(k)).join(' , '))
const g = scan.groups.get('57740408044@chatroom')
console.log('57740408044@chatroom 命中:', !!g)
if (g) {
  console.log('  chars types:', [...g.chars.keys()])
  console.log('  dmg chars 数:', g.chars.get('dmg')?.size, 'mark:', g.chars.get('mark')?.size)
  console.log('  rawAll 首个 pair:', [...(g.rawAll?.entries()||[])].slice(0,2).map(([k,v])=>k+' → '+v.join('|')).join(' ; '))
}
for (const probe of ['57740408044@chatroom', '57740408044', 'group-57740408044@chatroom']) {
  const r = await svc.board({ gid: probe, type: 'dmg', limit: 3 })
  console.log(`board({gid:'${probe}'}) → available=${r.available} empty=${r.empty} rows=${r.rows?.length} reason=${r.reason||''} keyUsedCheck=${r.rows?.[0]?.score ?? '-'}`)
}
await client.quit()
