import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AgentPlatformStack } from '../lib/agent-platform-stack';
import { EnvironmentConfig } from '../lib/constructs';

const TEST_ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const ENV = 'prod';
const RUNTIME_SECURITY_GROUP_LOGICAL_ID = 'SecurityGroupDD263621';
const REAL_VPC_KEY =
  'vpc-provider:account=390844780692:filter.tag:Name=aistudio-prod-vpc:' +
  'region=us-east-1:returnAsymmetricSubnets=true';
const TEST_VPC_KEY =
  `vpc-provider:account=${TEST_ACCOUNT}:filter.tag:Name=aistudio-${ENV}-vpc:` +
  `region=${REGION}:returnAsymmetricSubnets=true`;

type CfnResource = {
  Type: string;
  Properties?: Record<string, unknown>;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
};

function buildTemplate(imageTag?: string): Template {
  const cdkContext = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'cdk.context.json'), 'utf8')
  ) as Record<string, unknown>;
  const vpcBlob = JSON.parse(JSON.stringify(cdkContext[REAL_VPC_KEY])) as unknown;
  const app = new cdk.App({
    context: {
      ...cdkContext,
      [TEST_VPC_KEY]: vpcBlob,
      'aws:cdk:bundling-stacks': [],
      ...(imageTag ? { agentImageTag: imageTag } : {}),
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

function resourcesOf(template: Template): Record<string, CfnResource> {
  return template.toJSON().Resources as Record<string, CfnResource>;
}

function workspaceBucketOf(template: Template): [string, CfnResource] {
  const buckets = Object.entries(resourcesOf(template)).filter(
    ([logicalId, resource]) =>
      logicalId.startsWith('AgentWorkspaceBucket') &&
      resource.Type === 'AWS::S3::Bucket'
  );
  expect(buckets).toHaveLength(1);
  return buckets[0];
}

function withoutCustomResourceOwnershipTags(resource: CfnResource): CfnResource {
  const normalized = JSON.parse(JSON.stringify(resource)) as CfnResource;
  const tags = normalized.Properties?.Tags;
  if (Array.isArray(tags)) {
    normalized.Properties!.Tags = tags.filter((tag) => {
      if (tag === null || typeof tag !== 'object') return true;
      const key = (tag as { Key?: unknown }).Key;
      return typeof key !== 'string' || !key.startsWith('aws-cdk:cr-owned:');
    });
  }
  return normalized;
}

describe('AgentPlatformStack — persistent AgentCore Runtime security group', () => {
  let withoutRuntime: Template;
  let withRuntime: Template;

  beforeAll(() => {
    withoutRuntime = buildTemplate();
    withRuntime = buildTemplate('test-image-tag');
  });

  it('keeps the existing Runtime security group when image context is omitted', () => {
    const resources = resourcesOf(withoutRuntime);

    expect(resources[RUNTIME_SECURITY_GROUP_LOGICAL_ID]).toEqual(
      expect.objectContaining({ Type: 'AWS::EC2::SecurityGroup' })
    );
    expect(withoutRuntime.findResources('AWS::BedrockAgentCore::Runtime')).toEqual({});
  });

  it('wires the forward Runtime to the same preserved security group', () => {
    const resources = resourcesOf(withRuntime);
    const runtimes = withRuntime.findResources('AWS::BedrockAgentCore::Runtime');

    expect(resources[RUNTIME_SECURITY_GROUP_LOGICAL_ID]).toEqual(
      resourcesOf(withoutRuntime)[RUNTIME_SECURITY_GROUP_LOGICAL_ID]
    );
    expect(Object.keys(runtimes)).toHaveLength(1);
    expect(Object.values(runtimes)[0]).toEqual(
      expect.objectContaining({
        Properties: expect.objectContaining({
          NetworkConfiguration: expect.objectContaining({
            NetworkMode: 'VPC',
            NetworkModeConfig: expect.objectContaining({
              SecurityGroups: [
                {
                  'Fn::GetAtt': [
                    RUNTIME_SECURITY_GROUP_LOGICAL_ID,
                    'GroupId',
                  ],
                },
              ],
            }),
          }),
        }),
      })
    );
  });

  it('leaves the retained production workspace bucket unchanged', () => {
    const withoutRuntimeBucket = workspaceBucketOf(withoutRuntime);
    const withRuntimeBucket = workspaceBucketOf(withRuntime);

    expect(withRuntimeBucket[0]).toBe(withoutRuntimeBucket[0]);
    // Bundled-skill custom resources add an image-tag-specific ownership tag
    // to this shared bucket. Ignore only those CDK bookkeeping tags; every
    // persistent bucket property and policy must remain identical.
    expect(withoutCustomResourceOwnershipTags(withRuntimeBucket[1])).toEqual(
      withoutCustomResourceOwnershipTags(withoutRuntimeBucket[1])
    );
    expect(withoutRuntimeBucket[1].DeletionPolicy).toBe('Retain');
    expect(withoutRuntimeBucket[1].UpdateReplacePolicy).toBe('Retain');
  });
});
