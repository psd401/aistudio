# Assistant Architect model routing

Assistant Architect uses the same capability-aware model routing core and tier configuration as Nexus. New assistants default to **Standard**; authors can choose **Advanced** and constrain execution to ChatGPT, Claude, or Gemini while the router still selects Light, Medium, or High within that family.

Existing assistants migrate as **legacy** and keep their exact per-prompt model pins until an author explicitly converts them. This avoids changing production output during deployment.

## Execution flow

For every prompt-chain step, the runtime:

1. substitutes the assistant inputs into the authored prompt;
2. resolves repository and prompt-tool requirements;
3. classifies the request with deterministic rules followed by the configured Bedrock classifier;
4. selects an active, Architect-enabled model accessible to the executing user;
5. enforces an Advanced family constraint and explicit function-calling or vision exclusions;
6. executes the prompt and persists the routing decision in `prompt_results.input_data.modelRouting`.

Agentic assistants route once per run after their author allow-list and executing-caller scopes have resolved the actual tool set. Image inputs require a vision-capable driving model. Image generation remains the authorized `images.generate` agent tool, and MCP connectors—including PSD-data—remain limited to the assistant's saved connector allow-list. The router does not silently attach connectors or broaden permissions.

The same route adapter is used by the interactive UI, scheduled prompt chains, REST v1 execution, and MCP/job-completion execution. Agentic execution remains available only through its existing supported UI surface.

## Configuration and rollout

Migration 114 adds `model_routing_mode` (`legacy`, `standard`, or `advanced`) and `model_routing_family` (`openai`, `anthropic`, or `google`, required only for Advanced).

Tier candidates, classifier, and instructional preferences come from `NEXUS_ROUTER_CONFIG_V1`. A model may set `provider_metadata.modelRouterTier` to `light`, `medium`, or `high`; the older `nexusRouterTier` key remains supported. Explicit candidates take priority over inferred tiers.

`ASSISTANT_ARCHITECT_ROUTER_MODE` controls rollout independently:

- `active` (default): execute the routed model;
- `shadow`: persist the proposed model but execute the stored fallback;
- `off`: execute the stored fallback.

Administrators manage both Nexus and Assistant Architect rollout modes from **Admin → System Settings → Model routing**. Invalid configuration fails safely to shadow mode.

## Access and compatibility

Legacy execution checks access to pinned models. Automatic execution filters the eligible pool through the executing user's model grants and fails clearly when no compatible model is available. Advanced never crosses the selected family. Dedicated image-generation and Deep Research endpoints are excluded from text/tool-loop selection.

Unit coverage lives in `lib/ai/model-router/__tests__`, `lib/assistant-architect/__tests__`, and `lib/nexus/model-router/__tests__`. Authenticated builder compatibility coverage lives in `tests/e2e/assistant-architect-model-routing.spec.ts`.
