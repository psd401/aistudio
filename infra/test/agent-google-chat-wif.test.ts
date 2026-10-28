/**
 * CDK assertions for keyless Google Chat auth (#1989).
 *
 * The Google side (psd401/psd-gcp-infra chat-app-wif.tf) trusts exact AWS
 * role names, so this pins the contract the stack must keep:
 *   1. the Chat service-account key secret `psd-agent-google-sa-<env>` and
 *      every GOOGLE_CREDENTIALS_SECRET_ARN reference are gone;
 *   2. all five Chat-posting compute units (router, cron, triage worker,
 *      triage digest Lambdas and the job-runner task) carry the WIF audience
 *      and the env's Chat service account;
 *   3. the job-runner task role has the stable name the WIF provider trusts.
 *
 * Synth setup mirrors agent-platform-mcp-key.test.ts (remapped VPC context,
 * Lambda bundling disabled).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AgentPlatformStack } from '../lib/agent-platform-stack';
import { EnvironmentConfig } from '../lib/constructs';

const TEST_ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const ENV = 'dev';

const REAL_VPC_KEY =
  'vpc-provider:account=390844780692:filter.tag:Name=aistudio-dev-vpc:region=us-east-1:returnAsymmetricSubnets=true';
const TEST_VPC_KEY = `vpc-provider:account=${TEST_ACCOUNT}:filter.tag:Name=aistudio-${ENV}-vpc:region=${REGION}:returnAsymmetricSubnets=true`;

const CHAT_AUTH_ENV = {
  GOOGLE_CHAT_WIF_AUDIENCE:
    '//iam.googleapis.com/projects/1022506104054/locations/global/' +
    'workloadIdentityPools/aws-agent-broker/providers/chat-app',
  GOOGLE_CHAT_SERVICE_ACCOUNT_EMAIL:
    'psd-agent-chat-dev@psd-aistudio-dev.iam.gserviceaccount.com',
};

function buildTemplate(): Template {
  const cdkContext = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'cdk.context.json'), 'utf8')
  ) as Record<string, unknown>;

  const vpcBlob = JSON.parse(JSON.stringify(cdkContext[REAL_VPC_KEY])) as {
    subnetGroups: Array<{ subnets: Array<{ availabilityZone: string }> }>;
  };
  for (const group of vpcBlob.subnetGroups) {
    for (const subnet of group.subnets) {
      if (subnet.availabilityZone === 'us-east-1a') subnet.availabilityZone = 'us-east-1c';
    }
  }

  const app = new cdk.App({
    context: {
      ...cdkContext,
      [TEST_VPC_KEY]: vpcBlob,
      'aws:cdk:bundling-stacks': [],
    },
  });

  const stack = new AgentPlatformStack(app, `AIStudio-AgentPlatformStack-${ENV}`, {
    environment: ENV,
    config: EnvironmentConfig.get(ENV),
    databaseResourceArn: `arn:aws:rds:${REGION}:${TEST_ACCOUNT}:cluster:aistudio-${ENV}`,
    databaseSecretArn: `arn:aws:secretsmanager:${REGION}:${TEST_ACCOUNT}:secret:aistudio-${ENV}-db-AbCdEf`,
    databaseHost: `aistudio-${ENV}.cluster-abc.${REGION}.rds.amazonaws.com`,
    databaseName: 'aistudio',
    guardrailArn: `arn:aws:bedrock:${REGION}:${TEST_ACCOUNT}:guardrail/test`,
    guardrailId: 'test-guardrail-id',
    alertEmail: 'alerts@psd401.net',
    appBaseUrl: `https://${ENV}.aistudio.psd401.ai`,
    env: { account: TEST_ACCOUNT, region: REGION },
  });

  return Template.fromStack(stack);
}

let template: Template;

beforeAll(() => {
  template = buildTemplate();
});

describe('Google Chat keyless auth (#1989)', () => {
  test('no Chat key secret and no GOOGLE_CREDENTIALS_SECRET_ARN reference remain', () => {
    const secrets = template.findResources('AWS::SecretsManager::Secret', {
      Properties: { Name: `psd-agent-google-sa-${ENV}` },
    });
    expect(Object.keys(secrets)).toHaveLength(0);
    expect(JSON.stringify(template.toJSON())).not.toContain(
      'GOOGLE_CREDENTIALS_SECRET_ARN'
    );
  });

  test.each([
    'psd-agent-router',
    'psd-agent-cron',
    'psd-agent-triage-worker',
    'psd-agent-triage-digest',
  ])('%s Lambda carries the Chat WIF config', (name) => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: `${name}-${ENV}`,
      Environment: { Variables: Match.objectLike(CHAT_AUTH_ENV) },
    });
  });

  test('the job-runner task carries the Chat WIF config', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: `psd-agent-job-runner-${ENV}`,
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith(
            Object.entries(CHAT_AUTH_ENV).map(([Name, Value]) => ({ Name, Value }))
          ),
        }),
      ]),
    });
  });

  test('the job-runner task role has the name the WIF provider trusts', () => {
    const roles = template.findResources('AWS::IAM::Role', {
      Properties: { RoleName: `psd-agent-job-runner-task-role-${ENV}` },
    });
    const [roleId] = Object.keys(roles);
    expect(roleId).toBeDefined();
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: `psd-agent-job-runner-${ENV}`,
      TaskRoleArn: { 'Fn::GetAtt': [roleId, 'Arn'] },
    });
  });
});
