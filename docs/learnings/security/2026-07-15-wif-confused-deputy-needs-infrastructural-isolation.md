---
title: Keyless GCP WIF credential must live in its own least-privilege Lambda, not shared app compute
category: security
tags: [wif, workload-identity-federation, confused-deputy, gcp, lambda, iam, least-privilege, agent-workspace]
severity: critical
date: 2026-07-15
source: auto — /work
applicable_to: project
---

## What Happened

PR #1236 (#1232) hardened the GCP Workload-Identity-Federation (WIF) domain-wide-delegation broker (`lib/agent-workspace/gcp-wif.ts`). The broker previously ran inside the shared frontend ECS task, which resolves its WIF credential from the ambient AWS role via the container-credentials endpoint.

## Root Cause

WIF is keyless — the Google STS provider trusts *any* caller holding the bound AWS role's credentials, not a specific process. Because the frontend ECS task role was that bound principal, any code execution inside the same task (RCE, SSRF, a compromised dependency) could impersonate the service account and call `signJwt(sub=<arbitrary user>)`, minting a Google Workspace token for any `psd401.net` mailbox — including staff Gmail/Drive, far beyond the intended `agnt_*` service accounts. An app-layer guard that validates/derives the `sub` (`deriveAgentEmail`) does NOT close this gap: it runs in the same bypassable process as the vulnerability.

## Solution

- Moved both WIF consumers (DWD token broker + provisioning-sheet writer) into a new dedicated `psd-agent-mint-{env}` Lambda (`infra/lib/agent-platform-stack.ts`) with its own `ServiceRoleFactory` role — the SOLE AWS principal the Google WIF provider trusts (IT points the provider's principalSet condition at this exact, deterministic role ARN).
- That role gets only `secretsmanager:GetSecretValue` on `psd-agent/{env}/*` + CloudWatch Logs + VPC ENI (`AWSLambdaVPCAccessExecutionRole`). No other AWS grant is needed — WIF verification is an implicit `GetCallerIdentity` Google's STS performs against the role's ambient credentials.
- The frontend ECS task role loses all WIF-related access and gets only `lambda:InvokeFunction` on the mint Lambda (see `constructs/ecs-service.ts`). The Lambda handler always derives `agnt_<owner>` server-side — a frontend compromise can invoke the Lambda but can never make it sign a token for an arbitrary human.

## Prevention

- Treat "which AWS principal is bound to a keyless external-identity federation" as a security boundary decision, not an implementation detail — that principal must be the smallest possible blast radius (a single-purpose Lambda/role), never a shared multi-tenant compute role (ECS task, general-purpose Lambda).
- App-layer input validation/derivation guards are defense-in-depth, not the boundary — verify isolation at the IAM/infrastructure layer first.
