/**
 * Bedrock Proxy — OpenAI-compatible HTTP endpoint that translates to Bedrock ConverseStream.
 *
 * Based on the AWS sample: aws-samples/sample-host-openclaw-on-amazon-bedrock-agentcore
 *
 * OpenClaw connects to this proxy as if it were an OpenAI API. The proxy
 * translates requests to Bedrock ConverseStream using the ECS task role
 * credentials (no API keys needed).
 *
 * Endpoints:
 *   POST /v1/chat/completions — OpenAI chat completions (streaming + non-streaming)
 *   GET  /v1/models           — List available models
 *   GET  /health              — Health check
 */

const http = require("http");
const {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  ConverseCommand,
} = require("@aws-sdk/client-bedrock-runtime");

const PORT = parseInt(process.env.PROXY_PORT || "18790", 10);
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const MODEL_ID = process.env.BEDROCK_MODEL_ID || "moonshotai.kimi-k2.5";

const client = new BedrockRuntimeClient({ region: AWS_REGION });

let requestCount = 0;

// ---------------------------------------------------------------------------
// Message conversion: OpenAI → Bedrock
// ---------------------------------------------------------------------------

function convertMessages(messages) {
  let systemText = "";
  const bedrockMessages = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemText += (systemText ? "\n\n" : "") + msg.content;
      continue;
    }

    if (msg.role === "user") {
      bedrockMessages.push({
        role: "user",
        content: [{ text: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) }],
      });
    } else if (msg.role === "assistant") {
      const content = [];
      if (msg.content) {
        content.push({ text: msg.content });
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let input = {};
          try { input = JSON.parse(tc.function.arguments); } catch {}
          content.push({
            toolUse: { toolUseId: tc.id, name: tc.function.name, input },
          });
        }
      }
      if (content.length > 0) {
        bedrockMessages.push({ role: "assistant", content });
      }
    } else if (msg.role === "tool") {
      bedrockMessages.push({
        role: "user",
        content: [
          {
            toolResult: {
              toolUseId: msg.tool_call_id,
              content: [{ text: msg.content || "" }],
            },
          },
        ],
      });
    }
  }

  return { bedrockMessages, systemText };
}

function convertTools(tools) {
  if (!tools || tools.length === 0) return undefined;
  return {
    tools: tools
      .filter((t) => t.type === "function" && t.function)
      .map((t) => ({
        toolSpec: {
          name: t.function.name,
          description: t.function.description || "",
          inputSchema: { json: t.function.parameters || {} },
        },
      })),
  };
}

// ---------------------------------------------------------------------------
// Bedrock streaming invocation
// ---------------------------------------------------------------------------

async function invokeBedrockStreaming(req, res, body) {
  const { messages, tools, max_tokens, temperature } = body;
  const { bedrockMessages, systemText } = convertMessages(messages);
  const toolConfig = convertTools(tools);

  const params = {
    modelId: MODEL_ID,
    messages: bedrockMessages,
    inferenceConfig: {
      maxTokens: max_tokens || 16384,
      temperature: temperature ?? 0.7,
    },
  };
  if (systemText) params.system = [{ text: systemText }];
  if (toolConfig) params.toolConfig = toolConfig;

  const chatId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  try {
    const response = await client.send(new ConverseStreamCommand(params));

    let currentToolUse = null;
    let currentToolInput = "";
    let currentToolBlockIndex = -1;
    const toolCalls = [];

    for await (const event of response.stream) {
      // Text delta
      if (event.contentBlockDelta?.delta?.text) {
        const chunk = {
          id: chatId,
          object: "chat.completion.chunk",
          created,
          model: MODEL_ID,
          choices: [{ index: 0, delta: { content: event.contentBlockDelta.delta.text }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }

      // Tool use start
      if (event.contentBlockStart?.start?.toolUse) {
        const tu = event.contentBlockStart.start.toolUse;
        currentToolUse = { id: tu.toolUseId, name: tu.name };
        currentToolInput = "";
        currentToolBlockIndex = event.contentBlockStart.contentBlockIndex ?? -1;
      }

      // Tool use input delta
      if (event.contentBlockDelta?.delta?.toolUse) {
        currentToolInput += event.contentBlockDelta.delta.toolUse.input || "";
      }

      // Content block stop — emit tool call
      if (event.contentBlockStop && currentToolUse &&
          (event.contentBlockStop.contentBlockIndex ?? -1) === currentToolBlockIndex) {
        let parsedInput = {};
        try { parsedInput = JSON.parse(currentToolInput); } catch {}
        toolCalls.push({
          id: currentToolUse.id,
          type: "function",
          function: { name: currentToolUse.name, arguments: JSON.stringify(parsedInput) },
        });
        const toolChunk = {
          id: chatId,
          object: "chat.completion.chunk",
          created,
          model: MODEL_ID,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: toolCalls.length - 1,
                id: currentToolUse.id,
                type: "function",
                function: { name: currentToolUse.name, arguments: JSON.stringify(parsedInput) },
              }],
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(toolChunk)}\n\n`);
        currentToolUse = null;
        currentToolInput = "";
        currentToolBlockIndex = -1;
      }
    }

    // Final chunk
    const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";
    res.write(`data: ${JSON.stringify({
      id: chatId, object: "chat.completion.chunk", created, model: MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    })}\n\n`);
    res.write("data: [DONE]\n\n");
  } catch (err) {
    console.error("[proxy] streaming error:", err.message);
    // If headers already sent, just close
  }
  res.end();
}

// ---------------------------------------------------------------------------
// Bedrock non-streaming invocation
// ---------------------------------------------------------------------------

async function invokeBedrock(body) {
  const { messages, tools, max_tokens, temperature } = body;
  const { bedrockMessages, systemText } = convertMessages(messages);
  const toolConfig = convertTools(tools);

  const params = {
    modelId: MODEL_ID,
    messages: bedrockMessages,
    inferenceConfig: {
      maxTokens: max_tokens || 16384,
      temperature: temperature ?? 0.7,
    },
  };
  if (systemText) params.system = [{ text: systemText }];
  if (toolConfig) params.toolConfig = toolConfig;

  const response = await client.send(new ConverseCommand(params));

  let text = "";
  const toolCallsOut = [];
  for (const block of response.output?.message?.content || []) {
    if (block.text) text += block.text;
    if (block.toolUse) {
      toolCallsOut.push({
        id: block.toolUse.toolUseId,
        type: "function",
        function: {
          name: block.toolUse.name,
          arguments: JSON.stringify(block.toolUse.input || {}),
        },
      });
    }
  }

  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: MODEL_ID,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: text || null,
        ...(toolCallsOut.length > 0 ? { tool_calls: toolCallsOut } : {}),
      },
      finish_reason: toolCallsOut.length > 0 ? "tool_calls" : "stop",
    }],
    usage: {
      prompt_tokens: response.usage?.inputTokens || 0,
      completion_tokens: response.usage?.outputTokens || 0,
      total_tokens: (response.usage?.inputTokens || 0) + (response.usage?.outputTokens || 0),
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", model: MODEL_ID, requests: requestCount }));
    return;
  }

  // List models
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: [{ id: MODEL_ID, object: "model", owned_by: "amazon-bedrock" }],
    }));
    return;
  }

  // Chat completions
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    requestCount++;
    let rawBody = "";
    for await (const chunk of req) rawBody += chunk;

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid JSON" } }));
      return;
    }

    try {
      if (body.stream) {
        await invokeBedrockStreaming(req, res, body);
      } else {
        const result = await invokeBedrock(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      }
    } catch (err) {
      console.error("[proxy] error:", err.message);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: err.message } }));
      }
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[bedrock-proxy] listening on http://127.0.0.1:${PORT} (model: ${MODEL_ID})`);
});
