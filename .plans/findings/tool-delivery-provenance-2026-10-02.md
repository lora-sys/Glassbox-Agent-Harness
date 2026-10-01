# Tool output delivery provenance

Backend audit AUTH-02, based on main `64fa57c` plus the separately reviewed command parser and dependency fix. No real QQ or production data was used.

## Reproduction

A real disposable DomainStore, real tool wrappers and real delivery lifecycle reproduced nine missing-source paths: bash, PowerShell, write/edit result details, a partial read error, streamed Shell output followed by failure, Skill content, model list and current model. A normal successful read was the control. Before the fix nine cases failed and the control passed.

## Fix

All isolated native Pi operations persist the workspace content-source decision before executing. These tools can return stdout, file differences, partial errors or synchronous streamed content even when their execution permission is workspace:write. If recording provenance fails, execution never starts. Existing workspace read/write authorization is unchanged.

Skill reads and owner model results declare the owner-controlled content source through the existing protected-tool wrapper. Model mutations also return protected profile metadata, so their result is covered too. Fixed protected-tool errors still use the existing redaction path.

This is source attribution, not delivery authorization: the Delivery Gate still independently checks the source resource's current delivery:send grant at creation and claim. The regression creates a delivery after an explicit grant, revokes it before claim, and verifies claim denial. Existing error-content preservation is retained while requiring its provenance.

## Validation and limits

Focused source and existing tool suites are run before the full commit/PR gate. No tests are skipped or removed; the existing native-error assertion now requires source attribution as the intentional contract correction. User owns real QQ acceptance. This patch does not solve category-policy revocation during in-flight delivery (AUTH-03), which remains a separate concern.
