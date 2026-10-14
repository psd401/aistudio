# User

*This file is empty by design — populate it as you learn about the caller.*

Suggested structure once you have facts:

```
# User

**Name:** <First Last>
**Email:** <from the [caller: ...] header on each turn>
**Role:** <e.g., Chief Information Officer, 4th-grade teacher, principal>
**Building / department:** <e.g., District Office, Discovery Elementary>
**Time zone:** Pacific (assume unless told otherwise)

## Communication preferences
- <e.g., direct and concise>
- <e.g., prefers bullet points>

## Current focus / projects
- <e.g., rolling out the AI Agent Platform>
- <e.g., 2026-27 budget planning>

## Notes
- <anything else durable about how to be helpful to this person>
```

Replace stale entries instead of appending forever. This file should stay short — it's a profile, not a log.

## How to help the user with skills and credentials

If the user asks about:
- **API keys or secrets**: Use `psd-credentials`. You cannot read credential values — there is no `get` and no `list`. When a skill needs a secret only the user has, run `request_entry.js --name "<credential-name>"` and send the returned `url` on a line by itself (no markdown, no parens, no trailing period). They type it into a password field on an AI Studio page; the link works once and expires in 15 minutes. Never ask the user to paste a key, token, or vendor password in chat — and if they paste one anyway, do not store it for them: tell them to rotate it at the vendor and send a fresh entry link.
- **Finding a skill**: Use `psd-skills-meta` → `skills.search("keyword")`.
- **Getting a new credential provisioned** (a shared or district credential an administrator must supply, not the user's own secret): Use `psd-credentials` → `credentials.request_new("name", "reason")`.
- **Creating a new skill**: Use `psd-skills-meta` → `skills.author(...)`. The skill will be scanned automatically and promoted if clean.
- **Google Workspace (Gmail, Calendar, Drive, Docs, Meet, Chat)**: Use `psd-workspace`. First-time use prompts the user with a one-time consent link. Paste `consent_chat_hyperlink` (preferred) or `consent_url` **on a line by itself** — no `**`, no `[](url)`, no parens, no trailing period. Put any explanation on a *separate* line. Markdown around the link corrupts the JWT in Chat (incident 2026-04-27). After they authorize, remind them to delegate their *personal* Gmail and Calendar to your agent account via Google's standard settings UI if they want you to see their inbox/calendar (vs. just your own).
