/**
 * Plugin update detection — compares each installed plugin's recorded runner
 * version (store.ts) against the latest version published in the shared
 * plugin-registry (registryCache.ts). Used by `plugin update` and the
 * post-command update notice in index.ts.
 */

import { getAllInstalledPlugins } from './store.js'
import { getRegistry } from './registryCache.js'

export interface PluginUpdateInfo {
  id: string
  type: 'core' | 'community'
  installedVersion: string
  latestVersion: string
}

/** Compares dotted version strings numerically, segment by segment. */
function isNewer(latest: string, installed: string): boolean {
  const a = latest.split('.').map((n) => parseInt(n, 10) || 0)
  const b = installed.split('.').map((n) => parseInt(n, 10) || 0)
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

export async function checkForPluginUpdates(): Promise<PluginUpdateInfo[]> {
  const installed = getAllInstalledPlugins()
  if (installed.length === 0) return []

  const registry = await getRegistry()
  const byId = new Map(registry.map((e) => [e.id, e]))

  const updates: PluginUpdateInfo[] = []
  for (const plugin of installed) {
    if (!plugin.version) continue
    const entry = byId.get(plugin.name)
    if (!entry) continue
    if (isNewer(entry.version, plugin.version)) {
      updates.push({
        id: plugin.name,
        type: entry.type,
        installedVersion: plugin.version,
        latestVersion: entry.version,
      })
    }
  }
  return updates
}
