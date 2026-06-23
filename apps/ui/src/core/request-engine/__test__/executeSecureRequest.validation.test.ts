import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  executeSecureRequest,
  UnresolvedVariablesError,
  type SecureRequestAdapter,
} from "@voiden/executors";

const mockFetch = vi.fn();

function createEnvAdapter(env: Record<string, string> = {}): SecureRequestAdapter {
  const replaceVar = async (text: string) =>
    text.replace(/\{\{([^}]+)\}\}/g, (match, name) => {
      const key = name.trim();
      if (key.startsWith("process.")) {
        return match;
      }
      return Object.prototype.hasOwnProperty.call(env, key) ? env[key] : match;
    });

  return {
    replaceVar,
    readFile: vi.fn(),
    isElectron: false,
  };
}

function createProcessAdapter(vars: Record<string, string> = {}): SecureRequestAdapter {
  const replaceVar = async (text: string) =>
    text.replace(/\{\{process\.([^}]+)\}\}/g, (match, name) => {
      const key = name.trim();
      return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match;
    });

  return { replaceVar, isElectron: false };
}

describe("executeSecureRequest unresolved variable validation", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers([["content-type", "application/json"]]),
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    vi.stubGlobal("fetch", mockFetch);
  });

  it("voiden test : allows send when env vars are substituted by replaceVar", async () => {
    await executeSecureRequest(
      {
        method: "GET",
        url: "https://{{HOST}}/health",
        headers: [],
        queryParams: [],
        pathParams: [],
      },
      createEnvAdapter({ HOST: "api.example.com" }),
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe("https://api.example.com/health");
  });

  it("voiden test : blocks when env template survives replaceVar", async () => {
    await expect(
      executeSecureRequest(
        {
          method: "GET",
          url: "https://{{MISSING_HOST}}/health",
          headers: [],
          queryParams: [],
          pathParams: [],
        },
        createEnvAdapter({}),
      ),
    ).rejects.toBeInstanceOf(UnresolvedVariablesError);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("voiden test : allows send when only capture and faker templates remain", async () => {
    await executeSecureRequest(
      {
        method: "GET",
        url: "https://api.example.com/{{$req.path}}",
        headers: [{ key: "X-Fake", value: "{{$faker.name}}", enabled: true }],
        queryParams: [],
        pathParams: [],
      },
      createEnvAdapter(),
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("voiden test : allows process variables after substitution", async () => {
    await executeSecureRequest(
      {
        method: "GET",
        url: "https://api.example.com/users",
        headers: [{ key: "Authorization", value: "Bearer {{process.access_token}}", enabled: true }],
        queryParams: [],
        pathParams: [],
      },
      createProcessAdapter({ access_token: "secret-token" }),
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("voiden test : blocks when process template survives replaceVar", async () => {
    await expect(
      executeSecureRequest(
        {
          method: "GET",
          url: "https://api.example.com",
          headers: [{ key: "Authorization", value: "Bearer {{process.missing_token}}", enabled: true }],
          queryParams: [],
          pathParams: [],
        },
        createProcessAdapter({}),
      ),
    ).rejects.toBeInstanceOf(UnresolvedVariablesError);

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
