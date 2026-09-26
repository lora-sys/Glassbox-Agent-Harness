import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { PublicModelProfile } from "@glassbox/contracts";

const SUPPORTED_TOOL_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
]);

export type PiCatalogProfile = PublicModelProfile & { providerId: string };

/**
 * A credential-blind view of the model registry Pi actually uses for Sessions.
 * Pi remains the authority for provider auth and execution. This class exposes only
 * route identity and declared model capacity to Glassbox.
 */
export class PiModelCatalog {
  private constructor(
    private readonly runtime: ModelRuntime,
    private readonly models: readonly Model<any>[],
    private readonly customProviderIds: ReadonlySet<string>,
    private readonly customCapacity: ReadonlyMap<string, { context?: number; output?: number }>,
  ) {}

  static async open(agentDirectory = getAgentDir()): Promise<PiModelCatalog> {
    const runtime = await ModelRuntime.create({
      authPath: join(agentDirectory, "auth.json"),
      modelsPath: join(agentDirectory, "models.json"),
      modelsStorePath: join(agentDirectory, "models-store.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    await runtime.getAvailable();
    const config = await readPiModelConfig(join(agentDirectory, "models.json"));
    return new PiModelCatalog(
      runtime,
      runtime.getAvailableSnapshot(),
      config.providerIds,
      config.capacity,
    );
  }

  list(): PiCatalogProfile[] {
    return this.models
      .filter((model) => SUPPORTED_TOOL_APIS.has(model.api))
      .map((model) => {
        const capacity = this.capacity(model);
        return {
          id: piModelProfileId(model.provider, model.id),
          label: `${this.runtime.getProvider(model.provider)?.name ?? model.provider} / ${model.name}`,
          providerId: model.provider,
          protocol: model.api as PiCatalogProfile["protocol"],
          baseUrl: model.baseUrl ?? this.runtime.getProvider(model.provider)?.baseUrl ?? "",
          model: model.id,
          credentialConfigured: true,
          ...(capacity.context === undefined ? {} : { contextWindowTokens: capacity.context }),
          ...(capacity.output === undefined ? {} : { maxOutputTokens: capacity.output }),
          supportsTools: true,
          supportsThinking: model.reasoning === true,
          supportsVision: model.input.includes("image"),
          routingEnabled: false,
          allowRouting: false,
          // Missing capacity is unknown, not an operator-disabled route. Downstream capacity
          // checks still fail closed because the limits remain absent.
          ...(capacity.context !== undefined && capacity.output !== undefined
            ? { routingAvailable: true }
            : {}),
        };
      });
  }

  resolve(profileId: string): { model: Model<any>; modelRuntime: ModelRuntime } {
    const model = this.models.find(
      (candidate) => piModelProfileId(candidate.provider, candidate.id) === profileId,
    );
    if (!model) throw new Error("Pi model is unavailable or not configured");
    const capacity = this.capacity(model);
    if (capacity.context === undefined || capacity.output === undefined)
      throw new Error("Pi model capacity is unknown");
    return { model, modelRuntime: this.runtime };
  }

  has(profileId: string): boolean {
    return this.models.some(
      (candidate) => piModelProfileId(candidate.provider, candidate.id) === profileId,
    );
  }

  private capacity(model: Model<any>): { context?: number; output?: number } {
    if (this.customProviderIds.has(model.provider)) {
      const declared = this.customCapacity.get(modelKey(model.provider, model.id));
      return declared ? knownCapacity(declared.context, declared.output) : {};
    }
    return knownCapacity(model.contextWindow, model.maxTokens);
  }
}

export function piModelProfileId(providerId: string, modelId: string): string {
  return `pi-${createHash("sha256").update(modelKey(providerId, modelId)).digest("hex").slice(0, 24)}`;
}

function modelKey(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

function knownCapacity(context: unknown, output: unknown): { context?: number; output?: number } {
  const knownContext =
    Number.isSafeInteger(context) && (context as number) > 0 ? (context as number) : undefined;
  const declaredOutput =
    Number.isSafeInteger(output) && (output as number) > 0 ? (output as number) : undefined;
  const knownOutput =
    knownContext !== undefined && declaredOutput !== undefined && declaredOutput < knownContext
      ? declaredOutput
      : knownContext === undefined
        ? declaredOutput
        : undefined;
  return {
    ...(knownContext === undefined ? {} : { context: knownContext }),
    ...(knownOutput === undefined ? {} : { output: knownOutput }),
  };
}

async function readPiModelConfig(path: string): Promise<{
  providerIds: Set<string>;
  capacity: Map<string, { context?: number; output?: number }>;
}> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as {
      providers?: Record<string, { models?: Array<Record<string, unknown>> }>;
    };
    const providers = value?.providers;
    if (!providers || typeof providers !== "object" || Array.isArray(providers))
      return { providerIds: new Set(), capacity: new Map() };
    const capacity = new Map<string, { context?: number; output?: number }>();
    for (const [providerId, provider] of Object.entries(providers)) {
      for (const model of provider.models ?? []) {
        if (typeof model.id !== "string") continue;
        capacity.set(modelKey(providerId, model.id), {
          ...(typeof model.contextWindow === "number" ? { context: model.contextWindow } : {}),
          ...(typeof model.maxTokens === "number" ? { output: model.maxTokens } : {}),
        });
      }
    }
    return { providerIds: new Set(Object.keys(providers)), capacity };
  } catch {
    return { providerIds: new Set(), capacity: new Map() };
  }
}
