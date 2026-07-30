# Eval stubs must preserve model transport

## Symptom

The GPT OSS 120B candidate reported `OpenClawChatError` in 95 of 150 trials,
concentrated in L1 tasks that use fixture-backed tools. The surfaced message
looked like a provider model-ID failure.

## Root cause

The L1 runner bind-mounted `eval/broker_stub.py` over
`/app/mantle_proxy.py`. Direct-Mantle candidates use that same root-owned
loopback process for model inference. The fixture stub preserved broker and
summarization routes but not `/candidate-mantle/*`, so every L1 model request
ended locally with `404 EvalUnsupportedPath`. OpenClaw translated that response
into its generic model-not-found error; no request reached Bedrock.

## Durable rule

A test double that replaces a process boundary must inventory every
responsibility of that process, not only the dependency under test. Preserve
the production model transport with an exact method/path allowlist, exact AWS
origin validation, configured-model validation, root-held authorization, and
active invocation authority. Keep model bodies out of fixture captures.

Verify this boundary at two levels:

1. A hermetic relay test sends an OpenAI-compatible request containing an
   assistant `tool_calls` entry and its matching `tool` result, then asserts
   the JSON shape is forwarded unchanged and model-supplied authorization is
   replaced.
2. A small live L1 suite exercises multiple broker routes before spending on a
   full comparison run.

The expected upstream remains the Bedrock Mantle Chat Completions endpoint,
whose documented GPT OSS model ID is `openai.gpt-oss-120b`:

- <https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions-mantle.html>
- <https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-oss-120b.html>
