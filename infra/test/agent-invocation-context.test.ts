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

interface Statement {
  Sid?: string;
  Effect?: string;
  Action?: unknown;
  Resource?: unknown;
  Condition?: unknown;
}

function allStatements(template: Template): Statement[] {
  const statements: Statement[] = [];
  for (const policy of Object.values(
    template.findResources('AWS::IAM::Policy')
  )) {
    const policyStatements = (
      policy as {
        Properties?: {
          PolicyDocument?: { Statement?: Statement[] };
        };
      }
    ).Properties?.PolicyDocument?.Statement;
    if (Array.isArray(policyStatements)) statements.push(...policyStatements);
  }
  for (const role of Object.values(
    template.findResources('AWS::IAM::Role')
  )) {
    const policies = (
      role as {
        Properties?: {
          Policies?: Array<{
            PolicyDocument?: { Statement?: Statement[] };
          }>;
        };
      }
    ).Properties?.Policies ?? [];
    for (const policy of policies) {
      if (Array.isArray(policy.PolicyDocument?.Statement)) {
        statements.push(...policy.PolicyDocument.Statement);
      }
    }
  }
  return statements;
}

function lambdaEnvironment(
  template: Template,
  functionName: string
): Record<string, unknown> {
  const functions = template.findResources('AWS::Lambda::Function');
  const fn = Object.values(functions).find(
    (resource) =>
      (
        resource as {
          Properties?: { FunctionName?: string };
        }
      ).Properties?.FunctionName === functionName
  ) as
    | {
        Properties?: {
          Environment?: { Variables?: Record<string, unknown> };
        };
      }
    | undefined;
  expect(fn).toBeDefined();
  return fn?.Properties?.Environment?.Variables ?? {};
}

describe('Agent invocation context trust boundary', () => {
  let template: Template;

  beforeAll(() => {
    template = buildTemplate();
  });

  it('creates a dedicated generated signing secret', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: `psd-agent/${ENV}/invocation-signing-key`,
      GenerateSecretString: {
        ExcludePunctuation: true,
        IncludeSpace: false,
        PasswordLength: 64,
      },
    });
  });

  it('explicitly denies the AgentCore execution role access to the key', () => {
    const deny = allStatements(template).find(
      (statement) => statement.Sid === 'DenyInvocationSigningSecret'
    );
    expect(deny).toBeDefined();
    expect(deny).toMatchObject({
      Effect: 'Deny',
      Action: 'secretsmanager:GetSecretValue',
    });
    expect(JSON.stringify(deny?.Resource)).toContain(
      'AgentInvocationSigningSecret'
    );
  });

  it('never exposes the signing secret id in the model-facing runtime', () => {
    const runtimes = template.findResources('AWS::BedrockAgentCore::Runtime');
    const runtime = Object.values(runtimes)[0] as {
      Properties?: { EnvironmentVariables?: Record<string, unknown> };
    };
    expect(runtime).toBeDefined();
    expect(
      runtime.Properties?.EnvironmentVariables
    ).not.toHaveProperty('AGENT_INVOCATION_SIGNING_SECRET_ID');
  });

  it('supplies the secret id to every trusted Lambda issuer', () => {
    for (const functionName of [
      `psd-agent-router-${ENV}`,
      `psd-agent-cron-${ENV}`,
      `psd-agent-triage-worker-${ENV}`,
    ]) {
      const environment = lambdaEnvironment(template, functionName);
      expect(environment).toHaveProperty(
        'AGENT_INVOCATION_SIGNING_SECRET_ID'
      );
      expect(
        JSON.stringify(environment.AGENT_INVOCATION_SIGNING_SECRET_ID)
      ).toContain('AgentInvocationSigningSecret');
    }
  });

  it('grants the signing key to trusted issuers/verifier but not AgentCore', () => {
    const keyReads = allStatements(template).filter((statement) => {
      const actions = Array.isArray(statement.Action)
        ? statement.Action
        : [statement.Action];
      return (
        statement.Effect === 'Allow' &&
        actions.includes('secretsmanager:GetSecretValue') &&
        JSON.stringify(statement.Resource).includes(
          'AgentInvocationSigningSecret'
        )
      );
    });
    // Router, cron, triage worker, and async job-runner task.
    expect(keyReads).toHaveLength(4);
  });

  it('supplies the signing key id to the async job runner', () => {
    const taskDefinitions = template.findResources('AWS::ECS::TaskDefinition');
    const jobDefinition = Object.values(taskDefinitions).find(
      (resource) =>
        (
          resource as {
            Properties?: { Family?: string };
          }
        ).Properties?.Family === `psd-agent-job-runner-${ENV}`
    ) as
      | {
          Properties?: {
            ContainerDefinitions?: Array<{
              Environment?: Array<{ Name?: string; Value?: unknown }>;
            }>;
          };
        }
      | undefined;
    expect(jobDefinition).toBeDefined();
    const environment =
      jobDefinition?.Properties?.ContainerDefinitions?.[0]?.Environment ?? [];
    const signingId = environment.find(
      (entry) => entry.Name === 'AGENT_INVOCATION_SIGNING_SECRET_ID'
    );
    expect(signingId).toBeDefined();
    expect(JSON.stringify(signingId?.Value)).toContain(
      'AgentInvocationSigningSecret'
    );
  });

  it('removes direct schedule authority from the model-facing role', () => {
    const statements = allStatements(template);
    expect(
      statements.find((statement) => statement.Sid === 'SchedulerCrud')
    ).toBeUndefined();
    expect(
      statements.find((statement) => statement.Sid === 'SchedulerPassRole')
    ).toBeUndefined();
    const agentDynamo = statements.find(
      (statement) => statement.Sid === 'DynamoDBAccess'
    );
    expect(agentDynamo).toBeUndefined();
  });

  it('does not expose schedule infrastructure coordinates to AgentCore', () => {
    const runtimes = template.findResources('AWS::BedrockAgentCore::Runtime');
    const runtime = Object.values(runtimes)[0] as {
      Properties?: { EnvironmentVariables?: Record<string, unknown> };
    };
    const environment = runtime.Properties?.EnvironmentVariables ?? {};
    for (const variable of [
      'SCHEDULES_TABLE',
      'EVENTBRIDGE_SCHEDULE_GROUP',
      'CRON_LAMBDA_ARN',
      'EVENTBRIDGE_ROLE_ARN',
    ]) {
      expect(environment).not.toHaveProperty(variable);
    }
  });

  it('gives cron read-only access to the authoritative schedule table', () => {
    const scheduleRead = allStatements(template).find(
      (statement) => statement.Sid === 'AuthoritativeScheduleRead'
    );
    expect(scheduleRead).toMatchObject({
      Effect: 'Allow',
      Action: 'dynamodb:GetItem',
    });
    expect(JSON.stringify(scheduleRead?.Resource)).toContain(
      'AgentSchedulesTable'
    );
    const cronEnvironment = lambdaEnvironment(
      template,
      `psd-agent-cron-${ENV}`
    );
    expect(cronEnvironment).toHaveProperty('SCHEDULES_TABLE');
    expect(cronEnvironment).not.toHaveProperty('USERS_TABLE');
  });
});

describe('Agent schedule reliability infrastructure', () => {
  let template: Template;

  beforeAll(() => {
    template = buildTemplate();
  });

  it('sizes cron for fleet bursts while preserving the per-session lock', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: `psd-agent-cron-${ENV}`,
      ReservedConcurrentExecutions: 10,
    });
  });

  it('bounds accepted async retries inside the schedule-fire lease', () => {
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      FunctionName: {
        Ref: Match.stringLikeRegexp('CronLambda'),
      },
      MaximumEventAgeInSeconds: 3600,
      MaximumRetryAttempts: 2,
    });
  });

  it('lets EventBridge Scheduler send failed targets to the agent DLQ', () => {
    const sendToDlq = allStatements(template).find((statement) => {
      const actions = Array.isArray(statement.Action)
        ? statement.Action
        : [statement.Action];
      return (
        actions.includes('sqs:SendMessage') &&
        JSON.stringify(statement.Resource).includes('AgentAsyncDLQ')
      );
    });
    expect(sendToDlq).toMatchObject({
      Effect: 'Allow',
    });
  });

  it('alarms cron errors and throttles through the agent alarm topic', () => {
    for (const [alarmName, metricName] of [
      [`psd-agent-cron-errors-${ENV}`, 'Errors'],
      [`psd-agent-cron-throttles-${ENV}`, 'Throttles'],
    ]) {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: alarmName,
        Namespace: 'AWS/Lambda',
        MetricName: metricName,
        Threshold: 1,
        AlarmActions: Match.anyValue(),
      });
    }
  });

  it('alarms schedule-reference rejections before invocation', () => {
    template.hasResourceProperties('AWS::Logs::MetricFilter', {
      MetricTransformations: Match.arrayWith([
        Match.objectLike({
          MetricName: 'ScheduleReferenceRejections',
          MetricNamespace: `PSD/AgentPlatform/${ENV}`,
          MetricValue: '1',
        }),
      ]),
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: `psd-agent-schedule-reference-rejections-${ENV}`,
      Namespace: `PSD/AgentPlatform/${ENV}`,
      MetricName: 'ScheduleReferenceRejections',
      Threshold: 1,
      AlarmActions: Match.anyValue(),
    });
  });

  it('scopes legacy schedule backfill access to the required tables', () => {
    const statements = allStatements(template);
    const recordAccess = statements.find(
      (statement) => statement.Sid === 'ScheduleTargetBackfillRecords'
    );
    expect(recordAccess).toMatchObject({
      Effect: 'Allow',
      Action: expect.arrayContaining([
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:DeleteItem',
        'dynamodb:UpdateItem',
        'dynamodb:Scan',
      ]),
      Condition: {
        StringEquals: {
          'aws:ResourceTag/Environment': ENV,
          'aws:ResourceTag/ManagedBy': 'cdk',
        },
      },
    });
    expect(JSON.stringify(recordAccess?.Resource)).toContain(
      'AgentSchedulesTable'
    );
    expect(JSON.stringify(recordAccess?.Resource)).not.toContain(
      'UsersTable'
    );

    const ownerAccess = statements.find(
      (statement) => statement.Sid === 'ScheduleTargetBackfillReadOwners'
    );
    expect(ownerAccess).toMatchObject({
      Effect: 'Allow',
      Action: 'dynamodb:Query',
      Condition: {
        StringEquals: {
          'aws:ResourceTag/Environment': ENV,
          'aws:ResourceTag/ManagedBy': 'cdk',
        },
      },
    });
    expect(JSON.stringify(ownerAccess?.Resource)).toContain('UsersTable');
    expect(JSON.stringify(ownerAccess?.Resource)).toContain(
      '/index/email-index'
    );
    expect(JSON.stringify(ownerAccess?.Resource)).not.toContain(
      'AgentSchedulesTable'
    );
  });

  it('alarms Scheduler and Lambda DLQ depth through the agent alarm topic', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: `psd-agent-async-dlq-${ENV}`,
      Namespace: 'AWS/SQS',
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Threshold: 1,
      AlarmActions: Match.anyValue(),
    });
  });
});
