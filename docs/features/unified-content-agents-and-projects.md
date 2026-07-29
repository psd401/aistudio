# Unified Content: Agents, Skills, and Nexus Projects

Issue [#1266](https://github.com/psd401/aistudio/issues/1266), part of Epic
[#1261](https://github.com/psd401/aistudio/issues/1261). This workstream exposes
the unified repository platform to OpenClaw, published skills, and durable Nexus
Projects without creating another content or authorization model.

## Repository catalog contract

Five read-only operations share one implementation across MCP, internal tool
dispatch, REST, and the OpenClaw `psd-aistudio` skill:

| Operation | API-key scope | Purpose |
|---|---|---|
| `repositories_list` | `repositories:list` | Discover active durable repositories |
| `repositories_describe` | `repositories:list` | Inspect one accessible repository |
| `repositories_search` | `repositories:search` | Run retrieval v2 |
| `repositories_get_source` | `repositories:read` | Read exact current source segments |
| `repositories_list_changes` | `repositories:changes` | Poll changed items with an opaque cursor |

The REST paths are documented in
[`docs/API/v1/context-graph.md`](../API/v1/context-graph.md). Scope checks and
repository authorization are separate: a key or OAuth grant authorizes an
operation, while current repository/role/user ACLs authorize each resource.
Search reuses retrieval v2. Exact-source disclosure independently requires the
repository's active generation, the item's current immutable version, a live
repository ACL, and a live segment ACL in one SQL statement. The change feed
orders by `(updatedAt,itemId)` and reapplies live ACLs on every page.

System-managed, ephemeral, expired, and inactive repositories never enter this
catalog. Direct reads mask inaccessible ids as not found.

## OpenClaw delegated authorization

The first-party `PSD OpenClaw` OAuth client is a public/native client: it has no
client secret, requires authorization code plus S256 PKCE, and permits only the
registered localhost/dev/production callbacks. Its exact grant is:

```text
openid profile email offline_access platform:read
repositories:list repositories:read repositories:search repositories:changes
```

The user asks OpenClaw to connect AI Studio. The model-facing skill calls the
local owner-bound broker with `kind: aistudio`; it never supplies an owner
selector or receives signing material. The router adds a replay-bound signed
invocation proof, and AI Studio derives the immutable owner from that proof.
AI Studio persists a one-hour, one-time nonce and the PKCE verifier, then
returns a signed URL. Both the consent page and callback require a live AI
Studio session for that same owner. The callback exchanges the code, calls
OIDC userinfo, and requires the provider identity to equal the nonce owner
before storing anything. A successful callback stores the
access/rotating-refresh bundle in:

```text
psd-agent-creds/{environment}/user/{email}/aistudio_oauth
```

The nonce is consumed only after storage succeeds. The trusted AI Studio broker
prefers a current OAuth access token, refreshes before expiry, and persists a
rotated refresh token before use. Provider tokens and API keys never enter the
model runtime. During rollout the broker may fall back to the existing per-user
`aistudio_personal_key`, then to the shared discovery-only key. Repository
commands that lack the new scopes tell the user to run `connect`.

`disconnect` uses the same owner-bound broker and is forbidden for scheduled
invocations. The server revokes the refresh token first and deletes the secret
only after successful revocation. A missing secret is an idempotent success; a
provider revocation failure preserves the credential so the operation can be
retried.

## Published-skill repository bindings

Assistant Architect prompt repository ids are normalized and re-authorized at
publish time. Draft registration replaces `skill_repository_bindings` in the
same transaction as the skill row and audit event, so a failed republish cannot
leave mismatched instructions and repositories.

Approved Nexus skill sessions load repository bindings on every turn. The
server supplies a bounded `searchSkillRepositories` tool; retrieval rechecks the
executing user's current ACL and active generation. Changing repository
content, revoking access, or republishing the skill takes effect without
rebuilding the exported skill or restarting a chat. A skill binding never lends
the publisher's access to another user.

## Nexus Projects

`/nexus/projects` creates durable project workspaces with:

- project name and persistent instructions;
- a dedicated private durable repository owned by the project owner;
- explicit owner/editor/viewer membership;
- optional links to other repositories;
- user-owned project conversations.

Adding a member creates a distinct `repository_access` row for the private
project repository and stores that exact grant id with the membership. Removing
the member deletes only that grant, preserving any independent/manual access the
user already held. Only owners manage membership; owners and editors edit
context and repository links; viewers read and chat.

Linking a repository does not widen access. The editor connecting it must have
current access, each member sees only connected repositories they can currently
access, and every chat turn filters links through the executing member's live
ACL. Project membership is rechecked on every turn. Project conversations remain
owned by the person who created them and must match the server-bound project id.
Image-generation and deep-research models reject project context because they
cannot honor the required repository tool contract.

## Migration and rollout

Migration `139-unified-content-agents-projects.sql` is additive:

- widens consent nonces with `aistudio`;
- registers the first-party public PKCE client;
- creates skill repository bindings and Nexus Project tables;
- adds nullable `nexus_conversations.project_id`.

Deploy the migration before the application and agent image. Existing
conversations remain valid with a null project id, and existing OpenClaw
personal/shared credentials continue to work during OAuth rollout. Rollback can
remove the OAuth client and new tables/column; it does not rewrite canonical
repository content.

Operational logs contain request/user/resource counts but never source text,
authorization codes, refresh tokens, signed consent tokens, or PKCE verifiers.
The relevant local gates are the real PostgreSQL agents/projects smoke, focused
OAuth/catalog/project unit tests, OpenClaw skill tests, authenticated Nexus
Projects Playwright flow, full application regression, production build, and
CDK synthesis.
