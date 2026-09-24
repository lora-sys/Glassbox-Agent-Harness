# OpenTelemetry source index

Reference projects:

~~~text
open-telemetry/semantic-conventions
open-telemetry/opentelemetry-specification
~~~

P5 review pins:

~~~text
semantic-conventions
d0472f4ae331e8ef01aa571fe024d0d6a1a9b5e1

opentelemetry-specification
148f27606cf0352c11a314e7bf9eefa6bf88db86
~~~

License: Apache-2.0.

No OpenTelemetry source is vendored by this note. P5B uses OpenTelemetry as an interoperability and naming reference after Glassbox-owned evidence exists.

## Why it matters

Glassbox P5B needs stable concepts for:

~~~text
runtime operation spans
usage / latency / throughput metrics
service/runtime resource identity
health observations
optional export to existing observability systems
~~~

OpenTelemetry should not define Glassbox Principal, Conversation, Run, Task, authorization, routing policy or Raw Trace semantics.

## Reviewed source paths

From semantic-conventions:

~~~text
docs/general/trace.md
docs/general/metrics.md
docs/gen-ai/gen-ai-spans.md
docs/gen-ai/gen-ai-metrics.md
docs/registry/attributes/gen-ai.md
~~~

The reviewed GenAI registry explicitly notes that several GenAI attributes have moved/evolved and that message/system/tool content can contain sensitive or PII data.

## Glassbox adoption rules

### Raw Trace remains canonical

~~~text
Glassbox Raw Trace / Turso
        ↓
derived runtime/routing projection
        ↓
optional OTel spans / metrics
~~~

Never reverse this ownership.

### No protected content by default

Do not export prompt bodies, model responses, Tool results, Memory, channel history or system instructions merely because an OTel GenAI attribute exists.

Use safe numeric/status/reason metadata and hashes/digests only when those digests themselves cannot leak protected information.

### Metric cardinality

Metrics should use bounded dimensions suitable for aggregation.

Do not attach Run IDs, Conversation IDs, Resource IDs or arbitrary model-generated strings as unbounded metric label dimensions.

High-cardinality correlation belongs in Trace/evidence or span linkage where appropriate, not in aggregate metric labels.

### Units

Follow OTel unit conventions when exporting. In particular, duration metrics use seconds.

Glassbox internal domain contracts may keep their existing units when explicit; the exporter owns conversion.

### Schema stability

Current GenAI conventions are not a reason to make Glassbox domain types vendor/spec-version dependent.

Keep a versioned adapter from Glassbox-owned RoutingDecision / RuntimeUsage / RuntimeHealth into the chosen OTel convention.

### Export is non-authoritative

Exporter outage, collector outage or backend retention must not change Run/Task success, authorization, delivery, or local observability truth.

## P5 boundary

P5B may add an optional sanitized exporter only after:

- routing evidence is durable locally;
- RuntimeUsage/Health contracts are proven;
- privacy tests exist;
- P3/P4 authorization/Delivery regressions pass.

P5A does not depend on OpenTelemetry.
