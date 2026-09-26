import { describe, expect, it } from "vitest";
import {
  admitDuplicateCall,
  authorizedContextCacheKey,
  classifyToolResult,
  estimateTokenMaterial,
  estimateUnicodeTokens,
  isAuthorizedContextCacheEntryValid,
  projectContextBudget,
  projectToolResultsForTurn,
} from "./index.js";

describe("P5A efficiency leaf contracts", () => {
  it("estimates Unicode text conservatively with bounded scanning", () => {
    expect(estimateUnicodeTokens("abc汉🙂")).toBe(5);
    expect(estimateTokenMaterial("漢字", "retrieval")).toMatchObject({
      tokens: 2,
      source: "unicode_conservative",
      conservative: true,
      materialKind: "retrieval",
      policyVersion: "unicode-conservative-v1",
    });
    const oversized = "a".repeat(70_000);
    expect(estimateUnicodeTokens(oversized)).toBe(70_000);
    expect(estimateUnicodeTokens("🙂".repeat(40_000))).toBeGreaterThanOrEqual(40_000);
  });

  it("keeps fixed floors and whole recent exchanges within model capacity", () => {
    const result = projectContextBudget(
      {
        estimatedMaterialTokens: 45,
        estimateSource: "unicode_conservative",
        hasLargeAuthorizedContext: false,
        requiredOutputClass: "standard",
        hasToolOrRetrieval: true,
        hasAttachmentsOrArtifacts: false,
        trustedPolicyFlags: [],
        systemTokens: 10,
        currentMessageTokens: 10,
        toolSchemaTokens: 10,
        requiredFloorTokens: 5,
        exchanges: [
          { id: "old", userTokens: 10, assistantTokens: 10 },
          { id: "new", userTokens: 10, assistantTokens: 10 },
        ],
      },
      {
        contextWindowTokens: 75,
        outputReserveTokens: 10,
        thinkingReserveTokens: 0,
        safetyMarginTokens: 5,
      },
    );
    expect(result).toEqual({
      ok: true,
      projection: {
        budgetTokens: 60,
        fixedFloorTokens: 35,
        projectedTokens: 55,
        includedExchangeIds: ["new"],
        omittedExchangeIds: ["old"],
      },
    });
  });

  it("returns typed overflow when a required floor or exchange cannot fit", () => {
    expect(
      projectContextBudget(
        {
          estimatedMaterialTokens: 40,
          estimateSource: "unicode_conservative",
          hasLargeAuthorizedContext: false,
          requiredOutputClass: "standard",
          hasToolOrRetrieval: false,
          hasAttachmentsOrArtifacts: false,
          trustedPolicyFlags: [],
          systemTokens: 20,
          currentMessageTokens: 20,
          toolSchemaTokens: 0,
          requiredFloorTokens: 0,
          exchanges: [],
        },
        {
          contextWindowTokens: 30,
          outputReserveTokens: 5,
          thinkingReserveTokens: 0,
          safetyMarginTokens: 5,
        },
      ),
    ).toEqual({
      ok: false,
      overflow: { kind: "fixed_floor_exceeds_capacity", floorTokens: 40, budgetTokens: 20 },
    });

    expect(
      projectContextBudget(
        {
          estimatedMaterialTokens: 16,
          estimateSource: "unicode_conservative",
          hasLargeAuthorizedContext: false,
          requiredOutputClass: "standard",
          hasToolOrRetrieval: false,
          hasAttachmentsOrArtifacts: false,
          trustedPolicyFlags: [],
          systemTokens: 0,
          currentMessageTokens: 0,
          toolSchemaTokens: 0,
          requiredFloorTokens: 0,
          exchanges: [{ id: "required", userTokens: 8, assistantTokens: 8, required: true }],
        },
        {
          contextWindowTokens: 15,
          outputReserveTokens: 5,
          thinkingReserveTokens: 0,
          safetyMarginTokens: 5,
        },
      ),
    ).toEqual({
      ok: false,
      overflow: {
        kind: "required_exchange_exceeds_capacity",
        exchangeId: "required",
        budgetTokens: 5,
      },
    });

    expect(
      projectContextBudget(
        {
          estimatedMaterialTokens: 16,
          estimateSource: "unicode_conservative",
          hasLargeAuthorizedContext: false,
          requiredOutputClass: "standard",
          hasToolOrRetrieval: false,
          hasAttachmentsOrArtifacts: false,
          trustedPolicyFlags: [],
          systemTokens: 0,
          currentMessageTokens: 0,
          toolSchemaTokens: 0,
          requiredFloorTokens: 0,
          exchanges: [
            { id: "required-old", userTokens: 4, assistantTokens: 4, required: true },
            { id: "optional-new", userTokens: 4, assistantTokens: 4 },
          ],
        },
        {
          contextWindowTokens: 13,
          outputReserveTokens: 5,
          thinkingReserveTokens: 0,
          safetyMarginTokens: 0,
        },
      ),
    ).toMatchObject({
      ok: true,
      projection: { includedExchangeIds: ["required-old"], omittedExchangeIds: ["optional-new"] },
    });
  });

  it("classifies result projection modes and shares one per-turn budget", () => {
    expect(
      classifyToolResult({
        callId: "c1",
        toolName: "search",
        budgetClass: "domain_read",
        resultClass: "external",
        projection: "compact",
        text: "secret raw result",
      }),
    ).toEqual({ kind: "unavailable", reason: "projection_missing" });

    const result = projectToolResultsForTurn(
      [
        {
          callId: "c1",
          toolName: "a",
          budgetClass: "core",
          resultClass: "local",
          projection: "full",
          text: "1234",
        },
        {
          callId: "c2",
          toolName: "b",
          budgetClass: "worker",
          resultClass: "external",
          projection: "compact",
          text: "not used",
          projectedText: "5678",
        },
        {
          callId: "c3",
          toolName: "metadata",
          budgetClass: "core",
          resultClass: "artifact",
          projection: "reference",
          evidenceRef: "trace:event:3",
          metadata: { status: "ok" },
        },
      ],
      6,
    );
    expect(result).toMatchObject({
      calls: [
        { callId: "c1", admitted: true, tokens: 4 },
        { callId: "c2", admitted: false, tokens: 4 },
        { callId: "c3", admitted: false },
      ],
      usedTokens: 4,
      overflowCallIds: ["c2", "c3"],
    });
    if ("calls" in result) {
      expect(result.calls[0]).toHaveProperty("projection");
      expect(result.calls[1]).not.toHaveProperty("projection");
      expect(result.calls[2]).not.toHaveProperty("projection");
    }
    const singleCallCapped = projectToolResultsForTurn(
      [
        {
          callId: "external-large",
          toolName: "search",
          budgetClass: "domain_read",
          resultClass: "external",
          projection: "full",
          text: "1234",
        },
      ],
      {
        policyVersion: "test-v1",
        perTurnTokens: 20,
        singleResultTokens: {
          external: 2,
          local: 20,
          artifact: 20,
          error: 20,
          control: 20,
          unknown: 20,
        },
      },
    );
    expect(singleCallCapped).toMatchObject({
      calls: [{ callId: "external-large", admitted: false }],
    });

    expect(
      projectToolResultsForTurn(
        [
          {
            callId: "required",
            toolName: "read",
            budgetClass: "domain_read",
            resultClass: "local",
            projection: "full",
            text: "too long",
            required: true,
          },
        ],
        2,
      ),
    ).toEqual({ overflow: { kind: "required_tool_result_exceeds_budget", callId: "required" } });
    expect(
      projectToolResultsForTurn(
        [
          {
            callId: "control",
            toolName: "control",
            budgetClass: "core",
            resultClass: "control",
            projection: "full",
            text: "too long",
          },
        ],
        2,
      ),
    ).toEqual({ overflow: { kind: "required_tool_result_exceeds_budget", callId: "control" } });
  });

  it("admits duplicate retries only after failure and keys them by authority", () => {
    const call = {
      authorityScope: "owner:private",
      resourceId: "file:x",
      toolName: "read",
      input: { id: "x" },
    };
    expect(admitDuplicateCall([], call)).toMatchObject({ admitted: true, attempt: 1 });
    expect(admitDuplicateCall([{ ...call, attempt: 1, state: "failed" }], call)).toMatchObject({
      admitted: false,
      reason: "retry_limit_reached",
    });
    expect(admitDuplicateCall([{ ...call, attempt: 1, state: "running" }], call)).toMatchObject({
      admitted: false,
      reason: "already_running",
    });
    expect(
      admitDuplicateCall([{ ...call, attempt: 1, state: "failed" }], {
        ...call,
        resourceId: "file:y",
      }),
    ).toMatchObject({ admitted: true, attempt: 1 });
    expect(
      admitDuplicateCall([{ ...call, attempt: 1, state: "failed" }], {
        ...call,
        retryAllowed: true,
      }),
    ).toMatchObject({ admitted: true, attempt: 2 });
    expect(admitDuplicateCall([{ ...call, attempt: 1, state: "succeeded" }], call)).toMatchObject({
      admitted: false,
      reason: "already_succeeded",
    });
    expect(
      admitDuplicateCall([{ ...call, attempt: 1, state: "failed" }], {
        ...call,
        authorityScope: "visitor:group",
      }),
    ).toMatchObject({ admitted: true, attempt: 1 });
  });

  it("scopes cache keys to authority and source revisions and checks expiry", () => {
    const identity = {
      agentId: "personal-agent",
      principalId: "owner",
      locationKey: "qq:private:1",
      conversationId: "conversation-1",
      resourceId: "history:1",
      authorizedResourceFingerprint: "resources-1",
      action: "history:read",
      authorizationRevision: "grant-3",
      sourceRevision: "message-8",
      retrievalPolicyVersion: "retrieval-1",
      runtimeProfileDigest: "kit-profile-1",
      behaviorVersion: "skills-1",
      projectionPolicyVersion: "projection-1",
      contextVersion: "projection-1",
    };
    const key = authorizedContextCacheKey(identity);
    const entry = {
      kind: "authorized_context_fragment" as const,
      key,
      identity,
      expiresAt: 2_000,
      value: "authorized fragment",
    };
    expect(isAuthorizedContextCacheEntryValid(entry, identity, 1_999)).toBe(true);
    expect(isAuthorizedContextCacheEntryValid(entry, identity, 2_000)).toBe(false);
    expect(
      isAuthorizedContextCacheEntryValid(
        entry,
        { ...identity, authorizationRevision: "grant-4" },
        1_000,
      ),
    ).toBe(false);
    expect(key).not.toBe(authorizedContextCacheKey({ ...identity, principalId: "visitor" }));
  });
});
