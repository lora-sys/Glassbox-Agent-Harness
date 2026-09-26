import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import type { ModelProfileStore } from "../../config/model-profiles.js";
import type { PiModelCatalog } from "./model-catalog.js";

/** Resolve on each Session so credential or endpoint changes do not survive in a cached adapter. */
export async function configuredPiModel(
  profiles: ModelProfileStore,
  profileId: string,
  piCatalog?: PiModelCatalog,
) {
  if (piCatalog?.has(profileId)) return piCatalog.resolve(profileId);
  const { profile, apiKey } = profiles.resolve(profileId);
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
    apiKey: apiKey ?? "local-no-credential",
    models: [
      {
        id: profile.model,
        name: profile.label,
        reasoning: profile.supportsThinking === true,
        input: ["text"],
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
