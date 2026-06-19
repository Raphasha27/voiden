import { describe, it, expect } from "vitest";
import {
  assertNoUnresolvedVariablesInOutgoingRequest,
  UnresolvedVariablesError,
  validateOutgoingRequestState,
} from "@/core/request-engine/utils/collectUnresolvedVariables";

describe("validateOutgoingRequestState", () => {
  it("voiden test : collects unique blocking environment and process variables", () => {
    const result = validateOutgoingRequestState({
      url: "GET {{BASE_URL}}/users/{{process.user_id}} with {{API_KEY}} and {{API_KEY}}",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unresolved).toEqual(["API_KEY", "BASE_URL", "process.user_id"]);
    }
  });

  it("voiden test : allows capture and faker templates", () => {
    const result = validateOutgoingRequestState({
      url: "{{$req.url}}",
      headers: [
        { key: "X-Prev", value: "{{$res.body}}", enabled: true },
        { key: "X-Fake", value: "{{$faker.name}}", enabled: true },
      ],
    });

    expect(result).toEqual({ ok: true });
  });

  it("voiden test : blocks unknown namespaces that look like capture variables", () => {
    const result = validateOutgoingRequestState({
      url: "https://api.example.com/{{$reqFoo}}",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unresolved).toEqual(["$reqFoo"]);
    }
  });

  it("voiden test : returns actionable error for environment variables", () => {
    const result = validateOutgoingRequestState({
      url: "https://{{BASE_URL}}/health",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unresolved).toEqual(["BASE_URL"]);
      expect(result.message).toContain("unresolved environment variable(s)");
      expect(result.message).toContain("`BASE_URL`");
    }
  });

  it("voiden test : returns actionable error for runtime variables", () => {
    const result = validateOutgoingRequestState({
      headers: [{ key: "Authorization", value: "Bearer {{process.access_token}}", enabled: true }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unresolved).toEqual(["process.access_token"]);
      expect(result.message).toContain("unresolved runtime variable(s)");
    }
  });

  it("voiden test : formats mixed environment and runtime variables", () => {
    const result = validateOutgoingRequestState({
      url: "https://{{API_KEY}}",
      headers: [{ key: "Authorization", value: "Bearer {{process.token}}", enabled: true }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe(
        "Cannot send request: unresolved environment variable(s): `API_KEY`. Add them to your active environment or fix the spelling.\nCannot send request: unresolved runtime variable(s): `process.token`. Capture them in a prior request, set them in .voiden/.process.env.json, or fix the spelling.",
      );
    }
  });

  it("voiden test : scans enabled key-value fields from request state", () => {
    const result = validateOutgoingRequestState({
      url: "https://{{HOST}}/api",
      headers: [
        { key: "Authorization", value: "Bearer {{TOKEN}}", enabled: true },
        { key: "X-Debug", value: "{{DISABLED}}", enabled: false },
      ],
      queryParams: [{ key: "q", value: "{{SEARCH}}", enabled: true }],
      body: "{\"id\":\"{{ID}}\"}",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unresolved.sort()).toEqual(["HOST", "ID", "SEARCH", "TOKEN"]);
      expect(result.unresolved).not.toContain("DISABLED");
    }
  });

  it("voiden test : validates built request payload after substitution stages", () => {
    const result = validateOutgoingRequestState({
      method: "GET",
      url: "https://api.example.com/{{MISSING}}",
      headers: [{ key: "X-Test", value: "ok", enabled: true }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unresolved).toEqual(["MISSING"]);
    }
  });

  it("voiden test : passes when outgoing payload has no blocking templates", () => {
    const result = validateOutgoingRequestState({
      method: "GET",
      url: "https://api.example.com/users",
      headers: [{ key: "Authorization", value: "{{$req.headers.Authorization}}", enabled: true }],
    });

    expect(result).toEqual({ ok: true });
  });

  it("voiden test : validates variables present in expanded linked-block URL output", () => {
    const result = validateOutgoingRequestState({
      method: "GET",
      url: "https://linked-service.example.com/{{LINKED_HOST}}/items",
      headers: [],
      queryParams: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unresolved).toEqual(["LINKED_HOST"]);
    }
  });
});

describe("assertNoUnresolvedVariablesInOutgoingRequest", () => {
  it("voiden test : throws UnresolvedVariablesError with message and unresolved list", () => {
    expect(() =>
      assertNoUnresolvedVariablesInOutgoingRequest({ url: "https://{{HOST}}" }),
    ).toThrowError(UnresolvedVariablesError);

    try {
      assertNoUnresolvedVariablesInOutgoingRequest({ url: "https://{{HOST}}" });
    } catch (error) {
      expect(error).toMatchObject({
        name: "UnresolvedVariablesError",
        unresolved: ["HOST"],
        message: expect.stringContaining("Cannot send request"),
      });
    }
  });
});
