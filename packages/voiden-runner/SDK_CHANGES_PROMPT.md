# SDK & Core-Extensions — Runner Support Changes

This document is a complete spec for the changes required in `@voiden/sdk` and
`@voiden/core-extensions` so that `@voiden/runner` can load plugins headlessly in
CI/CD pipelines.

---

## Background

`@voiden/runner` executes `.void` files from the CLI. It has a plugin system
(`RunnerContext`) that mirrors the app's pipeline but runs in plain Node.js —
no React, no TipTap, no Electron, no browser APIs.

Each plugin in `@voiden/core-extensions` currently has one entry point:

```
plugin.ts   ← loaded by the Voiden desktop app (Electron + React context)
```

The change required is to add a second entry point to every plugin that has
meaningful CLI behaviour:

```
runner.ts   ← loaded by voiden-runner (plain Node.js, no UI deps)
```

The runner exports a single default factory function typed as `RunnerFactory`
from `@voiden/sdk/runner`.

---

## Part 1 — `@voiden/sdk`

### New entry point: `src/runner/`

Create three files. **Zero imports from React, TipTap, Electron, or any browser API.**

#### `src/runner/types.ts`

```typescript
/**
 * Shared types for the CLI runner context.
 * Pure TypeScript — no UI or Electron dependencies.
 */

export interface Block {
  type: string
  attrs?: Record<string, any>
  content?: Block[] | string
}

/**
 * The request state that pre-request hooks can read and modify.
 */
export interface CliRequestState {
  method: string
  url: string
  headers: Array<{ key: string; value: string; enabled?: boolean }>
  queryParams: Array<{ key: string; value: string; enabled?: boolean }>
  pathParams?: Array<{ key: string; value: string; enabled?: boolean }>
  body?: string
  contentType?: string
  metadata?: Record<string, any>
}

/**
 * The response state that post-response hooks receive.
 */
export interface CliResponseState {
  protocol: string
  method?: string
  url: string
  status?: number
  statusText?: string
  durationMs: number
  size?: number
  body?: string
  error?: string
  connected?: boolean
  metadata?: Record<string, any>
}

/**
 * Block Schema definition for headless normalization.
 * Mirrors TipTap's Attribute definition.
 */
export interface BlockAttrDef {
  default?: any
}

export interface BlockSchemaDef {
  name: string
  attrs: Record<string, BlockAttrDef>
}

/**
 * Structured entries plugins emit via RunnerReportAPI.
 */
export type CliReportEntry =
  | { type: 'log';       level: 'info' | 'warn' | 'error' | 'debug'; message: string }
  | { type: 'assertion'; passed: boolean; message: string; actual?: any; expected?: any; operator?: string }
  | { type: 'section';   title: string }
```

#### `src/runner/context.ts`

```typescript
import type { 
  Block, 
  CliRequestState, 
  CliResponseState, 
  CliReportEntry, 
  BlockSchemaDef 
} from './types'

export type RunnerRequestHandler = (
  request: CliRequestState,
  blocks: Block[]
) => CliRequestState | void | Promise<CliRequestState | void>

export type RunnerResponseHandler = (
  response: CliResponseState,
  blocks: Block[],
  request: CliRequestState
) => void | Promise<void>

export interface RunnerReportAPI {
  add(entry: CliReportEntry): void
  getEntries(): CliReportEntry[]
}

/**
 * The context object passed to every runner plugin factory.
 */
export interface RunnerContext {
  // UI signal
  ui: null

  // Request/Response orchestration
  onBuildRequest(handler: RunnerRequestHandler): void
  onProcessResponse(handler: RunnerResponseHandler): void
  
  // Granular pipeline hooks (e.g. for scripting)
  pipeline: {
    registerHook(stage: string, handler: any, priority?: number): void
  }

  // Block normalization
  registerBlockSchema(def: BlockSchemaDef): void

  // Protocol executors (e.g. for sockets/grpc)
  protocols?: {
    executeWebSocket(req: any): Promise<any>
    executeGrpc(req: any): Promise<any>
  }

  report: RunnerReportAPI
  env: Record<string, string>
  verbose: boolean
}

export type RunnerFactory = (context: RunnerContext) => { onload(): void | Promise<void> }
```

#### `src/runner/index.ts`

```typescript
export type {
  Block,
  CliRequestState,
  CliResponseState,
  BlockAttrDef,
  BlockSchemaDef,
  CliReportEntry,
} from './types'

export type {
  RunnerContext,
  RunnerReportAPI,
  RunnerRequestHandler,
  RunnerResponseHandler,
  RunnerFactory,
} from './context'
```

---

## Part 2 — `@voiden/core-extensions`

For each plugin, create `runner.ts` and add exports to `package.json`.

### Plugin 1 — `voiden-scripting`

Uses granular hooks to interleave script execution with other stages.

```typescript
import type { RunnerFactory } from '@voiden/sdk/runner'
// ... (implementation uses context.pipeline.registerHook for pre-processing, pre-send, etc.)
```

### Plugin 2 — `simple-assertions`

Uses `onProcessResponse` to evaluate tests.

```typescript
import type { RunnerFactory } from '@voiden/sdk/runner'
// ...
```

### Plugin 3 — `voiden-rest-api` (Important)

Uses `registerBlockSchema` to define node defaults and `onBuildRequest` to convert blocks to a request.

```typescript
import type { RunnerFactory } from '@voiden/sdk/runner'

export default function createRestApiRunner(context: RunnerContext) {
  return {
    onload() {
      context.registerBlockSchema({
        name: 'json_body',
        attrs: {
          body: { default: '' },
          contentType: { default: 'application/json' }
        }
      })
      // ...
    }
  }
}
```

---

## Part 3 — Implementation Status

| Package | Status |
|---|---|
| `@voiden/sdk` | Types and Context defined |
| `@voiden/core-extensions` | 5 major plugins updated |
| `@voiden/runner` | Ready to transition to SDK types |
