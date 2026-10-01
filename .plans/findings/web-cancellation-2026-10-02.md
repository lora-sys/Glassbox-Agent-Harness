# Public Web caller cancellation

Audit W3: the actual Web Tool accepted an AbortSignal but did not pass it to search/fetch. Cancellation could leave planning, hosted MCP, REST or browser fallback work running and then start further fallback/reranking work.

## Reproductions

Four initial isolated tests failed on the original code: pre-cancelled planning, cancellation before browser fallback, active Exa REST cancellation, and the MCP-provider signal contract. A separate valid-resolver BrowserBridge reproduction also failed because the active bound command was never cancelled. These are deterministic fixtures, not production provider calls.

## Changes

- Thread an optional caller signal through protected Web Tools, service, Jev planning/reranking, Exa REST and hosted MCP, and guarded browser fallback
- Exa/Jev fetch combines caller cancellation with the existing provider deadline. Caller cancellation throws the fixed Operation cancelled error; independent provider deadlines retain timeout status
- Hosted MCP sends the signal to connect/callTool and its actual HTTP transport, and closes its short-lived client in finally
- Browser commands invoke cancellation on their exact live execution session outside the serialized command lock, await that cancellation, then clean up the bound session. Other Run bindings remain usable
- Check cancellation before work and after asynchronous boundaries so cancelled results do not become successful Web evidence and no fallback/reranking begins afterward
- Remove cancellation listeners on settlement and preserve existing authorization, URL guards and output bounds

## Evidence and boundaries

158 focused tests across fourteen Web/Tool suites pass, including real protected-Tool and service compositions; real MCP Client/HTTP transport with a fake fetcher; real GuardedBrowserFallback/BrowserBridge with fake execution; timeout distinction; response-body cancellation; planning/reranking/DNS await boundaries; and independent browser Run isolation. Changed-file lint and types pass. Aggregate gates are still pending.

DNS resolution and browser-session acquisition have no cancellable contract in the existing ports. A late-acquired browser session is closed without navigation, with a regression proving the cleanup. DNS resolution itself cannot be interrupted here. Cancellation is checked when it completes, preventing subsequent provider/browser work; this patch does not claim to terminate an in-flight OS resolver. It also cannot guarantee cancellation behavior of an arbitrary externally supplied provider that ignores the signal. The shipped HTTP and browser paths receive cancellation, rather than merely racing an uninterruptible request. No live provider, QQ, CAPTCHA, browser account, service or production configuration was used or changed.
