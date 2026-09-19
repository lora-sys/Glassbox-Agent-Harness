# P3 Kit host review and acceptance

This record covers Lora PI Kit 0.1.1 at commit `e4352f936ad8e1a223590d9e625f8e9e8c822e8c`. It does not mark all P3 acceptance complete.

## Corrected implementation

- The previous install/update scripts only ran checks. Installation now uses Pi's public Package API, writes filtered package settings and a selected-profile bootstrap into an explicit isolated agentDir. Controlled update validates the target before activation and replaces the previous package selection.
- The profile launcher and SDK resource options disable ambient resource discovery. The test profile loads only its selected bundled Skill. Its base prompt and active Tool list are applied through public Pi APIs.
- The previous MCP adapter defaulted to local-coding because actual Pi session_start has no profileName. MCP now uses an explicit per-session factory, requires agreement between profile and registry, and rechecks a supplied host authorization callback for every call. Standalone package discovery starts no MCP process. Glassbox does not enable this standalone capability without product-authorized Tool registration.
- The policy bridge no longer uses global mutable caller/checker state. Trace hooks record measured provider usage and Tool identifiers without copying protected Tool input/results into the Kit's diagnostic buffer. Glassbox remains the canonical Trace owner.
- The previous sync-skills implementation rehashed existing local files. It now copies immutable blobs from the reviewed canonical Git commit. It rejects invalid source paths and non-regular files, replaces stale bundled files and records hashes of the copied bytes. Git attributes preserve those bytes on Windows checkouts.
- Public Pi Extension lifecycle binding and shutdown were added to the Glassbox SDK adapter. The adapter reapplies its protected Tool allowlist after startup.
- Compatibility metadata now claims Windows verification only. No Linux or macOS host result is inferred from implementation portability.

## Host evidence

- Kit `npm test`: 20 tests passed across 10 files.
- Kit `npm run build`: passed.
- Real canonical Skills synchronization: commit `54bf1404a040395a6744549f3d4723d62022fb5b`, two selected Skills, eight files.
- Actual Pi SDK test-profile installation: locked unslop Skill, local stdio MCP echo, no bash, isolated session authorization, immediate revocation, failed and successful controlled upgrades.
- `npm pack` produced the 0.1.1 tarball. An independent npm consumer installed it, passed doctor, installed its test profile and executed a deterministic provider through the real Pi SDK and real local stdio MCP. This caught and fixed a missing packaged helper file that source-directory tests had not detected.
- Consumer evidence: `kit-artifact-evidence.json` in the isolated local acceptance directory. The test used no paid model and does not claim real external provider acceptance.
- Packed Kit test/main-agent/qq-group profiles passed six Glassbox Pi SDK integration tests, including protected read denial and Ops Tools.
- Glassbox `npm run test:server`, which also includes management client tests: 791 passed, one opt-in real Herdr test skipped. The real Herdr test was separately enabled and passed earlier in this work.
- Glassbox server TypeScript check passed after Extension lifecycle changes.

The repository-wide `vp check` remains failed on formatting, initially reporting 253 files including unchanged legacy code and the independent frontend scope. No frontend reformat was performed. Generated dispatch state is now ignored as local execution state. Final formatting checks must distinguish this baseline from P3 edits.

## Remaining completion gate

The real QQ Task delegation message is still pending. QQ-driven Review/Rework/Accept and final protected-data/deduplication/restart acceptance remain open. The Kit acceptance above is one part of P3, not a replacement for that product loop.
