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
const TEST_VPC_KEY =
  `vpc-provider:account=${TEST_ACCOUNT}:filter.tag:Name=aistudio-${ENV}-vpc:` +
  `region=${REGION}:returnAsymmetricSubnets=true`;

function buildTemplate(): Template {
  const cdkContext = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'cdk.context.json'), 'utf8')
  ) as Record<string, unknown>;
  const vpcBlob = JSON.parse(JSON.stringify(cdkContext[REAL_VPC_KEY])) as {
    subnetGroups: Array<{ subnets: Array<{ availabilityZone: string }> }>;
  };
  for (const group of vpcBlob.subnetGroups) {
    for (const subnet of group.subnets) {
      if (subnet.availabilityZone === 'us-east-1a') {
        subnet.availabilityZone = 'us-east-1c';
      }
    }
  }
  const app = new cdk.App({
    context: {
      ...cdkContext,
      [TEST_VPC_KEY]: vpcBlob,
      'aws:cdk:bundling-stacks': [],
      agentImageTag: 'test-image-tag',
    },
  });
  const stack = new AgentPlatformStack(
    app,
    `AIStudio-AgentPlatformStack-${ENV}`,
    {
      environment: ENV,
      config: EnvironmentConfig.get(ENV),
      databaseResourceArn:
        `arn:aws:rds:${REGION}:${TEST_ACCOUNT}:cluster:aistudio-${ENV}`,
      databaseSecretArn:
        `arn:aws:secretsmanager:${REGION}:${TEST_ACCOUNT}:` +
        `secret:aistudio-${ENV}-db-AbCdEf`,
      databaseHost:
        `aistudio-${ENV}.cluster-abc.${REGION}.rds.amazonaws.com`,
      databaseName: 'aistudio',
      guardrailArn:
        `arn:aws:bedrock:${REGION}:${TEST_ACCOUNT}:guardrail/test`,
      guardrailId: 'test-guardrail-id',
      alertEmail: 'alerts@psd401.net',
      appBaseUrl: `https://${ENV}.aistudio.psd401.ai`,
      env: { account: TEST_ACCOUNT, region: REGION },
    }
  );
  return Template.fromStack(stack);
}

describe('Agent workspace lifecycle admission invariants', () => {
  it('keeps staging, public, and tagged-private cleanup rules disjoint', () => {
    buildTemplate().hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: 'expire-unverified-upload-staging',
            Prefix: '.upload-staging/',
            ExpirationInDays: 1,
            NoncurrentVersionExpiration: { NoncurrentDays: 1 },
          }),
          Match.objectLike({
            Id: 'expire-public-artifacts',
            Prefix: 'public-images/',
            ExpirationInDays: 30,
            NoncurrentVersionExpiration: { NoncurrentDays: 7 },
          }),
          Match.objectLike({
            Id: 'cleanup-private-workspace-versions',
            TagFilters: [{ Key: 'Scope', Value: 'private' }],
            NoncurrentVersionExpiration: { NoncurrentDays: 30 },
          }),
        ]),
      },
    });
  });
});
