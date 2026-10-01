import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import type { ModelProfileStore } from "../../config/model-profiles.js";
import { ModelConfigurationError, resolveProfileCredential } from "../../model/provider.js";
import type { PiModelCatalog } from "./model-catalog.js";

/** Credential admission follows the same Pi mapping as Session construction. */
export async function hasConfiguredPiCredential(
  profiles: ModelProfileStore,
  profileId: string,
  piCatalog?: PiModelCatalog,
  signal?: AbortSignal,
): Promise<boolean> {
  const nativePi = piCatalog?.has(profileId) === true;
  const resolved = nativePi ? undefined : profiles.resolve(profileId);
  try {
    if (nativePi) return await piCatalog!.hasCredential(profileId, signal);
    const matchingId = piCatalog?.matchingProfileId(resolved!.profile);
    if (matchingId !== undefined) return await piCatalog!.hasCredential(matchingId, signal);
    return resolveProfileCredential(resolved!) !== undefined;
  } catch {
    signal?.throwIfAborted();
    // Ambiguous mappings or unreadable auth stores are not configured execution paths.
    // Their raw errors can contain provider configuration and must not enter routing evidence.
    return false;
  }
}

/** Resolve on each Session so credential or endpoint changes do not survive in a cached adapter. */
export async function configuredPiModel(
  profiles: ModelProfileStore,
  profileId: string,
  piCatalog?: PiModelCatalog,
) {
  if (!(await hasConfiguredPiCredential(profiles, profileId, piCatalog)))
    throw new ModelConfigurationError("missing_credential");
  if (piCatalog?.has(profileId)) return piCatalog.resolve(profileId);
  const resolved = profiles.resolve(profileId);
  const { profile } = resolved;
  const configuredPiModel = piCatalog?.resolveMatching(profile);
  if (configuredPiModel) return configuredPiModel;
  const apiKey = resolveProfileCredential(resolved);
  if (!apiKey) throw new ModelConfigurationError("missing_credential");
  if (
    profile.contextWindowTokens === undefined ||
    profile.maxOutputTokens === undefined ||
    profile.maxOutputTokens >= profile.contextWindowTokens
  )
    throw new Error("Configured model capacity is unknown");
  const provider = `glassbox-${profile.id}`;
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider(provider, {
    api: profile.protocol,
    baseUrl: profile.baseUrl,
    apiKey,
    models: [
      {
        id: profile.model,
        name: profile.label,
        reasoning: profile.supportsThinking === true,
        input: profile.supportsVision === true ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: profile.contextWindowTokens,
        maxTokens: profile.maxOutputTokens,
      },
    ],
  });
  const model = modelRuntime.getModel(provider, profile.model);
  if (!model) throw new Error("Configured Pi model is unavailable");
  return { model, modelRuntime };
}
