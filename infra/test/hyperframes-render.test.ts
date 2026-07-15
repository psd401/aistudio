/**
 * CDK assertion test for the HyperFrames render Lambda + its wiring (#1175).
 *
 * Asserts the pieces the psd-hyperframes skill depends on:
 *   1. a container-image (PackageType: Image) render Lambda `psd-hyperframes-render-<env>`
 *      sized for headless rendering (memory/timeout/ephemeral, x86_64);
 *   2. its execution role's S3 write is scoped to the public-images/ prefix only
 *      (least privilege — no read/list/delete, no other prefix);
 *   3. the AgentCore execution role can invoke ONLY that render function ARN;
 *   4. the render function name is exposed to the runtime as HYPERFRAMES_RENDER_FUNCTION.
 *
 * Synth setup mirrors agent-platform-mcp-key.test.ts: cached VPC context remapped
 * to a test account, `agentImageTag` set so the AgentCore runtime (the sole
 * consumer of runtimeEnvVars) materializes, and lambda bundling disabled — Docker
 * image assets are fingerprinted at synth, never built here.
 */
import * as fs from 'fs';
import * as path from 'path';
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
      agentImageTag: 'test-image-tag',
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

describe('AgentPlatformStack — HyperFrames render Lambda (#1175)', () => {
  let template: Template;

  beforeAll(() => {
    template = buildTemplate();
  });

  it('creates a container-image render Lambda sized for headless rendering', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: `psd-hyperframes-render-${ENV}`,
      PackageType: 'Image',
      MemorySize: 4096,
      Timeout: 900,
      EphemeralStorage: { Size: 4096 },
      Architectures: ['x86_64'],
      // Cap parallel renders so an agent-render burst can't drain the account's
      // shared Lambda concurrency pool (each render is a 4 GB Chromium container).
      ReservedConcurrentExecutions: 5,
    });
  });

  it('exposes WORKSPACE_BUCKET + a render timeout to the render Lambda', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: `psd-hyperframes-render-${ENV}`,
      Environment: {
        Variables: Match.objectLike({
          WORKSPACE_BUCKET: Match.anyValue(),
          HYPERFRAMES_RENDER_TIMEOUT_MS: Match.anyValue(),
        }),
      },
    });
  });

  it('scopes the render role S3 write to the public-images/ prefix only (no read/list/delete)', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: `psd-hyperframes-render-${ENV}-execution-role-${ENV}`,
      Policies: Match.arrayWith([
        Match.objectLike({
          PolicyDocument: {
            Statement: Match.arrayWith([
              Match.objectLike({
                Sid: 'WriteRenderedVideoToPublicImages',
                Effect: 'Allow',
                Action: 's3:PutObject',
                Resource: Match.objectLike({
                  'Fn::Join': Match.arrayWith([
                    Match.arrayWith([Match.stringLikeRegexp('/public-images/\\*')]),
                  ]),
                }),
              }),
            ]),
          },
        }),
      ]),
    });
  });

  it('lets the AgentCore execution role invoke ONLY the render function', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'HyperframesRenderInvoke',
            Effect: 'Allow',
            Action: 'lambda:InvokeFunction',
          }),
        ]),
      },
    });
  });
});
