import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import type { ModelProfileStore } from "../../config/model-profiles.js";

/** Resolve on each Session so credential or endpoint changes do not survive in a cached adapter. */
export async function configuredPiModel(profiles: ModelProfileStore, profileId: string) {
  const { profile, apiKey } = profiles.resolve(profileId);
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
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 4096,
      },
    ],
  });
  const model = modelRuntime.getModel(provider, profile.model);
  if (!model) throw new Error("Configured Pi model is unavailable");
  return { model, modelRuntime };
}
