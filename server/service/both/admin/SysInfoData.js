import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * 系统信息数据层（纯逻辑，不依赖锅巴框架，可独立运行/探针验证）
 *
 * 采集分两档：
 *  - fast（2s 缓存）：Node os 模块即可拿到 —— OS/内核/运行时长/CPU 占用/内存/本机 IP/运行时
 *  - slow（30s 缓存）：需起子进程 —— OS 完整版本/主机型号/Swap/磁盘/电池（PowerShell）、GPU（nvidia-smi 优先，WMI 兜底）
 *
 * 所有子进程采集失败一律按缺项处理（返回 null / 空数组），绝不抛出，保证接口永不 500。
 */

const KB = 1024
const FAST_TTL = 2000
const SLOW_TTL = 30000

/** 单条 PowerShell 脚本一次拿全：OS 版本 / 主机型号 / 内存(含虚拟=物理+页面文件) / 电池 / 磁盘 / 显卡 */
const PS_SCRIPT = [
  '$ErrorActionPreference=\'SilentlyContinue\'; [Console]::OutputEncoding=[Text.Encoding]::UTF8',
  '$os=Get-CimInstance Win32_OperatingSystem',
  '$cs=Get-CimInstance Win32_ComputerSystem',
  '$b=Get-CimInstance Win32_Battery | Select-Object -First 1',
  '$bat=$null; if($b){$bat=[pscustomobject]@{pct=$b.EstimatedChargeRemaining;ac=($b.BatteryStatus -ne 1)}}',
  "$disks=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=2 OR DriveType=3 OR DriveType=4' | ForEach-Object {[pscustomobject]@{id=$_.DeviceID;label=$_.VolumeName;fs=$_.FileSystem;size=[int64]$_.Size;free=[int64]$_.FreeSpace}})",
  '$gpus=@(Get-CimInstance Win32_VideoController | ForEach-Object {[pscustomobject]@{name=$_.Name;ram=[int64]$_.AdapterRAM}})',
  '$pf=@(Get-CimInstance Win32_PageFileUsage | ForEach-Object {[pscustomobject]@{allocMB=[int64]$_.AllocatedBaseSize;usedMB=[int64]$_.CurrentUsage}})',
  '[pscustomobject]@{caption=$os.Caption;ver=$os.Version;build=$os.BuildNumber;model=$cs.Model;maker=$cs.Manufacturer;totalPhysKB=[int64]$os.TotalVisibleMemorySize;freePhysKB=[int64]$os.FreePhysicalMemory;totalVirtKB=[int64]$os.TotalVirtualMemorySize;freeVirtKB=[int64]$os.FreeVirtualMemory;battery=$bat;disks=$disks;gpus=$gpus;pfile=$pf} | ConvertTo-Json -Compress -Depth 4',
].join('; ')

const pct = (used, total) => (total > 0 ? Math.max(0, Math.min(100, Math.round((used / total) * 100))) : 0)
const numOr = (v, d) => {
  const n = Number(String(v).trim())
  return Number.isFinite(n) ? n : d
}
const clamp = (v) => Math.max(0, Math.min(100, v))

/** 运行命令，失败返回 null（采集类数据允许缺项） */
async function run(cmd, args) {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    })
    return stdout
  } catch {
    return null
  }
}

/* ============================ CPU 采样 ============================ */

function cpuSample() {
  return os.cpus().map((c) => {
    const t = c.times
    return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq }
  })
}

function cpuUsageBetween(a, b) {
  let idleAll = 0
  let totalAll = 0
  const perCore = b.map((s, i) => {
    const p = a[i] || s
    const dTotal = Math.max(1, s.total - p.total)
    const dIdle = Math.max(0, s.idle - p.idle)
    idleAll += dIdle
    totalAll += dTotal
    return clamp(Math.round((1 - dIdle / dTotal) * 100))
  })
  const usage = clamp(Math.round((1 - idleAll / Math.max(1, totalAll)) * 100))
  return { usage, perCore }
}

async function cpuUsageSampled(delayMs) {
  const a = cpuSample()
  await new Promise((r) => setTimeout(r, delayMs))
  return cpuUsageBetween(a, cpuSample())
}

/* ============================ fast 采集 ============================ */

function pickIp() {
  const nets = os.networkInterfaces()
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (!n.internal && n.family === 'IPv4' && n.address) return n.address
    }
  }
  return ''
}

async function collectFast() {
  const { usage, perCore } = await cpuUsageSampled(250)
  const cpus = os.cpus()
  const total = os.totalmem()
  const free = os.freemem()
  const used = total - free
  const locale = Intl.DateTimeFormat().resolvedOptions()
  return {
    collectedAt: new Date().toISOString(),
    os: { platform: os.platform(), type: os.type(), release: os.release(), arch: os.arch() },
    host: { hostname: os.hostname() },
    kernel: `${os.type()} ${os.release()}`,
    uptimeSec: Math.round(os.uptime()),
    botUptimeSec: Math.round(process.uptime()),
    cpu: {
      model: (cpus[0] && cpus[0].model ? cpus[0].model : 'Unknown').trim(),
      cores: cpus.length,
      speedMHz: (cpus[0] && cpus[0].speed) || 0,
      usage,
      perCore,
    },
    memory: { total, free, used, usedPct: pct(used, total) },
    net: { ip: pickIp() },
    runtime: {
      node: process.version,
      rss: process.memoryUsage().rss,
      locale: locale.locale,
      timezone: locale.timeZone,
    },
  }
}

/* ============================ slow 采集 ============================ */

async function collectSlow() {
  const result = { osInfo: null, hostInfo: null, swap: null, battery: null, disks: [], wmiGpus: [] }

  const raw = await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT,
  ])
  if (raw) {
    try {
      const j = JSON.parse(raw)
      result.osInfo = { caption: j.caption || '', version: j.ver || '', build: j.build || '' }
      result.hostInfo = { model: j.model || '', maker: j.maker || '' }
      // Swap：优先用页面文件真实计数（AllocatedBaseSize / CurrentUsage，MB），
      // 拿不到再退回「虚拟内存 - 物理」估算（commit charge 会高估，仅兜底）
      const pfile = Array.isArray(j.pfile) ? j.pfile : []
      let swapTotal = 0
      let swapUsed = 0
      if (pfile.length) {
        for (const p of pfile) {
          swapTotal += numOr(p.allocMB, 0) * 1024 * 1024
          swapUsed += numOr(p.usedMB, 0) * 1024 * 1024
        }
      } else {
        const totalPhys = (numOr(j.totalPhysKB, 0)) * KB
        const freePhys = (numOr(j.freePhysKB, 0)) * KB
        const totalVirt = (numOr(j.totalVirtKB, 0)) * KB
        const freeVirt = (numOr(j.freeVirtKB, 0)) * KB
        swapTotal = Math.max(0, totalVirt - totalPhys)
        swapUsed = Math.max(0, Math.min(totalVirt - freeVirt, swapTotal))
      }
      result.swap = swapTotal > 0
        ? { total: swapTotal, used: swapUsed, free: swapTotal - swapUsed, usedPct: pct(swapUsed, swapTotal) }
        : null
      result.battery = j.battery
        ? { pct: numOr(j.battery.pct, 0), ac: !!j.battery.ac }
        : null
      result.disks = (Array.isArray(j.disks) ? j.disks : [])
        .map((d) => {
          const size = numOr(d.size, 0)
          const free = numOr(d.free, 0)
          const used = Math.max(0, size - free)
          return {
            id: d.id || '', label: d.label || '', fs: d.fs || '',
            total: size, free, used, usedPct: pct(used, size),
          }
        })
        .filter((d) => d.total > 0)
      result.wmiGpus = (Array.isArray(j.gpus) ? j.gpus : [])
        .map((g) => ({ name: g.name || 'Unknown GPU', vramTotal: numOr(g.ram, 0) }))
    } catch {
      // 解析失败按缺项处理
    }
  }

  // GPU：nvidia-smi 优先（有利用率/显存/温度），失败回退 WMI（仅型号+显存）
  const gpus = []
  const smi = await run('nvidia-smi', [
    '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu',
    '--format=csv,noheader,nounits',
  ])
  if (smi) {
    for (const line of smi.split('\n')) {
      const parts = line.split(',').map((s) => s.trim())
      if (parts.length < 5 || !parts[0]) continue
      gpus.push({
        name: parts[0],
        utilPct: numOr(parts[1], null),
        vramUsed: numOr(parts[2], 0) * 1024 * 1024,
        vramTotal: numOr(parts[3], 0) * 1024 * 1024,
        temp: numOr(parts[4], null),
        source: 'nvidia-smi',
      })
    }
  }
  if (!gpus.length) {
    for (const g of result.wmiGpus) {
      gpus.push({ name: g.name, utilPct: null, vramUsed: 0, vramTotal: g.vramTotal, temp: null, source: 'wmi' })
    }
  }
  result.gpus = gpus
  delete result.wmiGpus
  return result
}

/* ============================ 缓存 + 对外工厂 ============================ */

export function createSysInfoData() {
  let fastCache = null
  let fastAt = 0
  let slowCache = null
  let slowAt = 0
  let fastInflight = null
  let slowInflight = null

  function getCached(cache, at, ttl) {
    return cache && Date.now() - at < ttl ? cache : null
  }

  async function getFast() {
    const hit = getCached(fastCache, fastAt, FAST_TTL)
    if (hit) return hit
    if (fastInflight) return fastInflight
    fastInflight = collectFast()
    fastInflight.then((v) => {
      fastCache = v
      fastAt = Date.now()
    }).catch(() => {}).finally(() => {
      fastInflight = null
    })
    return fastInflight
  }

  async function getSlow() {
    const hit = getCached(slowCache, slowAt, SLOW_TTL)
    if (hit) return hit
    if (slowInflight) return slowInflight
    slowInflight = collectSlow()
    slowInflight.then((v) => {
      slowCache = v
      slowAt = Date.now()
    }).catch(() => {}).finally(() => {
      slowInflight = null
    })
    return slowInflight
  }

  async function summary() {
    const [fast, slow] = await Promise.all([getFast(), getSlow()])
    return {
      ...fast,
      os: { ...fast.os, ...(slow.osInfo || {}) },
      host: { ...fast.host, ...(slow.hostInfo || {}) },
      swap: slow.swap,
      battery: slow.battery,
      disks: slow.disks,
      gpus: slow.gpus,
    }
  }

  function invalidate() {
    fastCache = null
    fastAt = 0
    slowCache = null
    slowAt = 0
  }

  return { summary, invalidate }
}

export default createSysInfoData
