import { describe, it, expect, beforeEach, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { UnresolvedVariablesError } from "@/core/request-engine/utils/collectUnresolvedVariables";

const sendSecure = vi.fn().mockResolvedValue({
  status: 200,
  statusText: "OK",
  headers: [["content-type", "application/json"]],
  body: Buffer.from(JSON.stringify({ ok: true })),
  requestMeta: { url: "https://api.example.com" },
});

const mockElectron = {
  request: { sendSecure },
  variables: {
    readMerged: vi.fn().mockResolvedValue({}),
  },
  env: {
    replaceVariables: vi.fn(async (value: string) => value),
  },
  state: {
    get: vi.fn().mockResolvedValue({ activeDirectory: "" }),
  },
};

if (typeof window !== "undefined") {
  (window as any).electron = mockElectron;
}

vi.mock("@/core/request-engine/pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/request-engine/pipeline")>();
  return {
    ...actual,
    hookRegistry: {
      ...actual.hookRegistry,
      executeHooks: vi.fn().mockResolvedValue(undefined),
    },
  };
});

vi.mock("@/core/editors/voiden/utils/expandLinkedBlocks", () => ({
  expandLinkedBlocksInDoc: vi.fn(async (doc: unknown) => doc),
}));

vi.mock("@/core/request-engine/getRequestFromJson", () => ({
  getRuntimeVariablesMap: vi.fn().mockResolvedValue([]),
}));

import { sendRequestHybrid } from "@/core/request-engine/sendRequestHybrid";

const createMockEditor = () =>
  ({
    getJSON: vi.fn(() => ({ type: "doc", content: [] })),
    schema: { nodes: {}, marks: {} },
  }) as unknown as Editor;

function restRequest(overrides: Record<string, unknown> = {}) {
  return {
    protocolType: "rest",
    method: "GET",
    headers: [],
    params: [],
    path_params: [],
    auth: { enabled: false },
    ...overrides,
  };
}

describe("sendRequestHybrid unresolved variable validation", () => {
  beforeEach(() => {
    sendSecure.mockClear();
    mockElectron.variables.readMerged.mockResolvedValue({});
  });

  it("voiden test : blocks send when unresolved environment template remains in URL", async () => {
    await expect(
      sendRequestHybrid(
        restRequest({ url: "https://{{MISSING_HOST}}/health" }),
        createMockEditor(),
        undefined,
        mockElectron,
      ),
    ).rejects.toBeInstanceOf(UnresolvedVariablesError);

    expect(sendSecure).not.toHaveBeenCalled();
  });

  it("voiden test : allows send when only capture and faker templates remain", async () => {
    const response = await sendRequestHybrid(
      restRequest({
        url: "https://api.example.com/{{$req.path}}",
        headers: [{ key: "X-Fake", value: "{{$faker.name}}", enabled: true }],
      }),
      createMockEditor(),
      undefined,
      mockElectron,
    );

    expect(sendSecure).toHaveBeenCalledTimes(1);
    expect(response?.statusCode).toBe(200);
  });

  it("voiden test : does not block editor-only process refs after preSendProcessHook substitutes them", async () => {
    mockElectron.variables.readMerged.mockResolvedValue({ access_token: "secret-token" });

    const response = await sendRequestHybrid(
      restRequest({
        url: "https://api.example.com/users",
        headers: [{ key: "Authorization", value: "Bearer {{process.access_token}}", enabled: true }],
      }),
      createMockEditor(),
      undefined,
      mockElectron,
    );

    expect(sendSecure).toHaveBeenCalledTimes(1);
    expect(sendSecure.mock.calls[0][0].headers[0].value).toBe("Bearer secret-token");
    expect(response?.statusCode).toBe(200);
  });

  it("voiden test : blocks when process template survives preSendProcessHook", async () => {
    await expect(
      sendRequestHybrid(
        restRequest({
          url: "https://api.example.com",
          headers: [{ key: "Authorization", value: "Bearer {{process.missing_token}}", enabled: true }],
        }),
        createMockEditor(),
        undefined,
        mockElectron,
      ),
    ).rejects.toBeInstanceOf(UnresolvedVariablesError);

    expect(sendSecure).not.toHaveBeenCalled();
  });

  it("voiden test : validates expanded linked-block URL in built request state", async () => {
    await expect(
      sendRequestHybrid(
        restRequest({ url: "https://{{LINKED_SERVICE_HOST}}/v1/items" }),
        createMockEditor(),
        undefined,
        mockElectron,
      ),
    ).rejects.toMatchObject({
      name: "UnresolvedVariablesError",
      unresolved: ["LINKED_SERVICE_HOST"],
    });
  });
});
