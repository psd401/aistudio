---
name: psd-classified-evaluation
summary: Guide a supervisor through a PSD Classified Performance Evaluation conversationally — ask the rating questions, confirm, submit, and hand back a Documenso signing link. No form UI.
description: Conduct a PSD Classified Performance Evaluation for a supervisor by chat. Use when a supervisor wants to evaluate one of their classified staff — the skill fetches the rubric, lists the supervisor's employees, walks the 7 rating categories, confirms a summary, submits the evaluation, and returns a Documenso link for the supervisor to sign. Nothing becomes a record until the supervisor personally signs.
allowed-tools: Bash(node:*)
---

# psd-classified-evaluation

Conduct a **PSD Classified Performance Evaluation** with a supervisor entirely
in chat. This skill talks to the **PSD Agent Gateway** (an n8n MCP Server
Trigger) which runs the real pipeline server-side: validate → branded PDF →
Documenso envelope → distribute. This skill is the AI Studio / OpenClaw side —
it never builds the PDF or touches Documenso directly.

**The gateway is the source of truth.** It re-derives every person from the
Employee Directory (names you supply are never trusted), verifies the
supervisor→employee relationship, validates the rating values, and creates
**no record** until the supervisor personally signs the Documenso envelope.
Your job is to have a clear conversation and forward clean inputs.

## The conversation flow

Do these in order. Each command opens its own short-lived connection to the
gateway — you call the skill once per step.

### 1. Find out who is being evaluated

Run `list-employees` with the **signed-in supervisor's email** (verbatim from
the `[caller: Name <email>]` header — never a name you typed):

```bash
node /opt/psd-skills/psd-classified-evaluation/run.js list-employees --user <caller-email>
```

It returns the evaluator's identity, their supervised employees, and the
current evaluation year. Present the employee list and ask which one to
evaluate. If the person they name isn't on the list, say so and show the valid
list — do not proceed.

### 2. Load the rubric and walk the 7 categories

Fetch the schema once:

```bash
node /opt/psd-skills/psd-classified-evaluation/run.js schema
```

It returns the 7 rating categories (each with its `rating_*` key and rubric
text), the rating scale, and a recommended flow. Walk the categories **one at a
time**: quote each category's rubric, then ask the supervisor to choose a
rating. The only valid ratings are, worst to best:

> **Requires Improvement · Fair · Satisfactory · Good · Outstanding**

Collect an optional overall `supervisor_comments` at the end. Do not invent
categories or ratings — use exactly the `rating_*` keys the schema returns.

### 3. Confirm a full summary

Show a table: each category, its chosen rating, and the comments. Get an
**explicit yes** before submitting. This is the last checkpoint before an
envelope is created.

### 4. Submit and hand back the signing link

Write the payload to a file (comments may contain apostrophes/newlines, and the
`--command`-style tokenizer has no escape syntax — always use `--json-file` for
anything with prose):

```bash
cat > /tmp/eval-payload.json <<'PAYLOAD'
{
  "employee_email": "employee@psd401.net",
  "rating_<category1>": "Good",
  "rating_<category2>": "Outstanding",
  "...": "... all 7 categories ...",
  "supervisor_comments": "Optional overall note."
}
PAYLOAD

node /opt/psd-skills/psd-classified-evaluation/run.js submit \
  --user <caller-email> --json-file /tmp/eval-payload.json
```

`evaluator_email` is **bound from `--user`** by the skill — you never put the
supervisor's own email in the payload, and any `evaluator_email` you do put
there is ignored. On success the tool returns:

```json
{ "success": true, "envelopeId": "…", "title": "…", "supervisorSigningUrl": "https://…" }
```

Give the supervisor the `supervisorSigningUrl` on a line by itself and tell
them: **"Review and sign here — your employee is emailed automatically after
you sign."** Nothing is final until they sign.

On a validation failure the tool returns `{ "success": false, "error": "…" }`
with an actionable message (e.g. the valid employee list on a mismatch). Relay
the `error` and correct the input — do not retry blindly.

## Rules

1. **Always pass `--user`** verbatim from the caller header — it is the
   supervisor's verified identity and the only thing that binds the evaluation
   to them.
2. **Never trust names/emails you typed** for who supervises whom — the gateway
   re-derives people. Present what the gateway returns; don't assert
   relationships it hasn't confirmed.
3. **Only the five rating values** above are valid. If the supervisor is vague,
   ask them to pick one exactly.
4. **Confirm before `submit`.** A submit creates a Documenso envelope.
5. **Put prose (comments) in a `--json-file`,** never inline JSON.
6. **The signing step is the identity safeguard** — the supervisor signs as
   themselves; the record only exists after they sign.

## Output contract

- **exit 0** — stdout is the tool's JSON payload (schema / employee list /
  submit result). Read it and continue the conversation.
- **exit 2 (`bad-args`)** — you called the skill wrong (missing `--user`, bad
  payload, invalid rating). Fix the invocation.
- **exit 11 (`not-configured`)** — the gateway endpoint/token isn't set up in
  this environment yet (the `psd-agent/{env}/agent-gateway` config secret is
  missing or incomplete). Tell the user the classified-evaluation gateway isn't
  configured here and to contact IT. Do not retry.
- **exit 12 (`transport-error`)** — the gateway couldn't be reached or didn't
  answer. Tell the user it's temporarily unavailable; they can try again.
- **exit 13 (`gateway-error`)** — the gateway returned an error. Surface the
  `message`/`data` and correct the input if it's actionable.

## Adding more forms later

The gateway will host more form families (transfers, timesheets) as namespaced
tools. The transport (`gateway.js`) is form-agnostic — a new form is a new
`run.js` subcommand that calls its gateway tool, not a rewrite. Keep new
subcommands in the same shape: bind identity from `--user`, validate enums
client-side, forward the rest, and let the gateway do authoritative validation.
