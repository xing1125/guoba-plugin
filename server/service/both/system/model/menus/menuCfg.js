/**
 * 菜单显隐 / 排序偏好（导航管理页读写）
 *
 * 存 Redis：Yz:Guoba:admin:menuCfg → JSON { hidden: string[], order: string[] }
 *  - hidden：被屏蔽的菜单 key（meta.perm，无 perm 的插件菜单按 path）
 *  - order ：完整排序（按 key 顺序排列；不在其中的保持默认相对顺序，排在已排序项之后）
 *
 * Redis 不可用时静默退化为默认（全显示、默认顺序），不影响后台启动。
 */

const KEY = 'Yz:Guoba:admin:menuCfg'

function normalize(cfg) {
  const o = cfg && typeof cfg === 'object' ? cfg : {}
  const hidden = Array.isArray(o.hidden) ? o.hidden.map(String).filter(Boolean).slice(0, 100) : []
  const order = Array.isArray(o.order) ? o.order.map(String).filter(Boolean).slice(0, 100) : []
  return {hidden, order}
}

export async function readMenuCfg() {
  try {
    const raw = globalThis.redis ? await globalThis.redis.get(KEY) : null
    if (raw) {
      return normalize(JSON.parse(raw))
    }
  } catch {}
  return {hidden: [], order: []}
}

export async function writeMenuCfg(cfg) {
  const clean = normalize(cfg)
  if (!globalThis.redis) {
    throw new Error('Redis 不可用，无法保存导航配置')
  }
  await globalThis.redis.set(KEY, JSON.stringify(clean))
  return clean
}
