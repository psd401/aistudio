---
title: Removing infrastructure components requires auditing their implicit security responsibilities
category: infrastructure
tags:
  - aws
  - aurora
  - rds
  - cost-optimization
  - security
  - lambda
  - cdk
severity: high
date: 2026-03-10
source: auto — /work
applicable_to: project
---

## What Happened

During Aurora/RDS cost optimization (removed RDS Proxy, fixed auto-pause Lambda, right-sized ACU config from 2-8 to 1-4), a security audit revealed a dev security group with `0.0.0.0/0` ingress on port 5432 that was previously masked by the RDS Proxy — the Proxy had been the actual network entry point, so the open SG was never directly reachable. Removing the Proxy made the group directly exposed.

## Root Cause

RDS Proxy was implicitly enforcing TLS termination and acting as the sole network ingress to Aurora. The open security group rule predated the Proxy and was never cleaned up because the Proxy masked it. Additional findings: Lambda error responses leaking boto3 exception details (ARNs, cluster IDs), a misleading CloudFormation export for a removed reader endpoint, missing RETAIN policy on prod log groups, a Python function shadowing bug, and deprecated `datetime.utcnow()` usage.

## Solution

Audit all security controls that a removed component was providing before finalizing removal:
- Network ingress rules that the component was absorbing
- TLS termination responsibilities
- Exported CloudFormation values that referenced the component
- Error response sanitization (ensure exceptions don't leak infra details)

## Prevention

Before removing any infrastructure component, explicitly document what security responsibilities it holds — network filtering, TLS, auth, error masking. Treat the removal as a security change, not just a cost change, and run a full audit of dependent security groups, exports, and error paths.
