/**
 * Core Plugin Registry
 *
 * Derives the list of runner-capable core plugins from the same
 * VoidenHQ/plugin-registry `extensions.json` that the Electron app reads
 * (see registryCache.ts) — no separate static snapshot to keep in sync.
 *
 * A core plugin is runner-capable when the registry marks it `hasRunner: true`
 * (set by plugin-registry maintainers when the plugin publishes a headless
 * runner.js bundle). Each such plugin is built and released as
 * {pluginId}-runner.js in its own GitHub repo (VoidenHQ/plugin-{dir}).
 * voiden-runner downloads and caches these files the same way community
 * plugins do: ~/.voiden/extensions/{id}/runner.js
 */

import { join } from 'path'
import { homedir } from 'os'
import { existsSync } from 'fs'
import { pathToFileURL } from 'url'
import { getRegistry, type RegistryEntry } from './registryCache.js'

// ─── Runner paths (priority: bundled-at-build-time > user cache > download) ───
const RUNNER_CACHE_DIR = join(homedir(), '.voiden', 'extensions')

// Bundled runners pre-downloaded by cleanup.sh at Voiden build time
function getBundledRunnerPath(pluginId: string): string | null {
  const candidates = [
    join(new URL('.', import.meta.url).pathname, '../../../../packages/voiden-runner/bundled-runners', `${pluginId}-runner.js`),
    join(new URL('.', import.meta.url).pathname, '../../../bundled-runners', `${pluginId}-runner.js`),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

export function getCoreRunnerPath(pluginId: string): string {
  return join(RUNNER_CACHE_DIR, pluginId, 'runner.js')
}

export function hasCoreRunner(pluginId: string): boolean {
  return !!getBundledRunnerPath(pluginId) || existsSync(getCoreRunnerPath(pluginId))
}

export function getCoreRunnerImportUrl(pluginId: string): string {
  // User cache (~/.voiden/extensions) takes priority over the bundled snapshot —
  // mirrors Electron's OTA-cache-over-bundled resolution (seedBundledPluginsToCache /
  // isOtaCached) — so `plugin update` can actually supersede a bundled runner.
  if (existsSync(getCoreRunnerPath(pluginId))) return pathToFileURL(getCoreRunnerPath(pluginId)).href
  const bundled = getBundledRunnerPath(pluginId)
  if (bundled) return pathToFileURL(bundled).href
  return pathToFileURL(getCoreRunnerPath(pluginId)).href
}

// ─── Plugin definition ────────────────────────────────────────────────────────

export interface PluginDefinition {
  /** Registry ID (e.g. 'voiden-rest-api') */
  name: string
  description: string
  /** GitHub repo slug for downloading the runner bundle */
  repo: string
  /** Asset name in the GitHub release (e.g. 'voiden-rest-api-runner.js') */
  runnerAsset: string
  /** Latest version published in the registry — used for update detection */
  version: string
  /** Import URL — file:// path to cached runner.js, or undefined if not cached */
  pluginPath: string | undefined
}

function toPluginDefinition(entry: RegistryEntry): PluginDefinition {
  return {
    name: entry.id,
    description: entry.description,
    repo: entry.repo,
    runnerAsset: entry.runnerAsset ?? `${entry.id}-runner.js`,
    version: entry.version,
    pluginPath: hasCoreRunner(entry.id) ? getCoreRunnerImportUrl(entry.id) : undefined,
  }
}

/** Core, runner-capable plugins — derived live from the plugin registry. */
export async function getCorePlugins(): Promise<PluginDefinition[]> {
  const entries = await getRegistry()
  return entries
    .filter((p) => p.type === 'core' && p.hasRunner)
    .map(toPluginDefinition)
}

export async function findPlugin(name: string): Promise<PluginDefinition | undefined> {
  const plugins = await getCorePlugins()
  return plugins.find((p) => p.name === name)
}

export async function listPluginNames(): Promise<string[]> {
  return (await getCorePlugins()).map((p) => p.name)
}
