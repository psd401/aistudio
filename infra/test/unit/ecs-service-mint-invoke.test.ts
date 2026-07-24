/**
 * CDK assertion test for the frontend ECS task role's mint-Lambda grant
 * (#1232 confused-deputy hardening).
 *
 * The frontend must be able to INVOKE the isolated mint Lambda — and nothing
 * more. It must NOT hold the WIF credential or any richer permission on that
 * function. Asserts:
 *   1. the task role grants lambda:InvokeFunction on the constructed
 *      `psd-agent-mint-<env>` ARN (constructed string, NOT a cross-stack import,
 *      so there is no FrontendStack ↔ AgentPlatformStack circular dependency);
 *   2. that grant is INVOKE-ONLY (the statement carrying the mint ARN has exactly
 *      the lambda:InvokeFunction action);
 *   3. the container is told which function to call via AGENT_MINT_LAMBDA_NAME.
 */
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template } from 'aws-cdk-lib/assertions';
import { EcsServiceConstruct } from '../../lib/constructs/ecs-service';

const ENV = 'dev';
const MINT_FN = `psd-agent-mint-${ENV}`;

function synthTemplate(): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const vpc = new ec2.Vpc(stack, 'TestVpc', { maxAzs: 2 });
  const secretArn = (name: string) =>
    `arn:aws:secretsmanager:us-east-1:123456789012:secret:aistudio-${ENV}-${name}-AbCdEf`;

  new EcsServiceConstruct(stack, 'EcsService', {
    vpc,
    environment: ENV,
    documentsBucketName: `aistudio-${ENV}-documents`,
    agentWorkspaceBucketName: `aistudio-${ENV}-agent-workspace`,
    atriumSandboxOrigin: 'https://sandbox.example.com',
    dockerImageSource: 'fromEcrRepository',
    authUrl: `https://${ENV}.aistudio.psd401.ai`,
    cognitoClientId: 'test-client-id',
    cognitoIssuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_testpool',
    rdsResourceArn: 'arn:aws:rds:us-east-1:123456789012:cluster:aistudio-dev-cluster',
    rdsSecretArn: secretArn('db'),
    authSecretArn: secretArn('auth'),
    collabJwtSecretArn: secretArn('collab-jwt'),
    guardrailHashSecretArn: secretArn('guardrail-hash'),
    oidcCookieSecretArn: secretArn('oidc-cookie'),
    oidcSigningJwksSecretArn: secretArn('oidc-signing'),
  });

  return Template.fromStack(stack);
}

interface Statement {
  Effect?: string;
  Action?: unknown;
  Resource?: unknown;
  Condition?: unknown;
}

function allStatements(template: Template): Statement[] {
  const statements: Statement[] = [];
  // Standalone AWS::IAM::Policy resources.
  for (const policy of Object.values(template.findResources('AWS::IAM::Policy'))) {
    const doc = (policy as { Properties?: { PolicyDocument?: { Statement?: Statement[] } } })
      .Properties?.PolicyDocument?.Statement;
    if (Array.isArray(doc)) statements.push(...doc);
  }
  // Inline policies declared on roles (the task role's InvokeFunction grant lives
  // here, inside the RDSDataAPIAccess inline document).
  for (const role of Object.values(template.findResources('AWS::IAM::Role'))) {
    const inline = (role as { Properties?: { Policies?: Array<{ PolicyDocument?: { Statement?: Statement[] } }> } })
      .Properties?.Policies ?? [];
    for (const p of inline) {
      if (Array.isArray(p.PolicyDocument?.Statement)) statements.push(...p.PolicyDocument!.Statement!);
    }
  }
  return statements;
}

describe('ECS task role — mint Lambda invoke-only grant (#1232)', () => {
  let template: Template;
  beforeAll(() => {
    template = synthTemplate();
  });

  it('grants lambda:InvokeFunction on the constructed psd-agent-mint-<env> ARN', () => {
    const statements = allStatements(template);
    const mintStmt = statements.find(
      (s) => JSON.stringify(s.Resource ?? '').includes(`function:${MINT_FN}`)
    );
    expect(mintStmt).toBeDefined();
    expect(mintStmt!.Effect).toBe('Allow');
  });

  it('is INVOKE-ONLY — the statement carrying the mint ARN grants exactly lambda:InvokeFunction', () => {
    const statements = allStatements(template);
    const mintStmt = statements.find(
      (s) => JSON.stringify(s.Resource ?? '').includes(`function:${MINT_FN}`)
    );
    expect(mintStmt).toBeDefined();
    const actions = Array.isArray(mintStmt!.Action) ? mintStmt!.Action : [mintStmt!.Action];
    expect(actions).toEqual(['lambda:InvokeFunction']);
  });

  it('the grant is a constructed ARN string, not a cross-stack Fn::ImportValue', () => {
    const statements = allStatements(template);
    const mintStmt = statements.find(
      (s) => JSON.stringify(s.Resource ?? '').includes(`function:${MINT_FN}`)
    )!;
    // A constructed ARN resolves via Fn::Join over the region/account; a
    // cross-stack import would surface as Fn::ImportValue (the circular-dep trap).
    expect(JSON.stringify(mintStmt.Resource)).not.toContain('Fn::ImportValue');
  });

  it('sets AGENT_MINT_LAMBDA_NAME on the frontend container', () => {
    const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
    const envPairs: Array<{ Name?: string; Value?: unknown }> = [];
    for (const td of Object.values(taskDefs)) {
      const containers = (td as { Properties?: { ContainerDefinitions?: Array<{ Environment?: Array<{ Name?: string; Value?: unknown }> }> } })
        .Properties?.ContainerDefinitions ?? [];
      for (const c of containers) if (Array.isArray(c.Environment)) envPairs.push(...c.Environment);
    }
    const mintEnv = envPairs.find((e) => e.Name === 'AGENT_MINT_LAMBDA_NAME');
    expect(mintEnv).toBeDefined();
    expect(mintEnv!.Value).toBe(MINT_FN);
  });

  it('injects the dedicated OIDC cookie secret into the frontend container', () => {
    const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
    const secretPairs: Array<{ Name?: string; ValueFrom?: unknown }> = [];
    for (const td of Object.values(taskDefs)) {
      const containers = (
        td as {
          Properties?: {
            ContainerDefinitions?: Array<{
              Secrets?: Array<{ Name?: string; ValueFrom?: unknown }>;
            }>;
          };
        }
      ).Properties?.ContainerDefinitions ?? [];
      for (const container of containers) {
        if (Array.isArray(container.Secrets)) {
          secretPairs.push(...container.Secrets);
        }
      }
    }

    const oidcCookieSecret = secretPairs.find(
      (secret) => secret.Name === 'OIDC_COOKIE_SECRET'
    );
    expect(oidcCookieSecret).toBeDefined();
    expect(JSON.stringify(oidcCookieSecret!.ValueFrom)).toContain('oidc-cookie');
    expect(JSON.stringify(oidcCookieSecret!.ValueFrom)).toContain(
      'OIDC_COOKIE_SECRET'
    );
  });

  it('keeps legacy document storage permissions separate from permanent cleanup', () => {
    const statements = allStatements(template);
    const legacyDocumentStorage = statements.find((statement) => {
      const resources = JSON.stringify(statement.Resource ?? '');
      const actions = Array.isArray(statement.Action)
        ? statement.Action
        : [statement.Action];
      return (
        resources.includes(`aistudio-${ENV}-documents`) &&
        actions.includes('s3:DeleteObject')
      );
    });

    expect(legacyDocumentStorage).toBeDefined();
    const actions = Array.isArray(legacyDocumentStorage!.Action)
      ? legacyDocumentStorage!.Action
      : [legacyDocumentStorage!.Action];
    expect(actions).toEqual(expect.arrayContaining([
      's3:GetObject',
      's3:PutObject',
      's3:DeleteObject',
      's3:ListBucket',
    ]));
    expect(actions).not.toEqual(expect.arrayContaining([
      's3:DeleteObjectVersion',
      's3:PutObjectTagging',
      's3:AbortMultipartUpload',
      's3:ListBucketVersions',
    ]));
    // Historical uploads use owner/timestamp keys outside repositories/*.
    // Their existing current-object deletion permission remains intentionally
    // broad for backward compatibility, without granting broad version purge.
    expect(JSON.stringify(legacyDocumentStorage!.Resource)).toContain(
      `aistudio-${ENV}-documents/*`
    );
  });

  it('scopes permanent object-version deletion to repositories/*', () => {
    const statements = allStatements(template);
    const versionDeletionStatements = statements.filter((statement) => {
      const actions = Array.isArray(statement.Action)
        ? statement.Action
        : [statement.Action];
      return actions.includes('s3:DeleteObjectVersion');
    });

    expect(versionDeletionStatements).toHaveLength(1);
    expect(versionDeletionStatements[0]).toMatchObject({
      Effect: 'Allow',
      Action: expect.arrayContaining([
        's3:PutObjectTagging',
        's3:DeleteObjectVersion',
        's3:AbortMultipartUpload',
      ]),
    });
    expect(JSON.stringify(versionDeletionStatements[0]!.Resource)).toContain(
      `aistudio-${ENV}-documents/repositories/*`
    );
    expect(JSON.stringify(versionDeletionStatements[0]!.Resource)).not.toContain(
      `aistudio-${ENV}-documents/*`
    );
  });

  it('scopes ListBucketVersions to the repositories prefix', () => {
    const statements = allStatements(template);
    const versionListingStatements = statements.filter((statement) => {
      const actions = Array.isArray(statement.Action)
        ? statement.Action
        : [statement.Action];
      return actions.includes('s3:ListBucketVersions');
    });

    expect(versionListingStatements).toHaveLength(1);
    expect(versionListingStatements[0]).toMatchObject({
      Effect: 'Allow',
      Action: 's3:ListBucketVersions',
      Condition: {
        StringLike: {
          's3:prefix': ['repositories/*'],
        },
      },
    });
    expect(JSON.stringify(versionListingStatements[0]!.Resource)).toContain(
      `aistudio-${ENV}-documents`
    );
    expect(JSON.stringify(versionListingStatements[0]!.Resource)).not.toContain(
      '/repositories/*'
    );
  });

  it('grants only bedrock:Rerank on wildcard while model invocation stays resource-scoped', () => {
    const statements = allStatements(template);
    const rerankStatement = statements.find((statement) => {
      const actions = Array.isArray(statement.Action)
        ? statement.Action
        : [statement.Action];
      return actions.includes('bedrock:Rerank');
    });
    expect(rerankStatement).toMatchObject({
      Effect: 'Allow',
      Action: 'bedrock:Rerank',
      Resource: '*',
    });

    const invokeStatement = statements.find((statement) => {
      const actions = Array.isArray(statement.Action)
        ? statement.Action
        : [statement.Action];
      return actions.includes('bedrock:InvokeModel');
    });
    expect(invokeStatement).toBeDefined();
    expect(invokeStatement!.Resource).not.toBe('*');
  });
});
