# Owner control command parsing

Base: 64fa57c475f5332f912a13c6e37fa4c33c47d483.

## Reproduction

The previous capability fixture combined two instructions. One supplied a numeric group target and the other supplied the enable verb and category words. Testing each instruction alone failed to bind the required policy write. The existing change-claim gate still withheld the fake success in these fixtures; that protection did not itself execute the requested change.

Model selection used one expression to recognize a request and a second expression to extract its target. The first allowed omitted 到/成/为 while the second required it. A comma after 切换 produced another empty-target path. The possessive 我的 private-channel form was also omitted.

Before the fix, six added standalone variants failed while the two existing variants passed. After the fix, the focused adapter/evidence suites passed all 226 tests, including negative, mixed-direction and explicit category cases. These are fake-runtime tests, not real QQ acceptance.

## Change

- Reuse one model prefix grammar for intent detection and extraction. Existing configured-profile matching remains exact and ambiguity is not silently resolved.
- Recognize the explicit 给 N 开启群管理能力 target form without treating an unrelated bare member number as a group.
- Bind capability policy changes before matching QQ domain-action words. Pin the group, category and direction; contradictory or refused writes are not required.
- Keep execution-time authorization, scope checks and required Tool evidence intact.

## Remaining verification

Core lint and type checks passed over 429 files. The first full run additionally exposed use of the SDK default agent directory in this environment. Re-running with a fresh disposable PI_CODING_AGENT_DIR avoids touching user state. Unix socket test listeners remain blocked by this executor and must be checked in CI. No tests were removed, skipped or weakened to accommodate that restriction.

The Owner still needs to verify the corresponding real QQ message and policy state using the candidate checkout after reviewing the PR. This slice does not diagnose an upstream model endpoint or guarantee all historical natural-language failures are fixed.
