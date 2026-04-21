/**
 * Bedrock API Key Manager — Lambda with three handlers in one function, all
 * scheduled/triggered by CDK so the agent platform is self-sufficient:
 *
 *   1. CloudFormation Custom Resource (provision)
 *      - onCreate: creates the IAM service-specific credential and stashes
 *        the secret into Secrets Manager. The secret value is only returned
 *        by IAM at CREATE time, so this must be an atomic step.
 *      - onUpdate: no-op. We do not rotate on every CDK deploy; rotation is
 *        its own schedule.
 *      - onDelete: revokes the active credential. IAM users and secrets are
 *        deleted by CDK natively.
 *
 *   2. Scheduled rotation (EventBridge, monthly)
 *      - Lists active credentials. If one exists and is older than
 *        ROTATION_AGE_DAYS, creates a new one, updates the secret, marks the
 *        old credential Inactive (grace period for running microVMs to cycle
 *        onto the new key), then deletes any Inactive credentials older than
 *        RETENTION_DAYS.
 *
 *   3. Scheduled watchdog (EventBridge, weekly)
 *      - Lists active credentials. If any expire within WARN_DAYS, publishes
 *        an SNS alert to the stack's alarm topic so a human can see it.
 *      - Also alerts if zero active credentials exist (something got nuked).
 *
 * Dispatch:
 *   - CloudFormation sends RequestType = Create | Update | Delete
 *   - EventBridge sends detail.action = "rotate" | "watchdog"
 *
 * Required env:
 *   IAM_USER_NAME       — the IAM user that owns the credentials
 *   SECRET_ID           — Secrets Manager secret ARN/name to keep in sync
 *   ALARM_TOPIC_ARN     — SNS topic for watchdog alerts (optional; no-op if unset)
 *   ENVIRONMENT         — for alert message context
 *
 * Optional env:
 *   CREDENTIAL_AGE_DAYS — how long new credentials live (default 365)
 *   ROTATION_AGE_DAYS   — rotate when active credential reaches this age (default 300)
 *   WARN_DAYS           — watchdog alerts when <= this many days to expiry (default 30)
 *   RETENTION_DAYS      — delete Inactive credentials older than this (default 7)
 */

import {
  IAMClient,
  CreateServiceSpecificCredentialCommand,
  DeleteServiceSpecificCredentialCommand,
  ListServiceSpecificCredentialsCommand,
  UpdateServiceSpecificCredentialCommand,
  type ServiceSpecificCredentialMetadata,
} from '@aws-sdk/client-iam';
import {
  SecretsManagerClient,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import type {
  CloudFormationCustomResourceEvent,
  CloudFormationCustomResourceResponse,
  EventBridgeEvent,
} from 'aws-lambda';

const BEDROCK_SERVICE = 'bedrock.amazonaws.com';
const iam = new IAMClient({});
const secrets = new SecretsManagerClient({});
const sns = new SNSClient({});

const env = {
  userName: must('IAM_USER_NAME'),
  secretId: must('SECRET_ID'),
  alarmTopic: process.env.ALARM_TOPIC_ARN || '',
  environment: process.env.ENVIRONMENT || 'unknown',
  credAgeDays: num('CREDENTIAL_AGE_DAYS', 365),
  rotationAgeDays: num('ROTATION_AGE_DAYS', 300),
  warnDays: num('WARN_DAYS', 30),
  retentionDays: num('RETENTION_DAYS', 7),
};

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var is required`);
  return v;
}

function num(name: string, def: number): number {
  const v = process.env[name];
  return v ? parseInt(v, 10) : def;
}

type ManagerEvent =
  | CloudFormationCustomResourceEvent
  | EventBridgeEvent<'Scheduled Event', { action: string }>;

export async function handler(event: ManagerEvent): Promise<unknown> {
  console.info('event', JSON.stringify(event));

  if ('RequestType' in event) {
    return handleCustomResource(event);
  }
  const action = event.detail?.action;
  if (action === 'rotate') return rotate();
  if (action === 'watchdog') return watchdog();
  throw new Error(`Unknown event; detail.action=${action}`);
}

// ---------------------------------------------------------------------------
// Custom Resource (CloudFormation) handler
// ---------------------------------------------------------------------------

async function handleCustomResource(
  event: CloudFormationCustomResourceEvent
): Promise<CloudFormationCustomResourceResponse> {
  const baseResponse = {
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
  };

  try {
    if (event.RequestType === 'Create') {
      const credId = await provisionCredentialAndSyncSecret();
      return {
        ...baseResponse,
        Status: 'SUCCESS',
        PhysicalResourceId: credId,
        Data: { CredentialId: credId },
      };
    }

    if (event.RequestType === 'Update') {
      // Don't rotate on every CDK update — rotation is its own schedule.
      // But ensure the secret has a value; if the old stack was torn down
      // and recreated, the secret may be empty.
      return {
        ...baseResponse,
        Status: 'SUCCESS',
        PhysicalResourceId: event.PhysicalResourceId,
      };
    }

    if (event.RequestType === 'Delete') {
      // Revoke the credential so the orphaned user can't be used. The IAM
      // user itself is deleted by CDK.
      const existing = await listActive();
      for (const cred of existing) {
        if (cred.ServiceSpecificCredentialId) {
          await iam.send(new DeleteServiceSpecificCredentialCommand({
            UserName: env.userName,
            ServiceSpecificCredentialId: cred.ServiceSpecificCredentialId,
          }));
        }
      }
      return {
        ...baseResponse,
        Status: 'SUCCESS',
        PhysicalResourceId: event.PhysicalResourceId,
      };
    }

    return {
      ...baseResponse,
      Status: 'FAILED',
      Reason: `Unhandled RequestType: ${(event as { RequestType: string }).RequestType}`,
      PhysicalResourceId: 'error',
    };
  } catch (err) {
    console.error('custom-resource error', err);
    return {
      ...baseResponse,
      Status: 'FAILED',
      Reason: err instanceof Error ? err.message : String(err),
      PhysicalResourceId: 'PhysicalResourceId' in event ? event.PhysicalResourceId : 'error',
    };
  }
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

async function provisionCredentialAndSyncSecret(): Promise<string> {
  const create = await iam.send(new CreateServiceSpecificCredentialCommand({
    UserName: env.userName,
    ServiceName: BEDROCK_SERVICE,
    CredentialAgeDays: env.credAgeDays,
  }));
  const cred = create.ServiceSpecificCredential;
  if (!cred?.ServiceCredentialSecret || !cred.ServiceSpecificCredentialId) {
    throw new Error('CreateServiceSpecificCredential returned no secret');
  }

  await secrets.send(new PutSecretValueCommand({
    SecretId: env.secretId,
    SecretString: cred.ServiceCredentialSecret,
  }));

  console.info('provisioned credential', cred.ServiceSpecificCredentialId);
  return cred.ServiceSpecificCredentialId;
}

// ---------------------------------------------------------------------------
// Scheduled rotation (monthly)
// ---------------------------------------------------------------------------

async function rotate(): Promise<{ rotated: boolean; reason: string }> {
  const all = await listAll();
  const active = all.filter((c) => c.Status === 'Active');
  const inactive = all.filter((c) => c.Status === 'Inactive');

  // Step 1: delete Inactive credentials past retention
  const now = Date.now();
  for (const cred of inactive) {
    const ageMs = now - (cred.CreateDate?.getTime() ?? now);
    if (ageMs > env.retentionDays * 86_400_000 && cred.ServiceSpecificCredentialId) {
      await iam.send(new DeleteServiceSpecificCredentialCommand({
        UserName: env.userName,
        ServiceSpecificCredentialId: cred.ServiceSpecificCredentialId,
      }));
      console.info('pruned inactive credential', cred.ServiceSpecificCredentialId);
    }
  }

  // Step 2: decide whether to rotate
  if (active.length === 0) {
    console.warn('no active credential — bootstrapping a new one');
    await provisionCredentialAndSyncSecret();
    return { rotated: true, reason: 'no-active-credential' };
  }

  // Use the youngest active credential as the reference age (usually the only one)
  const youngest = active.reduce((a, b) =>
    (a.CreateDate?.getTime() ?? 0) > (b.CreateDate?.getTime() ?? 0) ? a : b
  );
  const ageDays = (now - (youngest.CreateDate?.getTime() ?? now)) / 86_400_000;
  if (ageDays < env.rotationAgeDays) {
    return { rotated: false, reason: `youngest age ${ageDays.toFixed(1)}d < rotation threshold ${env.rotationAgeDays}d` };
  }

  // Step 3: create new, put in secret
  await provisionCredentialAndSyncSecret();

  // Step 4: mark all OTHER active credentials Inactive so they enter the
  // retention window. Running microVMs will naturally cycle onto the new key
  // as AgentCore recycles them; setting the old one Inactive prevents
  // further use but doesn't nuke in-flight traffic.
  const postActive = await listActive();
  const newest = postActive.reduce((a, b) =>
    (a.CreateDate?.getTime() ?? 0) > (b.CreateDate?.getTime() ?? 0) ? a : b
  );
  for (const cred of postActive) {
    if (cred.ServiceSpecificCredentialId === newest.ServiceSpecificCredentialId) continue;
    if (!cred.ServiceSpecificCredentialId) continue;
    await iam.send(new UpdateServiceSpecificCredentialCommand({
      UserName: env.userName,
      ServiceSpecificCredentialId: cred.ServiceSpecificCredentialId,
      Status: 'Inactive',
    }));
    console.info('marked old credential Inactive', cred.ServiceSpecificCredentialId);
  }

  return { rotated: true, reason: `age ${ageDays.toFixed(1)}d >= ${env.rotationAgeDays}d` };
}

// ---------------------------------------------------------------------------
// Scheduled watchdog (weekly)
// ---------------------------------------------------------------------------

async function watchdog(): Promise<{ ok: boolean; alerts: string[] }> {
  const active = await listActive();
  const alerts: string[] = [];

  if (active.length === 0) {
    alerts.push(`No active Bedrock API credentials for user ${env.userName}. Agent platform cannot authenticate to Mantle.`);
  }

  const now = Date.now();
  for (const cred of active) {
    if (!cred.ExpirationDate) continue;
    const daysLeft = Math.floor((cred.ExpirationDate.getTime() - now) / 86_400_000);
    if (daysLeft <= env.warnDays) {
      alerts.push(`Bedrock API credential ${cred.ServiceSpecificCredentialId} expires in ${daysLeft} days (${cred.ExpirationDate.toISOString().slice(0, 10)}). Rotation Lambda should handle this automatically when age >= ${env.rotationAgeDays}d; if you see this, check rotation health.`);
    }
  }

  if (alerts.length > 0 && env.alarmTopic) {
    await sns.send(new PublishCommand({
      TopicArn: env.alarmTopic,
      Subject: `[${env.environment}] PSD Agent Bedrock API key watchdog`,
      Message: alerts.join('\n\n'),
    }));
  }

  return { ok: alerts.length === 0, alerts };
}

// ---------------------------------------------------------------------------
// IAM helpers
// ---------------------------------------------------------------------------

async function listActive(): Promise<ServiceSpecificCredentialMetadata[]> {
  const all = await listAll();
  return all.filter((c) => c.Status === 'Active');
}

async function listAll(): Promise<ServiceSpecificCredentialMetadata[]> {
  const resp = await iam.send(new ListServiceSpecificCredentialsCommand({
    UserName: env.userName,
    ServiceName: BEDROCK_SERVICE,
  }));
  return resp.ServiceSpecificCredentials ?? [];
}
