/**
 * BackupService 离线单测（不依赖 Bot 进程 / HTTP 接口）
 *
 * 做法：把服务源码里的 #guoba.* 别名与 better-sqlite3 路径改写成本地桩，
 * 然后在一个临时 data 目录里跑完整流程（health → create → list → prune → restore）。
 * 全程只碰 _dev/dbtest 下的副本，不动真实库。
 *
 * 用法：node _dev/probe-backup-service.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require2 = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMP = path.join(__dirname, 'dbtest');
const SRC = path.join(__dirname, '..', 'server', 'service', 'both', 'admin', 'BackupService.js');

let pass = 0, fail = 0;
const ok = (n, c, e = '') => {
  if (c) { pass++; console.log(`  ✔ ${n}${e ? '  ' + e : ''}`); }
  else { fail++; console.log(`  ✘ ${n}${e ? '  ' + e : ''}`); }
};

// ---------- 1. 把源码改写为可独立运行的模块 ----------
let src = fs.readFileSync(SRC, 'utf8');
src = src
  .replace(/import Database from 'better-sqlite3'/, `import Database from ${JSON.stringify('file:///' + path.join(__dirname, '..', 'node_modules', 'better-sqlite3', 'lib', 'index.js').replace(/\\/g, '/'))}`)
  .replace(/import \{autowired, Service\} from '#guoba\.framework'/, `
    const autowired = () => null;
    class Service { constructor(app) { this.app = app; } }
  `)
  .replace(/import \{_paths\} from '#guoba\.platform'/, `const _paths = { data: ${JSON.stringify(path.join(TEMP, 'data'))} }`);

const tmpFile = path.join(TEMP, 'BackupService.local.mjs');
fs.writeFileSync(tmpFile, src, 'utf8');
const { BackupService } = await import('file:///' + tmpFile.replace(/\\/g, '/'));

// ---------- 2. 跑流程 ----------
const svc = new BackupService({});

console.log('\n[1] health');
{
  const h = await svc.health();
  const admin = h.dbs.find((d) => d.key === 'admin');
  ok('返回两个库定义', h.dbs.length === 2, h.dbs.map((d) => d.key).join(','));
  ok('admin 库存在', admin?.exists);
  ok('integrity = ok', admin?.integrity === 'ok', String(admin?.integrity));
  ok('读到表清单', (admin?.tables?.length || 0) > 0, `${admin?.tables?.length} 张`);
  ok('备份目录已返回', typeof h.backupDir === 'string' && h.backupDir.includes('backups'));
  ok('Bot 主库缺失时优雅降级', h.dbs.find((d) => d.key === 'data')?.exists === false);
}

console.log('\n[2] create（热备 + SHA256 + integrity）');
let ts1 = '';
{
  const m = await svc.create();
  ts1 = m.ts;
  ok('manifest 有 ts', /^\d{8}-\d{6}$/.test(m.ts), m.ts);
  ok('只备份存在的库', m.files.length === 1, `${m.files.length} 个文件`);
  const f = m.files[0];
  ok('文件大小 > 0', f.size > 0, `${f.size}B`);
  ok('SHA256 64 位', /^[0-9a-f]{64}$/.test(f.sha256), f.sha256?.slice(0, 12) + '…');
  ok('备份副本 integrity = ok', f.integrity === 'ok', String(f.integrity));
  ok('manifest.json 落盘', fs.existsSync(path.join(TEMP, 'data/db/backups', m.ts, 'manifest.json')));
  let backupReadable = false;
  try {
    const DB = require2('better-sqlite3');
    const d = new DB(path.join(TEMP, 'data/db/backups', m.ts, 'admin.db'), { readonly: true });
    backupReadable = d.prepare('select count(*) n from admin_user').get().n >= 0;
    d.close();
  } catch {}
  ok('备份库可只读打开', backupReadable);
}

console.log('\n[3] list');
{
  const l = await svc.list(20);
  ok('列出 1 份备份', l.length === 1, String(l.length));
  ok('complete = true（有 manifest）', l[0]?.complete);
  ok('含文件明细', (l[0]?.files?.length || 0) === 1);
  ok('at 是 ISO 时间', /^\d{4}-\d{2}-\d{2}T/.test(l[0]?.at || ''), l[0]?.at);
}

console.log('\n[4] prune（多造 3 份再保留 2 份）');
{
  // 手工造 3 个历史目录（避免同秒重名）
  for (const d of ['20200101-010101', '20200102-010101', '20200103-010101']) {
    const dir = path.join(TEMP, 'data/db/backups', d);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(TEMP, 'data/db/admin.db'), path.join(dir, 'admin.db'));
  }
  const before = (await svc.list(99)).length;
  const r = await svc.prune(2);
  const after = (await svc.list(99)).length;
  ok('清理前 4 份', before === 4, String(before));
  ok('保留 2 份', after === 2, String(after));
  ok('被删的是最旧的', r.removed.includes('20200101-010101'), r.removed.join(','));
  ok('最新一份还在', !r.removed.includes(ts1));
}

console.log('\n[5] restore（临时目录内验证，confirm 守卫生效）');
{
  let threw = '';
  try { await svc.restore(ts1, false); } catch (e) { threw = e.message; }
  ok('未 confirm 时拒绝', threw.includes('二次确认'), threw);

  threw = '';
  try { await svc.restore('../../etc', true); } catch (e) { threw = e.message; }
  ok('非法时间戳被拒（路径穿越）', threw.includes('不合法'), threw);

  threw = '';
  try { await svc.restore('20990101-000000', true); } catch (e) { threw = e.message; }
  ok('不存在的备份被拒', threw.includes('不存在'), threw);

  const r = await svc.restore(ts1, true);
  ok('恢复执行成功', r.results[0]?.ok === true, JSON.stringify(r.results[0]?.mode));
  ok('恢复后 WAL 残留被清', !fs.existsSync(path.join(TEMP, 'data/db/admin.db-wal')));
}

console.log('\n[6] 边界');
{
  const r = await svc.prune(999);
  ok('keep 上限被夹取不报错', Array.isArray(r.removed));
  const l = await svc.list(0);
  ok('limit 非法时回退默认', l.length <= 20);
}

fs.rmSync(TEMP, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败（临时目录已清理）`);
process.exit(fail === 0 ? 0 : 1);
