---
title: AWS ALB stickiness cookies (AWSALB/AWSALBCORS) cannot have Secure/HttpOnly set
category: infrastructure
tags:
  - aws
  - alb
  - security
  - qualys
  - cookies
severity: high
date: 2026-04-08
source: auto — /work
applicable_to: project
---

## What Happened

Qualys WAS scan flagged AWSALB and AWSALBCORS cookies for missing Secure and HttpOnly attributes. These cookies are generated and managed entirely by AWS ALB duration-based stickiness — there is no AWS API or CDK parameter to configure their security attributes.

## Root Cause

AWS ALB duration-based stickiness injects AWSALB/AWSALBCORS cookies directly at the load balancer layer. AWS does not expose any option to add Secure or HttpOnly flags to these cookies. This is a hard platform limitation, not a misconfiguration.

## Solution

Removed ALB stickiness entirely. The app is stateless (JWT sessions via NextAuth + Aurora), so stickiness was providing no benefit. With stickiness disabled, ALB no longer sets AWSALB/AWSALBCORS cookies and the Qualys finding is eliminated.

## Prevention

- Before enabling ALB stickiness, confirm the app actually requires session affinity.
- Stateless apps (JWT auth, no in-memory session state) should never enable duration-based stickiness.
- If stickiness is genuinely required, use application-based stickiness (custom cookie) where Secure/HttpOnly can be controlled, or accept the scanner finding as a vendor limitation and document the exception.
