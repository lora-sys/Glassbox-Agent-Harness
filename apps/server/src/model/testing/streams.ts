import type { ModelProtocol } from "../provider.ts";

export function eventStream(events: unknown[], named = false): Response {
  const data = events
    .map(
      (event) =>
        `${named ? `event: ${(event as { type: string }).type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
    )
    .join("");
  // Split across arbitrary UTF-8 chunks, independently of SSE and JSON boundaries.
  const bytes = new TextEncoder().encode(data);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 17)
          controller.enqueue(bytes.slice(offset, offset + 17));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

export function textResponse(protocol: ModelProtocol, text = "Hello 群", usage = true): Response {
  if (protocol === "openai-completions")
    return eventStream([
      {
        id: "msg_1",
        choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
      },
      {
        id: "msg_1",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        ...(usage && { usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }),
      },
    ]);
  if (protocol === "openai-responses") {
    const item = {
      type: "message",
      id: "msg_1",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    return eventStream([
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          status: "completed",
          output: [item],
          ...(usage && { usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } }),
        },
      },
    ]);
  }
  return eventStream(
    [
      {
        type: "message_start",
        message: {
          id: "msg_1",
          model: "test-model",
          role: "assistant",
          content: [],
          usage: usage ? { input_tokens: 10, output_tokens: 0 } : {},
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: usage ? { output_tokens: 3 } : {},
      },
      { type: "message_stop" },
    ],
    true,
  );
}

export function toolResponse(
  protocol: ModelProtocol,
  name = "read_public",
  args = { path: "allowed.txt" },
): Response {
  const serialized = JSON.stringify(args);
  const first = serialized.slice(0, 7);
  const second = serialized.slice(7);
  if (protocol === "openai-completions")
    return eventStream([
      {
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                { index: 0, id: "call_1", type: "function", function: { name, arguments: first } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: second } }] },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);
  if (protocol === "openai-responses") {
    const item = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name,
      arguments: serialized,
      status: "completed",
    };
    return eventStream([
      { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: first },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: second },
      { type: "response.function_call_arguments.done", output_index: 0, arguments: serialized },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: { id: "resp_1", status: "completed", output: [item] },
      },
    ]);
  }
  return eventStream(
    [
      {
        type: "message_start",
        message: { id: "msg_1", model: "test-model", role: "assistant", content: [], usage: {} },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "call_1", name, input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: first },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: second },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} },
      { type: "message_stop" },
    ],
    true,
  );
}
