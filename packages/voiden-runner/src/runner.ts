/**
 * voiden-runner — core runner
 *
 * Flow for each section in a .void file:
 *   1. loadEnabledPlugins() — derives the list from @voiden/core-extensions registry
 *      a. Parser plugins (graphql, sockets, rest-api) load their runner.ts and
 *         call context.onBuildRequest() to register block→request builders with
 *         the shared RequestOrchestrator from @voiden/executors
 *      b. Hook plugins (scripting, faker, auth, assertions) load their plugin.ts and
 *         call context.pipeline.registerHook() to wire into the shared pipeline
 *   2. For each section:
 *      a. normalizeBlocks() fills in default attr values from registered schemas
 *      b. Build a headless editor shim ({ getJSON() }) that returns the blocks
 *      c. requestOrchestrator.executeRequest(editor, cliElectron) runs the full
 *         chain — identical to how the Electron app uses requestOrchestrator
 *   3. Map PipelineResponse → RunResult
 */

import { readFileSync } from 'fs'
import { parseVoidFileSections } from './parser.js'
import { requestOrchestrator } from '@voiden/executors'
import type { PipelineResponse } from '@voiden/executors'
import { createCliElectron } from './cliElectron.js'
import { loadEnabledPlugins } from './plugins/loader.js'
import { normalizeBlocks } from './blockSchemaRegistry.js'
import { extractRuntimeVarRows, captureRuntimeVars } from './runtimeVars.js'
import type { RunResult } from './types.js'

// ─── Block → document JSON (headless editor shim) ─────────────────────────────
//
// Converts the flat array of blocks for a section into a TipTap-like JSON
// document so that pipeline hooks (e.g. voiden-scripting's preProcessingHook)
// can call editor.getJSON() and find script blocks by traversing .content.

function blocksToDoc(blocks: any[]): any {
  return { type: 'doc', content: blocks }
}

// ─── PipelineResponse → RunResult ────────────────────────────────────────────

function toRunResult(response: PipelineResponse, url: string, startMs: number): RunResult {
  const durationMs = response.elapsedTime ?? (Date.now() - startMs)

  let body: string | undefined
  if (response.body) {
    body = typeof response.body === 'string'
      ? response.body
      : JSON.stringify(response.body)
  }

  // Flatten header arrays → plain objects for CSV / mail report consumers
  const requestHeaders: Record<string, string> | undefined =
    response.requestHeaders?.length
      ? Object.fromEntries(response.requestHeaders.map(h => [h.key, h.value]))
      : response.requestMeta?.headers?.length
        ? Object.fromEntries((response.requestMeta.headers as { key: string; value: string }[]).map(h => [h.key, h.value]))
        : undefined

  const responseHeaders: Record<string, string> | undefined =
    response.headers?.length
      ? Object.fromEntries(response.headers.map(h => [h.key, h.value]))
      : undefined

  const result: RunResult = {
    protocol:       response.protocol  ?? 'rest',
    method:         response.requestMeta?.method,
    url:            response.requestMeta?.url ?? response.url ?? url,
    success:        !response.error && response.statusCode > 0,
    status:         response.statusCode || undefined,
    statusText:     response.statusMessage || undefined,
    durationMs,
    size:           response.bytesContent || undefined,
    body,
    error:          response.error,
    requestHeaders,
    requestBody:    response.requestBody,
    responseHeaders,
  }

  if (response.metadata?.reportEntries) {
    result.reportEntries = response.metadata.reportEntries
  }

  return result
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface RunOptions {
  env?:         Record<string, string>
  verbose?:     boolean
  skipPlugins?: ReadonlySet<string>
  /** Shared in-memory runtime variables map ({{process.xxx}}). Mutated in place after each section. */
  runtimeVars?: Record<string, any>
}

export interface SectionResult {
  label?: string
  result: RunResult
}

export interface RunFileResult {
  results:       SectionResult[]
  activePlugins: string[]
}

export async function runVoidFile(
  filePath: string,
  options: RunOptions = {},
): Promise<RunFileResult> {
  const env         = options.env ?? {}
  const verbose     = options.verbose ?? false
  const skipPlugins = options.skipPlugins ?? new Set<string>()
  const runtimeVars = options.runtimeVars ?? {}

  // Load plugins FIRST — mirrors the electron app where plugins are loaded at
  // startup before any document is opened.  This ensures:
  //   • Parser plugins have registered their onBuildRequest() before we parse blocks
  //   • Hook plugins have wired into the pipeline before executeRequestPipeline runs
  //   • Disabled plugins are skipped → their request types fail gracefully
  const activePlugins = await loadEnabledPlugins(verbose, skipPlugins)

  const content  = readFileSync(filePath, 'utf-8')
  const sections = parseVoidFileSections(content)

  if (sections.length === 0) {
    return {
      results: [{
        result: {
          protocol:  'unknown',
          url:       '',
          success:   false,
          durationMs: 0,
          error:     `No void blocks found in ${filePath}`,
        },
      }],
      activePlugins,
    }
  }

  // CLI IPC adapter — pass runtimeVars so preSendProcess can substitute {{process.xxx}}
  const ipcAdapter = createCliElectron(env, runtimeVars)

  const results: SectionResult[] = []

  for (const section of sections) {
    const { blocks } = section
    const startMs    = Date.now()

    // 1. Normalise blocks against registered schemas (headless equivalent of
    //    TipTap schema normalisation — fills missing attrs with declared defaults).
    const normalizedBlocks = normalizeBlocks(blocks)

    // 2. Headless editor shim so parser plugins and pipeline hooks can call
    //    editor.getJSON() and traverse the document like the Electron app does.
    const doc    = blocksToDoc(normalizedBlocks)
    const editor = { getJSON: () => doc }

    // 3. Inject CLI env + runtime vars so scripting hooks can access them via
    //    editor.__cliEnv  (→ vd.env.get)
    //    editor.__cliVars (→ vd.variables.get/set — mutating this mutates runtimeVars)
    ;(editor as any).__cliEnv  = env
    ;(editor as any).__cliVars = runtimeVars   // shared reference — mutations propagate

    // 4. Run the full pipeline via the shared orchestrator.
    //    If no parser plugin registered an onBuildRequest handler for this block
    //    type (e.g. the plugin is disabled), the orchestrator throws and we
    //    record the error — identical behaviour to the Electron app.
    let response: PipelineResponse
    try {
      response = await requestOrchestrator.executeRequest(editor, ipcAdapter)
    } catch (err: any) {
      results.push({
        label: section.label,
        result: {
          protocol:  'unknown',
          url:       '',
          success:   false,
          durationMs: Date.now() - startMs,
          error:     err?.message ?? String(err),
        },
      })
      continue
    }

    const runResult = toRunResult(response, response.url ?? '', startMs)
    results.push({ label: section.label, result: runResult })

    // 5. Capture runtime variables from this section's blocks.
    //    Extracts {{$res.body.xxx}} / {{$req.headers.xxx}} expressions from
    //    runtime-variables blocks and writes the captured values into runtimeVars.
    //    These are immediately available to the next section via {{process.xxx}}.
    const captureRows = extractRuntimeVarRows(normalizedBlocks)
    if (captureRows.length > 0) {
      captureRuntimeVars(captureRows, runResult, runResult, runtimeVars)
    }
  }

  return { results, activePlugins }
}
