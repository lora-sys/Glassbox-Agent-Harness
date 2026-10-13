# QQ development evidence rules

1. Live chat uses the accounts and groups authorized by the user. Existing session authorization remains valid. Skill text does not grant product permissions.
2. The generic chat entry supports ordinary natural-language messages, continuous receipt observation and Run inspection. New features do not require a scenario registry, fixed prompt or dedicated verifier.
3. A send acknowledgement is not a received reply. A successful Run is not proof of correct business behavior. Report actual messages, Run identity, execution evidence and unknown states separately.
4. Never automatically resend an unknown operation. Keep request IDs, original message records and Raw Trace. Do not rewrite historical evidence.
5. Deterministic tests use disposable state. Authorized real QQ tests use the configured persistent service. Keep credentials and private message contents out of commits and public reports.
6. Development Agents select relevant behavioral tests, restore their authorized fixture changes and follow repository commit, PR and CI requirements. The chat tool does not assert whole-product coverage or merge automatically.
7. Legacy fixed suites remain optional regression tools. Their schemas and business-specific coverage requirements do not gate the generic chat environment.
