# Nexus model routing

Nexus defaults to **Standard** mode. Users see one Nexus experience instead of an exact model, image-model, or MCP selector. The server classifies each request and chooses the appropriate model tier and capabilities. **Advanced** mode is opt-in and constrains routing to Auto, ChatGPT, Claude, or Gemini; the router still chooses the power level within that family.

## Request flow

1. Authenticate the user before classification.
2. Apply the existing K-12 input guardrail and PII tokenization boundary before classifier traffic.
3. Apply deterministic capability rules for image generation, PSD-data, and common instructional requests.
4. Send ambiguous requests to Amazon Nova Micro on Bedrock for a provider-neutral `intent`, `tier`, `confidence`, and reason codes.
5. Resolve an accessible, active Nexus model from the configured ordered candidates. If none is configured, use `providerMetadata.nexusRouterTier` or model-name conventions. If no tier match is available, use the closest tier in the requested family. Auto may finally use the existing client model as a safe fallback; an explicit Advanced family never silently crosses into another family.
6. Automatically select an image-capable model for image intent or attach the existing database-backed PSD-data MCP server for PSD-data intent.
7. Persist the route decision on assistant-message metadata and expose it in `X-Nexus-Routing` for evaluation.

The deterministic rules run before the model classifier because capability requirements are not discretionary. Classifier failure, timeout, malformed output, or confidence below the configured floor falls back to a conservative heuristic; ordinary requests default to Medium.

## Runtime modes

Set `NEXUS_ROUTER_MODE` in the settings table or environment:

- `active`: execute the routed model and automatic connector selection.
- `shadow` (default): classify and resolve, record `proposedModelId`, but execute the existing fallback model and connector list.
- `off`: use the legacy fallback model and manually enabled connectors.

The user-facing experience still defaults to Standard; the independent runtime default is shadow so an existing deployment cannot change live model execution without an explicit administrator promotion. Use shadow mode to compare proposed routes against production traffic before changing execution. Stored routing metadata includes the config version, experience/runtime mode, requested and selected family, intent, tier, confidence, reason codes, decision source, selected/proposed model, fallback status, and PSD-data attachment status.
An explicitly invalid runtime mode, or malformed router JSON while active, fails safely to shadow mode. A missing config is valid: the built-in specialist defaults and model metadata/name inference are used.

## Configuration

`NEXUS_ROUTER_CONFIG_V1` is a JSON setting. Candidate values are `ai_models.model_id` strings (numeric database IDs are also accepted). Candidates are tried in order and remain subject to active/Nexus-enabled status and resource-access grants.
Administrators can add or edit both router keys under **Admin → System Settings → AI Configuration**; the JSON value field expands for the router config.

```json
{
  "version": "2026-07-15.1",
  "classifier": {
    "provider": "amazon-bedrock",
    "modelId": "us.amazon.nova-micro-v1:0",
    "timeoutMs": 2500
  },
  "families": {
    "openai": {
      "light": ["gpt-5.6-luna"],
      "medium": ["gpt-5.6-terra"],
      "high": ["gpt-5.6-sol"]
    },
    "anthropic": {
      "light": ["us.anthropic.claude-haiku-4-5-20251001-v1:0"],
      "medium": ["us.anthropic.claude-sonnet-5"],
      "high": ["us.anthropic.claude-opus-4-6-v1"]
    },
    "google": {
      "light": ["gemini-3.1-flash-lite"],
      "medium": ["gemini-3.5-flash"],
      "high": ["gemini-3.1-pro-preview"]
    }
  },
  "auto": {
    "light": ["gpt-5.6-luna", "gemini-3.1-flash-lite"],
    "medium": ["gpt-5.6-terra", "us.anthropic.claude-sonnet-5"],
    "high": ["gpt-5.6-sol", "us.anthropic.claude-opus-4-6-v1"]
  },
  "specialists": {
    "imageModels": ["gemini-3.1-flash-image"],
    "instructionModels": ["gemini-3.5-flash"],
    "psdDataConnectorName": "psd-data"
  },
  "confidenceFloor": 0.55
}
```

The example IDs are illustrative and must match rows present in the deployment. Standard/Auto candidate lists are provider-neutral, so they may prefer Bedrock-native Nova or open-weight models as well as the named families. Advanced remains constrained to ChatGPT, Claude, or Gemini. For lighter administration, set `provider_metadata.nexusRouterTier` to `light`, `medium`, or `high` on model rows and leave candidate lists empty. Family is inferred where applicable from the provider/model ID. Explicit candidate arrays take priority.

For PSD-data, prefer `specialists.psdDataConnectorId` when the server UUID is stable. Otherwise the router normalizes the configured name, so `psd-data`, `PSD Data`, and `psd_data` match the same registered server. Existing connector authorization and Cognito pass-through remain enforced by the connector service.

## User experience and persistence

The user preference is stored in `nexus_user_preferences.settings` as `nexusMode` and `preferredModelFamily`. Standard is the default for users with no preference. The composer’s routing control does not remount the assistant runtime; current values are read from refs by the stable transport. In Standard, manual model/tool/MCP controls are hidden. In Advanced, the family chooser and existing optional tool controls are available.

Image routing intentionally overrides a family constraint because it requires a generation capability. PSD-data augments the selected response model with its data source, so its response model still honors the family constraint. General and instructional response models also honor Advanced family selection; Auto can use the configured instructional specialist. Specialist-only image and Deep Research models are excluded from ordinary response routing.

For follow-up image edits, the router checks the authenticated user's recent persisted assistant messages for the same conversation. This keeps elliptical requests such as “make it brighter” on the image path even when the image is not reattached, while preventing another user's conversation history from influencing routing.

## Verification and rollout

1. Register candidate models in `ai_models`, including capabilities and resource grants.
2. Confirm the ECS task role can invoke Bedrock foundation models and inference profiles (the shared ECS construct grants both).
3. Configure the router JSON and start with `shadow` if evaluating an existing deployment.
4. Inspect assistant `metadata.routing`, classifier/fallback logs, latency, cost, user retries, and route overrides.
5. Promote to `active`, keeping the legacy fallback model available.

Unit coverage lives in `lib/nexus/model-router/__tests__`. Deterministic authenticated UI and request-wire coverage for Standard/Advanced, every family, preference persistence, image intent, and PSD-data intent lives in `tests/e2e/nexus/model-router.spec.ts`; live-provider conversation coverage remains in the other Nexus specs.
