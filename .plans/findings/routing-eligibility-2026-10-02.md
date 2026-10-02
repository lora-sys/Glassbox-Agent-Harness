# Routing eligibility audit repair

Scope: R1 and R2 from the backend audit. This does not implement Issue #121's proposed automatic fallback from an explicit model override.

## Reproduced behavior

The real ManagementApplication execution wrapper selected a higher-priority text-only profile for loaded image input. Both the model and Pi adapters returned a successful local explanation without calling a provider, and the wrapper treated that as healthy runtime evidence.

The wrapper also treated every saved profile as configured. Removing a remote profile's key did not remove its routing eligibility. The same profile won later Runs instead of an allowed profile with credentials. Pi's separate credential store and no-auth loopback endpoints cannot be reduced to the Glassbox public credentialConfigured flag.

Disposable real-wrapper fixtures reproduced 13 failing cases before the implementation. Provider fetches and Pi execution are fakes. All credentials are fixture strings.

## Changed contract

- Loaded images add a vision requirement for model, Pi and Pi task-step model execution. Text requests retain their configured ordering.
- Candidate admission checks the credential path actually used by that execution kind on each Run. The model and Pi adapters share the loopback no-auth rule. Pi's native and matching catalog models retain Pi-owned credentials. Pinned Pi 0.85.1 built-in and JSON-provider checks use local stored/environment/file state without refreshing OAuth or probing model providers. Arbitrary extension-supplied auth hooks are not covered by that guarantee.
- Only the origin and explicitly opted-in candidates are inspected. An explicit override stays pinned; an ineligible selected model fails locally rather than silently selecting a different model.
- Credential deletion and restoration affect the next routing decision. The executor checks again at Session/model construction so removal after admission also fails locally.
- Missing input capability and missing credentials have fixed failure codes and user-facing explanations. A local image refusal is failed work, not successful model execution. A local image-load explanation can remain a successful reply while explicitly recording runtimeAttempted=false.
- Runtime health evidence includes a measurement kind. not_attempted, policy_result and unknown observations do not replace the recent provider-runtime measurement used by routing. Unknown executor exceptions cannot prove degraded or unavailable provider health. Local refusals report no actual execution reference in routing evaluation evidence.

Existing assertion changes reflect this explicit contract change. No test cases were removed or disabled, and no production credentials or live QQ, model, search, browser or service endpoints were used.

## Automated coverage

Real-wrapper fixtures cover model and Pi image/text selection, loopback IPv4/IPv6/localhost without keys, remote key deletion/restoration, native and matching Pi credentials, explicit overrides, no eligible candidate, disabled routing, a key removed after admission, local image replies, policy results, unclassified exceptions, and task-step image requirements. Existing adapter, catalog, health, routing, provider and RunService tests remain required.

## Owner acceptance

After review, verify in private QQ that an image uses an allowed vision profile, text keeps the configured order, and a pinned text-only model reports its capability limit without switching. Remove and restore a disposable remote profile credential and inspect routing candidate reasons. Verify a Pi-owned credential and a no-auth loopback profile still run. Confirm local refusals do not appear as provider health measurements. No live acceptance, merge, service switch or deployment was performed for this repair.

## Review bounds

ModelProfileStore.resolve throws only a fixed, secret-free "Model profile not found" error. The current store and management API support saving profiles and removing keys, but not deleting or reloading a live profile. No supported concurrent profile-removal reproduction was found, so this repair does not add a speculative broad catch for that path.

Pi's checkAuth can call provider-supplied API-key check/resolve hooks. The pinned built-in resolvers and JSON composer were inspected. Stored OAuth is recognized without refresh, configured command-valued keys are recognized without executing commands, and built-in fallback resolvers read stored/environment/file state. Pi extensions can register arbitrary native-provider auth hooks into the shared runtime; no universal side-effect guarantee is claimed for those hooks. All tests remain isolated with fake provider execution.
