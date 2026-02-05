# MCP Integration Guide

Connect external AI tools to AI Studio using the Model Context Protocol (MCP) server.

## Prerequisites

- An AI Studio account with **staff** or **administrator** role
- An API key (generated in Settings > API Keys) or OAuth client credentials

## Getting an API Key

1. Log in to AI Studio
2. Navigate to **Settings** (gear icon in sidebar)
3. Select the **API Keys** tab
4. Click **Create New Key**
5. Name the key (e.g., "Claude Code MCP")
6. Select the MCP scopes you need:
   - `mcp:search_decisions` — Search decision graph
   - `mcp:list_assistants` — List available assistants
   - `mcp:get_decision_graph` — View decision details
   - `mcp:capture_decision` — Create decisions (administrator only)
   - `mcp:execute_assistant` — Execute assistants (administrator only)
7. Copy the key immediately — it won't be shown again

## Claude Code Configuration

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "aistudio": {
      "type": "streamable-http",
      "url": "https://your-aistudio-domain.com/api/mcp",
      "headers": {
        "Authorization": "Bearer sk-your-api-key-here"
      }
    }
  }
}
```

## Cursor Configuration

In Cursor preferences, add a new MCP server:

- **Name**: AI Studio
- **Type**: Streamable HTTP
- **URL**: `https://your-aistudio-domain.com/api/mcp`
- **Headers**: `Authorization: Bearer sk-your-api-key-here`

## Available Tools

| Tool | Description | Required Scope |
|------|-------------|----------------|
| `search_decisions` | Search decision graph nodes by type, class, or text query | `mcp:search_decisions` |
| `capture_decision` | Create a structured decision with context, evidence, and alternatives | `mcp:capture_decision` |
| `list_assistants` | List AI assistants available to execute | `mcp:list_assistants` |
| `execute_assistant` | Execute an AI assistant with given inputs | `mcp:execute_assistant` |
| `get_decision_graph` | Get a decision node and all its connections | `mcp:get_decision_graph` |

## Example Workflows

### Search past decisions

```
Use the search_decisions tool to find decisions about "database migration"
```

### Capture a new decision

```
Use capture_decision to record:
- Title: "Switch to Drizzle ORM"
- Context: "Need type-safe database queries"
- Decision: "Adopt Drizzle ORM with postgres.js driver"
- Alternatives considered: "Prisma, raw SQL, Knex.js"
```

### Execute an assistant

```
Use list_assistants to see available assistants, then
use execute_assistant to run the "Code Reviewer" assistant
with the given code snippet
```

## Authentication Options

| Method | Header | Best For |
|--------|--------|----------|
| API Key | `Authorization: Bearer sk-...` | CLI tools, CI/CD, personal use |
| OAuth JWT | `Authorization: Bearer eyJ...` | Third-party apps, shared integrations |

## Troubleshooting

### "Unauthorized" (401)
- Verify your API key starts with `sk-`
- Check the key hasn't been revoked in Settings > API Keys
- Confirm the Authorization header format: `Bearer sk-...`

### "Forbidden" (403)
- Your key may not have the required scope for that tool
- Staff users cannot use `capture_decision` or `execute_assistant` — administrator role required

### "Too Many Requests" (429)
- Default rate limit: 60 requests/minute per API key
- Check `Retry-After` header for wait time
- Contact your administrator if you need a higher limit

### Connection errors
- Verify the URL ends with `/api/mcp` (no trailing slash)
- Ensure your network can reach the AI Studio domain
- Check that the MCP server transport is set to `streamable-http` (not SSE)

---

*See also: [API Quickstart](./api-quickstart.md) | [OAuth Integration](./oauth-integration.md)*
