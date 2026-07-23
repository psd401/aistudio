# Local Codex configuration

The project-level Codex configuration starts the AWS Labs PostgreSQL MCP server
in read-only mode. Resource identifiers are intentionally not committed.

Set these variables in the environment that launches Codex:

```bash
export AISTUDIO_DB_CLUSTER_ARN="arn:aws:rds:<region>:<account>:cluster:<cluster>"
export AISTUDIO_DB_SECRET_ARN="arn:aws:secretsmanager:<region>:<account>:secret:<secret>"
```

Optional variables are `AISTUDIO_DB_NAME` (defaults to `aistudio`), `AWS_REGION`
(defaults to `us-east-1`), and `AWS_PROFILE` (handled by the AWS SDK). The launcher
fails with a clear message when either required identifier is missing.
