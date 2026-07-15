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
    internalApiSecretArn: secretArn('internal-api'),
    collabJwtSecretArn: secretArn('collab-jwt'),
    guardrailHashSecretArn: secretArn('guardrail-hash'),
  });

  return Template.fromStack(stack);
}

interface Statement { Effect?: string; Action?: unknown; Resource?: unknown }

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
});
