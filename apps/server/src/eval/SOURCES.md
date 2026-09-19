# Run integrity Eval source record

The local implementation adapts Sample, Target and independent Score semantics from
[UKGovernmentBEIS/inspect_ai](https://github.com/UKGovernmentBEIS/inspect_ai), pinned at
`8ebe620d74c1eb679438db1b65324e30e2306092`.

The inspected paths are `src/inspect_ai/dataset/_dataset.py`,
`src/inspect_ai/scorer/_metric.py`, `src/inspect_ai/scorer/_score.py` and
`src/inspect_ai/scorer/_target.py`. The source uses the MIT license, reproduced in
`LICENSE.InspectAI`. Copyright belongs to the UK AI Security Institute, 2024.

`packages/contracts/src/evals.ts` adapts the sample ID, input, target, score value,
explanation and metadata association. `scorers.ts` adapts independent scorer
results for one sample. Python task context, Pydantic models, framework registries,
model graders and aggregate metrics are not copied. Glassbox represents unavailable
observations as `unknown` rather than Inspect AI's NaN unscored sentinel. No runtime
imports depend on the upstream checkout or the complete Inspect AI package.

## Local behavior

`createRunEvaluator` inspects an already persisted Run without executing a model or
sending a message. Each call creates a fresh sample and immutable Eval row. The
stored expected and observed JSON preserve targets, per-check verdicts, Run and
message references, the indexed Trace cursor and scorer version. `passed` means all
checks passed. The explicit `unknown` verdict remains in each score and the overall
assessment. A failed Run can have consistent evidence; an integrity result is not
an answer-quality score or an end-to-end product acceptance result.

Checks read the pinned event prefix with a maximum of 10,000 events or 100 pages,
whichever comes first. Each page uses RunTraceStore's configured byte limit. A
larger prefix is recorded as an incomplete observation. The byte offset
is preserved from the durable index; event reading validates sequence envelopes,
not an independent byte-offset rescan. Only server lifecycle events with
`glassbox-run` provenance participate. Provider-generated objects cannot impersonate
lifecycle evidence. Eval rows contain scalar status observations and identifiers,
not prompts, answers, Tool results or arbitrary Trace payloads.

Missing Trace indexes reject evaluation without manufacturing evidence. Indexed
but missing or damaged files produce failed or unknown evidence checks. Missing,
pending, sending and unknown delivery outcomes stay unknown. Failed deliveries
fail the delivery check. An adapter-confirmed delivery is a recorded observation;
it does not independently certify a real QQ interaction.

Authorization is checked before reading Trace pages and again before persistence
and return. Domain methods enforce the caller's exact Conversation scope. Evals
remain read-only observations of execution; no fixture, model or channel status
is promoted to live acceptance. Unknown usage and timing metrics remain null.
