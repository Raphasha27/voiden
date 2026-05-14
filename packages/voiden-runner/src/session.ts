import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { STORE_DIR } from './plugins/store.js'
import type { RunResult } from './types.js'

const ENV_PATH = join(STORE_DIR, 'env.json')
const RESULTS_PATH = join(STORE_DIR, 'results.json')
const VARS_PATH = join(STORE_DIR, '.process.env.json')

export function loadSessionEnv(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {}
  try {
    return JSON.parse(readFileSync(ENV_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

export function saveSessionEnv(env: Record<string, string>): void {
  writeFileSync(ENV_PATH, JSON.stringify(env, null, 2), 'utf-8')
}

export interface SessionResult {
  file: string
  result: RunResult
}

export function loadSessionResults(): SessionResult[] {
  if (!existsSync(RESULTS_PATH)) return []
  try {
    return JSON.parse(readFileSync(RESULTS_PATH, 'utf-8'))
  } catch {
    return []
  }
}

export function saveSessionResults(results: SessionResult[]): void {
  writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2), 'utf-8')
}

export function appendSessionResults(results: SessionResult[]): void {
  const existing = loadSessionResults()
  saveSessionResults([...existing, ...results])
}

export function clearSession(): void {
  if (existsSync(ENV_PATH)) unlinkSync(ENV_PATH)
  if (existsSync(RESULTS_PATH)) unlinkSync(RESULTS_PATH)
  if (existsSync(VARS_PATH)) unlinkSync(VARS_PATH)
}
