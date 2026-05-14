#!/usr/bin/env node
import { program } from 'commander'
import { readFileSync, existsSync, statSync } from 'fs'
import { resolve, basename } from 'path'
import { readdir } from 'fs/promises'
import chalk from 'chalk'
import { runVoidFile } from './runner.js'
import { loadEnabledPlugins } from './plugins/loader.js'
import { exportToCsv } from './report/csv.js'
import { sendMailReport } from './report/mail.js'
import { CORE_PLUGINS, findPlugin } from './plugins/registry.js'
import {
  fetchCommunityPlugins,
  findCommunityPlugin,
  hasCommunityRunner,
  installCommunityRunner,
} from './plugins/community.js'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import {
  installPlugin,
  uninstallPlugin,
  setPluginEnabled,
  getAllInstalledPlugins,
  readStore,
  STORE_DIR,
} from './plugins/store.js'
import {
  loadSessionEnv,
  saveSessionEnv,
  appendSessionResults,
  loadSessionResults,
  clearSession,
} from './session.js'
import type { RunResult, CliReportEntry } from './types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function loadEnvFile(envPath: string): Record<string, string> {
  const content = readFileSync(envPath, 'utf-8')
  const env: Record<string, string> = {}
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) throw new Error(`Malformed line ${i + 1} in .env file: missing "="`)
    const key = line.slice(0, eq).trim()
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (!key) throw new Error(`Malformed line ${i + 1} in .env file: empty key`)
    env[key] = val
  }
  return env
}


function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

/** Recursively collect all .void files under a directory. */
async function collectVoidFiles(inputPath: string): Promise<string[]> {
  const abs = resolve(inputPath)
  if (!existsSync(abs)) return []

  const stat = statSync(abs)
  if (stat.isFile()) {
    return abs.endsWith('.void') ? [abs] : []
  }

  if (stat.isDirectory()) {
    const entries = await readdir(abs, { withFileTypes: true })
    const results: string[] = []
    for (const entry of entries) {
      const full = resolve(abs, entry.name)
      if (entry.isDirectory()) {
        results.push(...(await collectVoidFiles(full)))
      } else if (entry.isFile() && entry.name.endsWith('.void')) {
        results.push(full)
      }
    }
    return results
  }

  return []
}

/** Expand a list of paths/globs into resolved .void file paths. */
async function resolveFiles(patterns: string[]): Promise<string[]> {
  const resolved: string[] = []
  for (const pattern of patterns) {
    if (pattern.includes('*')) {
      const dir = resolve(pattern.replace(/\/?\*.*$/, '') || '.')
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.void')) {
          resolved.push(resolve(dir, entry.name))
        }
      }
    } else {
      resolved.push(...(await collectVoidFiles(pattern)))
    }
  }
  return resolved
}

// ─────────────────────────────────────────────────────────────────────────────
// Spinner
// ─────────────────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function startSpinner(label: string): () => void {
  if (!process.stdout.isTTY) return () => {}
  let frame = 0
  const interval = setInterval(() => {
    const spin = chalk.cyan(SPINNER_FRAMES[frame % SPINNER_FRAMES.length])
    process.stdout.write(`\r  ${spin}  ${chalk.gray(label)}   `)
    frame++
  }, 80)
  return () => {
    clearInterval(interval)
    process.stdout.write('\r' + ' '.repeat(label.length + 10) + '\r')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Run output formatters
// ─────────────────────────────────────────────────────────────────────────────

const DIVIDER = chalk.gray('─'.repeat(64))

function printRunHeader(fileCount: number, pluginCount: number): void {
  console.log()
  console.log(
    chalk.bold.white('  voiden-runner') +
    chalk.gray(` · ${fileCount} file${fileCount !== 1 ? 's' : ''}`) +
    chalk.gray(` · ${pluginCount} plugin${pluginCount !== 1 ? 's' : ''} active`)
  )
  console.log(DIVIDER)
}

// ─────────────────────────────────────────────────────────────────────────────
// Report entry renderer
// ─────────────────────────────────────────────────────────────────────────────

function renderReportEntries(entries: CliReportEntry[], verbose: boolean): void {
  const assertions = entries.filter(e => e.type === 'assertion')
  const logs = entries.filter(e => e.type === 'log')
  const sections = entries.filter(e => e.type === 'section')

  // Assertions — always shown (mirrors the test panel in the app)
  if (assertions.length > 0) {
    const passed = assertions.filter(e => e.type === 'assertion' && e.passed).length
    const failed = assertions.length - passed
    console.log(
      `       assertions: ${chalk.green(`${passed} passed`)}` +
      (failed > 0 ? chalk.red(` · ${failed} failed`) : '')
    )
    for (const e of assertions) {
      if (e.type !== 'assertion') continue
      const icon = e.passed ? chalk.green('  ✓') : chalk.red('  ✗')
      let line = `       ${icon}  ${e.message}`
      if (!e.passed && e.actual !== undefined && e.expected !== undefined) {
        line += chalk.gray(`  (got ${JSON.stringify(e.actual)}, expected ${e.operator ?? '=='} ${JSON.stringify(e.expected)})`)
      }
      console.log(line)
    }
  }

  // Script logs — only shown in verbose mode (same as app behaviour: logs visible in console panel)
  if (verbose && logs.length > 0) {
    const levelIcon: Record<string, string> = {
      info: chalk.blue('ℹ'),
      debug: chalk.gray('•'),
      warn: chalk.yellow('⚠'),
      error: chalk.red('✗'),
      log: chalk.gray('·'),
    }
    for (const e of logs) {
      if (e.type !== 'log') continue
      const icon = (e.level ? levelIcon[e.level] : undefined) ?? chalk.gray('·')
      console.log(chalk.gray(`       ${icon}  ${e.message}`))
    }
  }

  // Section titles — shown when verbose, useful for grouping named test blocks
  if (verbose) {
    for (const e of sections) {
      if (e.type !== 'section') continue
      console.log(chalk.bold.gray(`       ── ${e.title} ──`))
    }
  }
}

function printRequestResult(
  result: RunResult,
  filePath: string,
  index: number,
  total: number,
  showBody: boolean,
  verbose: boolean,
): void {
  const icon = result.success ? chalk.green('  ✓') : chalk.red('  ✗')
  const counter = chalk.gray(`[${index}/${total}]`)
  const fileName = chalk.bold(basename(filePath))

  console.log()
  console.log(`${counter} ${fileName}`)

  const proto = chalk.cyan(result.protocol.toUpperCase().padEnd(4))
  const method = result.method ? chalk.bold(result.method.padEnd(6)) + ' ' : '       '
  const url = chalk.underline(result.url || '—')
  const time = chalk.gray(formatDuration(result.durationMs))

  let statusPart = ''
  if (result.status !== undefined) {
    const statusColor = result.success ? chalk.green : chalk.red
    statusPart = statusColor(`  ${result.status} ${result.statusText ?? ''}`)
  } else if (result.connected !== undefined) {
    statusPart = result.connected
      ? chalk.green('  Connected')
      : chalk.red('  Failed to connect')
  }

  let sizePart = ''
  if (result.size !== undefined) {
    sizePart = chalk.gray(`  ${formatBytes(result.size)}`)
  }

  console.log(`${icon}  ${proto} ${method}${url}${statusPart}  ${time}${sizePart}`)

  if (!result.success && result.error) {
    console.log(chalk.red(`       ${result.error}`))
  }

  // ── Report entries (emitted by plugins via context.report.add()) ───────────
  if (result.reportEntries && result.reportEntries.length > 0) {
    renderReportEntries(result.reportEntries, verbose)
  }

  // ── Legacy assertion fields (kept for backwards compat) ───────────────────
  if (!result.reportEntries && (result.assertionsPassed !== undefined || result.assertionsFailed !== undefined)) {
    const p = result.assertionsPassed ?? 0
    const f = result.assertionsFailed ?? 0
    console.log(`       assertions: ${chalk.green(`${p} passed`)}${f > 0 ? chalk.red(` · ${f} failed`) : ''}`)
  }

  // ── Response body ─────────────────────────────────────────────────────────
  if (showBody && result.body) {
    console.log(chalk.gray('       ↳ response:'))
    for (const line of result.body.split('\n')) {
      console.log(chalk.gray(`         ${line}`))
    }
  }
}

function printRunSummary(
  results: Array<{ file: string; result: RunResult }>,
  totalMs: number,
): void {
  const passed = results.filter(r => r.result.success).length
  const failed = results.length - passed

  console.log()
  console.log(DIVIDER)

  const passedStr = passed > 0 ? chalk.green(`${passed} passed`) : chalk.gray('0 passed')
  const failedStr = failed > 0 ? chalk.red(`${failed} failed`) : chalk.gray('0 failed')

  console.log(
    `  ${chalk.bold('Summary')}  ` +
    `${results.length} request${results.length !== 1 ? 's' : ''}  ·  ` +
    `${passedStr}  ·  ${failedStr}  ·  ` +
    chalk.gray(formatDuration(totalMs) + ' total')
  )
  console.log(DIVIDER)
  console.log()
}

function printRunSummaryJson(
  results: Array<{ file: string; result: RunResult }>,
  totalMs: number,
  activePlugins: string[],
): void {
  const passed = results.filter(r => r.result.success).length
  const output = {
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      totalDurationMs: totalMs,
      activePlugins,
    },
    requests: results.map(r => ({ file: r.file, ...r.result })),
  }
  console.log(JSON.stringify(output, null, 2))
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

program
  .name('voiden-runner')
  .description('Run .void files headlessly — REST, WebSocket, and gRPC')
  .version('0.1.0')

// ── voiden-runner run ─────────────────────────────────────────────────────────

program
  .command('run <paths...>')
  .description(
    'Run .void files — accepts files, directories (recursive), or glob patterns\n\n' +
    '  Examples:\n' +
    '    voiden-runner run auth.void\n' +
    '    voiden-runner run ./requests/\n' +
    '    voiden-runner run auth.void users.void ./smoke/\n' +
    '    voiden-runner run ./ --env .env.staging --bail\n'
  )
  .option('-e, --env <path>', 'Path to .env or .yaml file for variable substitution')
  .option('--env-var <key=value>', 'Individual environment variable override (can be used multiple times)', (val, memo: string[]) => {
    memo.push(val)
    return memo
  }, [])
  .option('--show-body', 'Print full response body for each request')
  .option('--bail', 'Stop immediately on first failure and exit 1 (CI fast-fail)')
  .option('--stop-on-failure', 'Alias for --bail: stop on first failure, exit 1 (shell set -e friendly)')
  .option('--fail-on-error', 'Exit with code 1 if any request fails (runs all files first)')
  .option('--no-scripts', 'Disable voiden-scripting plugin entirely — prevents pre/post script execution (recommended for CI/CD)')
  .option('--no-cache-vars', 'Do not load/save runtime variables to ~/.voiden/.process.env.json')
  .option('--verbose', 'Print plugin and script logs')
  .option('--json', 'Output results as JSON (suppresses normal output — useful for CI pipelines)')
  .option('--no-session', 'Do not load/save session environment or results')
  .option('--output-json <file>', 'Write the full result object to a JSON file — pass to the next CLI, script, or tool')
  .option('--csv <path>', 'Export full report (request + response headers, bodies, assertions) to a CSV file')
  .option('--mail-to <address>', 'Send HTML report to this email address')
  .option('--mail-from <address>', 'Sender address for the report email')
  .option('--mail-subject <subject>', 'Email subject line (default: auto-generated summary)')
  .action(async (paths: string[], opts) => {
    // Priority order (lowest → highest):
    //   system env (process.env) → session env → --env file → --env-var overrides
    //
    // System env is the base so GitHub Actions secrets, GitLab CI variables,
    // and any CI/CD platform vars are automatically available as {{KEY}}
    // without needing an --env file.
    const env: Record<string, string> = Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][]
    )

    // 1. Load persisted session env first (overrides system env)
    if (!opts.noSession) {
      Object.assign(env, loadSessionEnv())
    }

    // 2. Load --env file (overrides session + system)
    if (opts.env) {
      const envPath = resolve(opts.env)
      if (!existsSync(envPath)) {
        console.error(chalk.red(`Env file not found: ${envPath}`))
        process.exit(1)
      }
      try {
        Object.assign(env, loadEnvFile(envPath))
      } catch (err: any) {
        console.error(chalk.red(`  ✗  ${err.message}`))
        process.exit(1)
      }
    }

    // 3. Individual --env-var overrides
    if (opts.envVar && Array.isArray(opts.envVar)) {
      for (const pair of opts.envVar) {
        const eq = pair.indexOf('=')
        if (eq === -1) {
          console.error(chalk.red(`  ✗  Invalid --env-var format: "${pair}" (expected key=value)`))
          process.exit(1)
        }
        const key = pair.slice(0, eq).trim()
        const val = pair.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
        if (!key) {
          console.error(chalk.red(`  ✗  Invalid --env-var format: "${pair}" (key cannot be empty)`))
          process.exit(1)
        }
        env[key] = val
      }
    }

    const resolvedFiles = await resolveFiles(paths)

    if (resolvedFiles.length === 0) {
      console.error(chalk.red('No .void files found at the given path(s)'))
      process.exit(1)
    }

    // --stop-on-failure is a CI-friendly alias for --bail
    const stopOnFailure: boolean = opts.bail || opts.stopOnFailure

    // SMTP settings — read from loaded .env file or process environment
    const smtpHost = env.VOIDEN_SMTP_HOST || process.env.VOIDEN_SMTP_HOST
    const smtpPort = parseInt(env.VOIDEN_SMTP_PORT || process.env.VOIDEN_SMTP_PORT || '0') || undefined
    const smtpSecure = (env.VOIDEN_SMTP_SECURE || process.env.VOIDEN_SMTP_SECURE) === 'true'
    const smtpUser = env.VOIDEN_SMTP_USER || process.env.VOIDEN_SMTP_USER
    const smtpPass = env.VOIDEN_SMTP_PASS || process.env.VOIDEN_SMTP_PASS

    // Validate mail options up-front so we fail fast before running requests
    if (opts.mailTo && !smtpHost) {
      console.error(chalk.red('  --mail-to requires SMTP configuration.'))
      console.log(chalk.gray('  Please set VOIDEN_SMTP_HOST in your .env file or environment.'))
      process.exit(1)
    }

    const runStart = Date.now()
    let anyFailed = false
    const allResults: Array<{ file: string; result: RunResult }> = []

    // In-memory runtime variables — shared across all files in this run.
    // Captured from {{$res.xxx}} runtime-variable blocks after each request.
    // Available as {{process.KEY}} in subsequent requests and via vd.variables.get().
    const runtimeVars: Record<string, any> = {}

    // Load persisted runtime variables if not disabled
    const VARS_PATH = join(STORE_DIR, '.process.env.json')
    if (!opts.noCacheVars && existsSync(VARS_PATH)) {
      try {
        const data = JSON.parse(readFileSync(VARS_PATH, 'utf-8'))
        Object.assign(runtimeVars, data)
        if (opts.verbose) console.log(chalk.gray(`  [vars] Loaded ${Object.keys(data).length} persisted variables from ${VARS_PATH}`))
      } catch {
        // Ignore if file is malformed
      }
    }

    // Load plugins once for the entire session — not once per file.
    const skipPlugins = opts.noScripts ? new Set(['voiden-scripting']) : new Set<string>()
    const activePlugins = await loadEnabledPlugins(opts.verbose ?? false, skipPlugins)

    // Collect results
    for (let i = 0; i < resolvedFiles.length; i++) {
      const file = resolvedFiles[i]
      const stopSpinner = opts.json ? () => {} : startSpinner(`[${i + 1}/${resolvedFiles.length}]  ${basename(file)}`)

      try {
        const { results } = await runVoidFile(file, { env, verbose: opts.verbose, skipPlugins, runtimeVars, activePlugins })
        stopSpinner()
        for (const { result } of results) {
          if (!result.success) anyFailed = true
          allResults.push({ file, result })
        }
      } catch (err: any) {
        stopSpinner()
        anyFailed = true
        allResults.push({
          file,
          result: {
            protocol: 'unknown',
            url: '',
            success: false,
            durationMs: 0,
            error: err?.message || String(err),
          },
        })
      }

      // --bail / --stop-on-failure: halt immediately, let shell set -e propagate
      if (stopOnFailure && anyFailed) {
        console.log()
        console.log(chalk.red(`  ✗  Stopped on first failure — ${resolvedFiles.length - i - 1} file(s) skipped`))
        console.log(chalk.gray('     (exit code 1 — shell set -e will abort the parent script)'))
        break
      }
    }

    // Save session results if not disabled
    if (!opts.noSession) {
      appendSessionResults(allResults)
    }

    const totalMs = Date.now() - runStart

    // Save runtime variables if not disabled
    if (!opts.noCacheVars && Object.keys(runtimeVars).length > 0) {
      try {
        mkdirSync(STORE_DIR, { recursive: true })
        writeFileSync(VARS_PATH, JSON.stringify(runtimeVars, null, 2), 'utf-8')
        if (!opts.json) console.log(chalk.gray(`  [vars] Saved ${Object.keys(runtimeVars).length} runtime variables to ${VARS_PATH}`))
      } catch (err: any) {
        if (opts.verbose) console.error(chalk.red(`  [vars] Failed to save runtime variables: ${err?.message}`))
      }
    }

    if (opts.json) {
      printRunSummaryJson(allResults, totalMs, activePlugins)
    } else {
      printRunHeader(resolvedFiles.length, activePlugins.length)
      for (let i = 0; i < allResults.length; i++) {
        const { file, result } = allResults[i]
        printRequestResult(result, file, i + 1, allResults.length, opts.showBody ?? false, opts.verbose ?? false)
      }
      printRunSummary(allResults, totalMs)
    }

    // ── CSV export ────────────────────────────────────────────────────────────
    if (opts.csv) {
      try {
        const savedTo = exportToCsv(allResults, opts.csv)
        console.log(chalk.green(`  ✓  CSV report saved to ${savedTo}`))
      } catch (err: any) {
        console.error(chalk.red(`  ✗  Failed to write CSV: ${err?.message ?? String(err)}`))
      }
    }

    // ── Email report ──────────────────────────────────────────────────────────
    if (opts.mailTo) {
      process.stdout.write(chalk.gray(`  ↑  Sending report to ${opts.mailTo} …`))
      try {
        await sendMailReport(allResults, totalMs, {
          to:          opts.mailTo,
          from:        opts.mailFrom,
          subject:     opts.mailSubject,
          smtpHost:    smtpHost!,
          smtpPort:    smtpPort,
          smtpSecure:  smtpSecure,
          smtpUser:    smtpUser,
          smtpPass:    smtpPass,
        })
        process.stdout.write('\r' + chalk.green(`  ✓  Report sent to ${opts.mailTo}`) + ' '.repeat(20) + '\n')
      } catch (err: any) {
        process.stdout.write('\r' + chalk.red(`  ✗  Failed to send email: ${err?.message ?? String(err)}`) + '\n')
      }
    }

    // ── Output JSON to file ───────────────────────────────────────────────────
    if (opts.outputJson) {
      const jsonData = {
        summary: {
          total: allResults.length,
          passed: allResults.filter(r => r.result.success).length,
          failed: allResults.filter(r => !r.result.success).length,
          totalDurationMs: Date.now() - runStart,
          activePlugins,
        },
        requests: allResults.map(r => ({ file: r.file, ...r.result })),
      }
      writeFileSync(opts.outputJson, JSON.stringify(jsonData, null, 2) + '\n', 'utf-8')
      if (!opts.json) console.log(chalk.gray(`  ↳ Results written to ${opts.outputJson}`))
    }

    const shouldFail = (opts.failOnError || stopOnFailure) && anyFailed
    if (shouldFail && !opts.json) {
      const failedCount = allResults.filter(r => !r.result.success).length
      console.log(chalk.red(`  ✗  Run failed — ${failedCount} request${failedCount !== 1 ? 's' : ''} failed. Exiting with code 1.`))
      console.log(chalk.gray('     (use this exit code in your shell script to abort on failure)'))
      console.log()
    }
    process.exit(shouldFail ? 1 : 0)
  })

// ── voiden-runner env ─────────────────────────────────────────────────────────

const envCmd = program
  .command('env')
  .description('Manage persisted environment variables for the session')

envCmd
  .command('set <kv...>')
  .description('Set one or more environment variables (KEY=VALUE)')
  .action((kvs: string[]) => {
    const env = loadSessionEnv()
    for (const kv of kvs) {
      const eq = kv.indexOf('=')
      if (eq === -1) {
        console.error(chalk.red(`  ✗  Invalid format: "${kv}" (expected KEY=VALUE)`))
        continue
      }
      const key = kv.slice(0, eq).trim()
      const val = kv.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
      if (!key) continue
      env[key] = val
      console.log(chalk.green(`  ✓  Set`) + ` ${key}=${val}`)
    }
    saveSessionEnv(env)
  })

envCmd
  .command('list')
  .description('List all persisted environment variables')
  .action(() => {
    const env = loadSessionEnv()
    const keys = Object.keys(env)
    if (keys.length === 0) {
      console.log(chalk.gray('  No persisted environment variables.'))
      return
    }
    console.log()
    for (const key of keys) {
      console.log(`  ${chalk.bold(key.padEnd(24))} ${chalk.gray(env[key])}`)
    }
    console.log()
  })

envCmd
  .command('remove <keys...>')
  .description('Remove one or more persisted environment variables')
  .action((keys: string[]) => {
    const env = loadSessionEnv()
    for (const key of keys) {
      if (env[key] !== undefined) {
        delete env[key]
        console.log(chalk.yellow(`  ·  Removed`) + ` ${key}`)
      }
    }
    saveSessionEnv(env)
  })

envCmd
  .command('clear')
  .description('Clear all persisted environment variables')
  .action(() => {
    saveSessionEnv({})
    console.log(chalk.yellow('  ✓  Cleared all persisted environment variables'))
  })

// ── voiden-runner session ─────────────────────────────────────────────────────

const sessionCmd = program
  .command('session')
  .description('Manage the current run session')

sessionCmd
  .command('clear')
  .description('Clear all session data (env, results, and runtime variables)')
  .action(() => {
    clearSession()
    console.log(chalk.yellow('  ✓  Session cleared (env, results, and runtime variables wiped)'))
  })

sessionCmd
  .command('status')
  .description('Show summary of current session')
  .action(() => {
    const env = loadSessionEnv()
    const results = loadSessionResults()
    const VARS_PATH = join(STORE_DIR, '.process.env.json')
    const varsCount = existsSync(VARS_PATH) ? Object.keys(JSON.parse(readFileSync(VARS_PATH, 'utf-8'))).length : 0

    console.log()
    console.log(chalk.bold('  Session Status'))
    console.log(DIVIDER)
    console.log(`  Environment variables:  ${Object.keys(env).length}`)
    console.log(`  Accumulated results:    ${results.length} requests`)
    console.log(`  Runtime variables:      ${varsCount}`)
    console.log(DIVIDER)
    console.log()
  })

// ── voiden-runner report ──────────────────────────────────────────────────────

program
  .command('report')
  .description('Generate reports from accumulated session results')
  .option('--csv <path>', 'Export session results to a CSV file')
  .option('--mail-to <address>', 'Send HTML report of session results to this email address')
  .option('--mail-from <address>', 'Sender address for the report email')
  .option('--mail-subject <subject>', 'Email subject line')
  .action(async (opts) => {
    const results = loadSessionResults()
    if (results.length === 0) {
      console.error(chalk.red('  ✗  No results found in session. Run some .void files first.'))
      process.exit(1)
    }

    if (!opts.csv && !opts.mailTo) {
      console.log(chalk.gray(`  Session has ${results.length} accumulated results. Specify --csv or --mail-to to generate a report.`))
      return
    }

    if (opts.csv) {
      try {
        const savedTo = exportToCsv(results, opts.csv)
        console.log(chalk.green(`  ✓  CSV report saved to ${savedTo}`))
      } catch (err: any) {
        console.error(chalk.red(`  ✗  Failed to write CSV: ${err?.message ?? String(err)}`))
      }
    }

    if (opts.mailTo) {
      const env = loadSessionEnv()
      const smtpHost = env.VOIDEN_SMTP_HOST || process.env.VOIDEN_SMTP_HOST
      const smtpPort = parseInt(env.VOIDEN_SMTP_PORT || process.env.VOIDEN_SMTP_PORT || '0') || undefined
      const smtpSecure = (env.VOIDEN_SMTP_SECURE || process.env.VOIDEN_SMTP_SECURE) === 'true'
      const smtpUser = env.VOIDEN_SMTP_USER || process.env.VOIDEN_SMTP_USER
      const smtpPass = env.VOIDEN_SMTP_PASS || process.env.VOIDEN_SMTP_PASS

      if (!smtpHost) {
        console.error(chalk.red('  ✗  SMTP configuration required for email reports.'))
        console.log(chalk.gray('     Set VOIDEN_SMTP_HOST in your session env or process environment.'))
        process.exit(1)
      }

      process.stdout.write(chalk.gray(`  ↑  Sending session report to ${opts.mailTo} …`))
      try {
        await sendMailReport(results, 0, {
          to:          opts.mailTo,
          from:        opts.mailFrom,
          subject:     opts.mailSubject || `Voiden Session Report (${results.length} requests)`,
          smtpHost:    smtpHost!,
          smtpPort:    smtpPort,
          smtpSecure:  smtpSecure,
          smtpUser:    smtpUser,
          smtpPass:    smtpPass,
        })
        process.stdout.write('\r' + chalk.green(`  ✓  Report sent to ${opts.mailTo}`) + ' '.repeat(20) + '\n')
      } catch (err: any) {
        process.stdout.write('\r' + chalk.red(`  ✗  Failed to send email: ${err?.message ?? String(err)}`) + '\n')
      }
    }
  })

// ── voiden-runner plugin ──────────────────────────────────────────────────────

const pluginCmd = program
  .command('plugin')
  .description('Manage plugins for .void file execution')

// voiden-runner plugin install [names...] --all
pluginCmd
  .command('install [names...]')
  .description(
    'Install one or more plugins, or all core plugins\n\n' +
    '  --all installs all core plugins only. Community plugins must be installed by name.\n\n' +
    '  Examples:\n' +
    '    voiden-runner plugin install --all\n' +
    '    voiden-runner plugin install voiden-scripting\n' +
    '    voiden-runner plugin install apyhub-explorer\n'
  )
  .option('--all', 'Install all core plugins (community plugins must be installed by name)')
  .action(async (names: string[], opts) => {
    const communityPlugins = await fetchCommunityPlugins()

    const targets: string[] = opts.all
      ? CORE_PLUGINS.map(p => p.name)
      : names

    if (targets.length === 0) {
      console.error(chalk.red('Specify plugin name(s) or use --all'))
      console.log(chalk.gray('  Core: ' + CORE_PLUGINS.map(p => p.name).join(', ')))
      if (communityPlugins.length > 0) {
        console.log(chalk.gray('  Community (install by name): ' + communityPlugins.map(p => p.id).join(', ')))
      }
      process.exit(1)
    }

    let installedCount = 0
    for (const name of targets) {
      const coreDef = findPlugin(name)
      const commDef = !coreDef ? findCommunityPlugin(name, communityPlugins) : undefined
      if (!coreDef && !commDef) {
        console.log(chalk.yellow(`  ⚠  Unknown plugin "${name}" — skipped`))
        continue
      }

      // Community plugins: download runner.js from the GitHub release first
      if (commDef) {
        process.stdout.write(`  ↓  Downloading runner for ${chalk.bold(name)} …`)
        try {
          const result = await installCommunityRunner(commDef)
          if (result === 'no-runner') {
            process.stdout.write('\r' + chalk.yellow(`  ⚠  No runner.js in release for "${name}" — skipped\n`))
            continue
          }
          process.stdout.write('\r' + ' '.repeat(60) + '\r') // clear the line
        } catch (err: any) {
          process.stdout.write('\r' + chalk.red(`  ✗  Failed to download runner for "${name}": ${err?.message ?? String(err)}\n`))
          continue
        }
      }

      const description = coreDef ? coreDef.description : commDef!.description
      const fresh = installPlugin(name)
      if (fresh) {
        console.log(chalk.green(`  ✓  Installed`) + chalk.bold(` ${name}`) + chalk.gray(`  —  ${description}`))
        installedCount++
      } else {
        console.log(chalk.gray(`  ·  Already installed`) + ` ${name}`)
      }
    }

    if (installedCount > 0) {
      console.log()
      console.log(chalk.gray(`  ${installedCount} plugin(s) installed. State saved to ~/.voiden/plugins.json`))
    }
  })

// voiden-runner plugin uninstall <name>
pluginCmd
  .command('uninstall <name>')
  .description('Remove an installed plugin\n\n  Example:\n    voiden-runner plugin uninstall voiden-scripting\n')
  .action((name: string) => {
    const removed = uninstallPlugin(name)
    if (removed) {
      console.log(chalk.green(`  ✓  Uninstalled`) + ` ${name}`)
    } else {
      console.log(chalk.yellow(`  ⚠  Plugin "${name}" is not installed`))
    }
  })

// voiden-runner plugin enable [name] --all
pluginCmd
  .command('enable [name]')
  .description(
    'Enable a previously disabled plugin\n\n' +
    '  Examples:\n' +
    '    voiden-runner plugin enable voiden-scripting\n' +
    '    voiden-runner plugin enable --all\n'
  )
  .option('--all', 'Enable all disabled plugins (core and community)')
  .action(async (name: string | undefined, opts: { all?: boolean }) => {
    if (opts.all) {
      const store = readStore()
      // Re-enable all explicitly disabled plugins (core + community)
      const disabled = Object.entries(store.installedPlugins)
        .filter(([, r]) => !r.enabled)
        .map(([n]) => n)
      // Also ensure all core plugins that were never in the store are treated as enabled (default)
      const disabledCoreNotInStore: string[] = []
      if (disabled.length === 0 && disabledCoreNotInStore.length === 0) {
        console.log(chalk.gray('  All plugins are already enabled.'))
        return
      }
      for (const n of disabled) {
        setPluginEnabled(n, true)
        console.log(chalk.green(`  ✓  Enabled`) + ` ${n}`)
      }
      console.log(chalk.gray(`  ${disabled.length} plugin(s) enabled.`))
      return
    }
    if (!name) {
      console.error(chalk.red('  Specify a plugin name or use --all'))
      process.exit(1)
    }
    const communityPlugins = await fetchCommunityPlugins()
    const commDef = findCommunityPlugin(name, communityPlugins)
    if (commDef && !hasCommunityRunner(name)) {
      console.log(chalk.red(`  ✗  Cannot enable "${name}" — runner not installed`))
      console.log(chalk.gray(`     Run: voiden-runner plugin install ${name}`))
      process.exit(1)
    }
    setPluginEnabled(name, true)
    console.log(chalk.green(`  ✓  Enabled`) + ` ${name}`)
  })

// voiden-runner plugin disable [name] --all
pluginCmd
  .command('disable [name]')
  .description(
    'Disable a plugin without uninstalling it\n\n' +
    '  Examples:\n' +
    '    voiden-runner plugin disable voiden-scripting\n' +
    '    voiden-runner plugin disable --all\n'
  )
  .option('--all', 'Disable all plugins (core and community)')
  .action((name: string | undefined, opts: { all?: boolean }) => {
    if (opts.all) {
      // Disable all core plugins
      for (const def of CORE_PLUGINS) {
        setPluginEnabled(def.name, false)
        console.log(chalk.yellow(`  ·  Disabled`) + ` ${def.name}`)
      }
      // Disable all installed community plugins
      const store = readStore()
      const communityNames = Object.keys(store.installedPlugins).filter(n => !findPlugin(n))
      for (const n of communityNames) {
        setPluginEnabled(n, false)
        console.log(chalk.yellow(`  ·  Disabled`) + ` ${n}`)
      }
      const total = CORE_PLUGINS.length + communityNames.length
      console.log(chalk.gray(`  ${total} plugin(s) disabled.`))
      return
    }
    if (!name) {
      console.error(chalk.red('  Specify a plugin name or use --all'))
      process.exit(1)
    }
    setPluginEnabled(name, false)
    console.log(chalk.yellow(`  ·  Disabled`) + ` ${name}`)
    if (findPlugin(name)) {
      console.log(chalk.gray(`     Core plugin disabled. Re-enable with: voiden-runner plugin enable ${name}`))
    }
  })

// voiden-runner plugin list
pluginCmd
  .command('list')
  .description('List all available and installed plugins')
  .action(async () => {
    const store = readStore()
    const communityPlugins = await fetchCommunityPlugins()

    console.log()
    console.log(chalk.bold('  Core plugins') + chalk.gray('  (@voiden/core-extensions)'))
    console.log(DIVIDER)

    for (const def of CORE_PLUGINS) {
      const record = store.installedPlugins[def.name]
      const isDisabled = record !== undefined && !record.enabled
      const statusBadge = isDisabled
        ? chalk.yellow('  · disabled')
        : chalk.green('  ✓ enabled')
      console.log(`  ${chalk.bold(def.name.padEnd(24))}${statusBadge}`)
      console.log(chalk.gray(`    ${def.description}`))
    }

    // ── Community plugins ───────────────────────────────────────────────────
    console.log()
    if (communityPlugins.length === 0) {
      console.log(chalk.bold('  Community plugins') + chalk.gray('  (could not fetch — check your connection)'))
      console.log(DIVIDER)
    } else {
      console.log(chalk.bold('  Community plugins') + chalk.gray('  (github.com/VoidenHQ/plugins)'))
      console.log(DIVIDER)
      for (const def of communityPlugins) {
        const installed = store.installedPlugins[def.id]
        let statusBadge: string
        if (!installed) {
          statusBadge = chalk.gray('  not installed')
        } else if (installed.enabled) {
          statusBadge = chalk.green('  ✓ enabled')
        } else {
          statusBadge = chalk.yellow('  · disabled')
        }
        const runnerBadge = hasCommunityRunner(def.id) ? '' : chalk.gray('  [no runner]')
        console.log(
          `  ${chalk.bold(def.id.padEnd(24))}${statusBadge}${runnerBadge}` +
          chalk.gray(`  v${def.version}`) +
          chalk.gray(`  by ${def.author}`)
        )
        console.log(chalk.gray(`    ${def.description}`))
      }
    }

    const knownIds = new Set([
      ...CORE_PLUGINS.map(p => p.name),
      ...communityPlugins.map(p => p.id),
    ])
    const extras = getAllInstalledPlugins().filter(p => !knownIds.has(p.name))
    if (extras.length > 0) {
      console.log()
      console.log(chalk.bold('  Installed (external)'))
      console.log(DIVIDER)
      for (const p of extras) {
        const badge = p.enabled ? chalk.green('  ✓ enabled') : chalk.yellow('  · disabled')
        console.log(`  ${chalk.bold(p.name.padEnd(24))}${badge}`)
      }
    }

    console.log()
  })

program.parse()
