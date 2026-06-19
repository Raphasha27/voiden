import { stringifyJsonSafe } from "@/core/request-engine/parseJsonSafe";

const VARIABLE_REFERENCE_REGEX = /\{\{([^}]+)\}\}/g;

type VariableValidationResult =
  | { ok: true }
  | { ok: false; unresolved: string[]; message: string };

export class UnresolvedVariablesError extends Error {
  readonly unresolved: string[];

  constructor(message: string, unresolved: string[]) {
    super(message);
    this.name = "UnresolvedVariablesError";
    this.unresolved = unresolved;
  }
}

function shouldSkipVariable(name: string): boolean {
  return (
    name.startsWith("$req.") ||
    name === "$req" ||
    name.startsWith("$res.") ||
    name === "$res" ||
    name.startsWith("$faker.") ||
    name === "$faker"
  );
}

function findUnresolvedInText(text: string): string[] {
  const blocking = new Set<string>();

  for (const match of text.matchAll(VARIABLE_REFERENCE_REGEX)) {
    const name = match[1]?.trim();
    if (name && !shouldSkipVariable(name)) {
      blocking.add(name);
    }
  }

  return [...blocking].sort((a, b) => a.localeCompare(b));
}

function formatUnresolvedVariablesError(unresolved: string[]): string {
  const envVars = unresolved.filter((name) => !name.startsWith("process."));
  const processVars = unresolved.filter((name) => name.startsWith("process."));
  const parts: string[] = [];

  if (envVars.length > 0) {
    const list = envVars.map((name) => `\`${name}\``).join(", ");
    parts.push(
      `Cannot send request: unresolved environment variable(s): ${list}. Add them to your active environment or fix the spelling.`,
    );
  }

  if (processVars.length > 0) {
    const list = processVars.map((name) => `\`${name}\``).join(", ");
    parts.push(
      `Cannot send request: unresolved runtime variable(s): ${list}. Capture them in a prior request, set them in .voiden/.process.env.json, or fix the spelling.`,
    );
  }

  return parts.join("\n");
}

function extractOutgoingRequestText(requestState: Record<string, unknown>): string[] {
  const parts: string[] = [];

  const push = (value: unknown) => {
    if (typeof value === "string" && value.length > 0) {
      parts.push(value);
    }
  };

  push(requestState.url);

  if (typeof requestState.body === "string") {
    push(requestState.body);
  } else if (requestState.body != null) {
    try {
      push(stringifyJsonSafe(requestState.body) ?? String(requestState.body));
    } catch {
      push(String(requestState.body));
    }
  }

  push(requestState.binary);

  for (const key of [
    "headers",
    "params",
    "queryParams",
    "pathParams",
    "path_params",
    "bodyParams",
    "body_params",
  ]) {
    const items = requestState[key];
    if (!Array.isArray(items)) {
      continue;
    }

    for (const item of items) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const record = item as Record<string, unknown>;
      if (record.enabled === false) {
        continue;
      }
      push(record.key);
      push(record.value);
    }
  }

  return parts;
}

export function validateOutgoingRequestState(
  requestState: Record<string, unknown>,
): VariableValidationResult {
  const unresolved = findUnresolvedInText(
    extractOutgoingRequestText(requestState).join("\n"),
  );

  if (unresolved.length === 0) {
    return { ok: true };
  }

  return {
    ok: false,
    unresolved,
    message: formatUnresolvedVariablesError(unresolved),
  };
}

export function assertNoUnresolvedVariablesInOutgoingRequest(
  requestState: Record<string, unknown>,
): void {
  const result = validateOutgoingRequestState(requestState);
  if (!result.ok) {
    throw new UnresolvedVariablesError(result.message, result.unresolved);
  }
}
