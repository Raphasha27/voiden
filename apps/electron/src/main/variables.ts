import path from "path";
import { getActiveProject, getAppState } from "./state";
import fs from "node:fs/promises";
import { ipcMain, IpcMainInvokeEvent } from "electron";
import { windowManager } from "./windowManager";

export const GLOBAL_ENV_KEY = "__global__";

let writeQueue: Promise<void> = Promise.resolve();

function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(fn);
  writeQueue = result.then(
    () => {},
    () => {},
  );
  return result;
}
// ─────────────────────────────────────────────────────────────────────────────

async function getVariablesFilePath(): Promise<string | null> {
  const activeProject = await getActiveProject();
  if (!activeProject) return null;
  const directory = path.join(activeProject, ".voiden");
  try {
    await fs.access(directory);
  } catch {
    await fs.mkdir(directory, { recursive: true });
  }
  return path.join(directory, ".process.env.json");
}

/** Old flat format: no __global__ key AND at least one root value AND every root value is scalar.
 *  Empty objects, files already containing __global__, and files with any object-valued key
 *  are all treated as new scoped format. */
function isOldFlatFormat(raw: Record<string, any>): boolean {
  if (GLOBAL_ENV_KEY in raw) return false;
  const values = Object.values(raw);
  if (values.length === 0) return false;
  return values.every(
    (v) => typeof v !== "object" || v === null || Array.isArray(v),
  );
}

/** Always returns a deep copy so callers can mutate freely without sharing state. */
async function readScopedObject(): Promise<
  Record<string, Record<string, any>>
> {
  const filePath = await getVariablesFilePath();
  if (!filePath) return {};
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    if (isOldFlatFormat(parsed)) {
      return { [GLOBAL_ENV_KEY]: JSON.parse(JSON.stringify(parsed)) };
    }
    return JSON.parse(JSON.stringify(parsed));
  } catch (error: any) {
    if (error.code !== "ENOENT")
      console.error("Error reading variables file:", error);
    return {};
  }
}

async function writeScopedObject(
  scoped: Record<string, Record<string, any>>,
): Promise<void> {
  const filePath = await getVariablesFilePath();
  if (!filePath) return;
  console.log(
    "[writeScopedObject] Writing to file:",
    filePath,
    JSON.stringify(scoped, null, 2),
  );
  await fs.writeFile(filePath, JSON.stringify(scoped, null, 2), "utf-8");
  windowManager.browserWindow?.webContents.send("files:tree:changed", null);
}

function pruneMalformedRootKeys(
  scoped: Record<string, any>,
  targetKey: string,
  keys: string[],
): void {
  if (targetKey === GLOBAL_ENV_KEY) return;
  for (const key of keys) {
    if (key === GLOBAL_ENV_KEY || key === targetKey) continue;
    if (!(key in scoped)) continue;
    const value = scoped[key];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      delete scoped[key];
    }
  }
}

/** Gets the active env key using the correct window state from the IPC event.
 *  Always pass the IPC event so we read from the same window state that
 *  env:setActive wrote to. Falls back to GLOBAL_ENV_KEY when none is active. */
export async function getActiveEnvKey(
  event?: IpcMainInvokeEvent,
): Promise<string> {
  try {
    const state = getAppState(event);
    const dir = state.activeDirectory;
    const activeEnv = dir ? state.directories[dir]?.activeEnv : null;
    const resultKey = activeEnv || GLOBAL_ENV_KEY;
    console.log("[getActiveEnvKey]", { dir, activeEnv, resultKey });
    return resultKey;
  } catch (error) {
    console.log(
      "[getActiveEnvKey] Error, falling back to GLOBAL_ENV_KEY:",
      error,
    );
    return GLOBAL_ENV_KEY;
  }
}

/** Returns merged vars for an env: global fallback + env-specific override. */
export async function readMergedForEnv(
  envKey?: string | null,
): Promise<Record<string, any>> {
  const scoped = await readScopedObject();
  const global = scoped[GLOBAL_ENV_KEY] ?? {};
  if (!envKey || envKey === GLOBAL_ENV_KEY) return global;
  return { ...global, ...(scoped[envKey] ?? {}) };
}

/** Returns only the vars for a specific bucket (no merging with global). */
async function readBucketOnly(
  envKey?: string | null,
): Promise<Record<string, any>> {
  const scoped = await readScopedObject();
  const key = !envKey || envKey === GLOBAL_ENV_KEY ? GLOBAL_ENV_KEY : envKey;
  return scoped[key] ?? {};
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.handle("variables:getKeys", async (event, envKey?: string) => {
  const vars =
    envKey !== undefined
      ? await readBucketOnly(envKey)
      : await readMergedForEnv(await getActiveEnvKey(event));
  return Object.keys(vars);
});

ipcMain.handle("variables:read", async (event, envKey?: string) => {
  if (envKey !== undefined) return readBucketOnly(envKey);
  return readMergedForEnv(await getActiveEnvKey(event));
});

ipcMain.handle("variables:readMerged", async (event, envKey?: string) => {
  const key = envKey !== undefined ? envKey : await getActiveEnvKey(event);
  return readMergedForEnv(key);
});

ipcMain.handle("variables:get", async (event, key: string, envKey?: string) => {
  const vars = await readMergedForEnv(envKey ?? (await getActiveEnvKey(event)));
  return vars[key];
});

ipcMain.handle(
  "variables:set",
  (event, key: string, value: any, envKey?: string) =>
    enqueueWrite(async () => {
      const targetKey = envKey ?? (await getActiveEnvKey(event));
      const scoped = await readScopedObject();
      const bucket = scoped[targetKey] ?? {};
      bucket[key] = value;
      scoped[targetKey] = bucket;
      pruneMalformedRootKeys(scoped, targetKey, [key]);
      console.log(`Set variables into env "${targetKey}":`, bucket);
      await writeScopedObject(scoped);

      return true;
    }),
);

ipcMain.handle(
  "variables:writeVariables",
  (event, content: string | Record<string, any>, envKey?: string) =>
    enqueueWrite(async () => {
      const incoming: Record<string, any> =
        typeof content === "string"
          ? JSON.parse(content || "{}")
          : content ?? {};
      const targetKey = envKey ?? (await getActiveEnvKey(event));
      const scoped = await readScopedObject();
      scoped[targetKey] = incoming;
      console.log(`Set variables into env "${targetKey}":`, incoming);
      await writeScopedObject(scoped);
    }),
);

ipcMain.handle("variables:getActiveEnvKey", async (event) => {
  return getActiveEnvKey(event);
});

ipcMain.handle(
  "variables:mergeVariables",
  (event, vars: Record<string, any>, envKey?: string) =>
    enqueueWrite(async () => {
      const targetKey = envKey ?? (await getActiveEnvKey(event));
      const scoped = await readScopedObject();
      scoped[targetKey] = { ...(scoped[targetKey] ?? {}), ...vars };
      pruneMalformedRootKeys(scoped, targetKey, Object.keys(vars));
      console.log(`Merged variables into env "${targetKey}":`, vars);
      await writeScopedObject(scoped);
    }),
);

ipcMain.handle("variables:deleteKey", (event, key: string, envKey?: string) =>
  enqueueWrite(async () => {
    const targetKey = envKey ?? (await getActiveEnvKey(event));
    console.log("[variables:deleteKey]", { targetKey, key, envKey });
    const scoped = await readScopedObject();
    if (scoped[targetKey]) {
      delete scoped[targetKey][key];
      console.log(`Deleted key "${key}" from env "${targetKey}"`);
      await writeScopedObject(scoped);
    }
  }),
);

// ─── Exported helpers for main-process use ────────────────────────────────────

export async function loadVariablesForActive(): Promise<Record<string, any>> {
  return readMergedForEnv(await getActiveEnvKey());
}

export async function mergeWriteVariablesForActive(
  newVars: Record<string, any>,
): Promise<void> {
  return enqueueWrite(async () => {
    const targetKey = await getActiveEnvKey();
    console.log("[mergeWriteVariablesForActive]", { targetKey, newVars });
    const scoped = await readScopedObject();
    scoped[targetKey] = { ...(scoped[targetKey] ?? {}), ...newVars };
    await writeScopedObject(scoped);
  });
}
