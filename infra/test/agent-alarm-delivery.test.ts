/**
 * Agent alarms must reach a topic somebody is actually subscribed to.
 *
 * On 2026-07-24 a deploy created the email subscription on
 * `psd-agent-alarms-prod`. Nobody clicked the confirmation link, so SNS deleted
 * it three days later — while CloudFormation kept the subscription resource
 * CREATE_COMPLETE, which means no later deploy restores it and there is no
 * drift for anyone to notice. The router dead-letter alarm went into ALARM on
 * 2026-07-29 and published to a topic with zero subscribers for 36 days. In
 * that window ~14 users' conversations were dropped and 50 messages died in the
 * DLQ, and the only thing that knew was an alarm talking to nobody.
 *
 * The stack's own comment already warned about this exact failure mode and told
 * the reader to verify `SubscriptionsConfirmed` out of band. That is a manual
 * step, and manual steps are what failed. So every agent alarm now ALSO
 * publishes to `aistudio-<env>-monitoring-alarms`, which is owned by a
 * different stack and carries a confirmed subscription.
 *
 * These tests pin that: an alarm wired to only one topic is one unclicked email
 * away from silence again.
 *
 * Synth notes follow infra/test/agent-platform-resource-cycles.test.ts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { AgentPlatformStack, notifyAgentAlarm } from '../lib/agent-platform-stack';
import { EnvironmentConfig } from '../lib/constructs';

const TEST_ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const REAL_VPC_KEY =
  'vpc-provider:account=390844780692:filter.tag:Name=aistudio-dev-vpc:region=us-east-1:returnAsymmetricSubnets=true';

// Each synth builds the whole AgentPlatformStack (~2s). There are only a few
// distinct configurations under test but one call per test, so memoise them.
const TEMPLATE_CACHE = new Map<string, Template>();

function buildTemplate(
  environment: 'dev' | 'prod',
  alertEmail?: string
): Template {
  const cacheKey = `${environment}:${alertEmail ?? 'none'}`;
  const cached = TEMPLATE_CACHE.get(cacheKey);
  if (cached) return cached;
  const built = synthTemplate(environment, alertEmail);
  TEMPLATE_CACHE.set(cacheKey, built);
  return built;
}

function synthTemplate(
  environment: 'dev' | 'prod',
  alertEmail?: string
): Template {
  const cdkContext = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'cdk.context.json'), 'utf8')
  ) as Record<string, unknown>;
  const testVpcKey =
    `vpc-provider:account=${TEST_ACCOUNT}:filter.tag:Name=aistudio-${environment}-vpc` +
    `:region=${REGION}:returnAsymmetricSubnets=true`;
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
      [testVpcKey]: vpcBlob,
      'aws:cdk:bundling-stacks': [],
      agentImageTag: 'test-image-tag',
    },
  });
  const stack = new AgentPlatformStack(
    app,
    `AIStudio-AgentPlatformStack-${environment}`,
    {
      environment,
      config: EnvironmentConfig.get(environment),
      databaseResourceArn: `arn:aws:rds:${REGION}:${TEST_ACCOUNT}:cluster:aistudio-${environment}`,
      databaseSecretArn:
        `arn:aws:secretsmanager:${REGION}:${TEST_ACCOUNT}:secret:aistudio-${environment}-db-AbCdEf`,
      databaseHost: `aistudio-${environment}.cluster-abc.${REGION}.rds.amazonaws.com`,
      databaseName: 'aistudio',
      guardrailArn: `arn:aws:bedrock:${REGION}:${TEST_ACCOUNT}:guardrail/test`,
      guardrailId: 'test-guardrail-id',
      ...(alertEmail ? { alertEmail } : {}),
      appBaseUrl: `https://${environment}.aistudio.psd401.ai`,
      env: { account: TEST_ACCOUNT, region: REGION },
    }
  );
  return Template.fromStack(stack);
}

/** Every alarm in the template, with the SNS targets of its AlarmActions. */
function alarmsWithActions(
  template: Template
): Array<{ name: string; actions: string[] }> {
  const alarms = template.findResources('AWS::CloudWatch::Alarm');
  return Object.entries(alarms).map(([logicalId, body]) => {
    const props = (body as { Properties?: Record<string, unknown> }).Properties ?? {};
    const raw = (props.AlarmActions as unknown[]) ?? [];
    return {
      name: String(props.AlarmName ?? logicalId),
      actions: raw.map(action => JSON.stringify(action)),
    };
  });
}

const SHARED_TOPIC = (environment: string) =>
  `aistudio-${environment}-monitoring-alarms`;

/** Alarms that notify at all, for one environment. */
function notifyingAlarms(
  environment: 'dev' | 'prod',
  alertEmail?: string
): Array<{ name: string; actions: string[] }> {
  return alarmsWithActions(buildTemplate(environment, alertEmail)).filter(
    alarm => alarm.actions.length > 0
  );
}

function reachesSharedTopic(
  alarm: { actions: string[] },
  environment: string
): boolean {
  return alarm.actions.some(action => action.includes(SHARED_TOPIC(environment)));
}

/** Every notifying alarm must reach the topic with a confirmed subscriber. */
function expectAllAlarmsReachSharedTopic(
  environment: 'dev' | 'prod',
  alertEmail?: string
): void {
  const alarms = notifyingAlarms(environment, alertEmail);
  expect(alarms.length).toBeGreaterThan(0);
  const missing = alarms
    .filter(alarm => !reachesSharedTopic(alarm, environment))
    .map(alarm => alarm.name);
  expect(missing).toEqual([]);
}

function routerDlqAlarm(environment: 'dev' | 'prod') {
  return notifyingAlarms(environment, 'alerts@psd401.net').find(
    alarm => alarm.name === `psd-agent-router-dlq-${environment}`
  );
}

describe('agent alarm delivery', () => {
  it('dev: every alarm reaches the shared monitoring topic', () => {
    expectAllAlarmsReachSharedTopic('dev', 'alerts@psd401.net');
  });

  it('prod: every alarm reaches the shared monitoring topic', () => {
    expectAllAlarmsReachSharedTopic('prod', 'alerts@psd401.net');
  });

  // The old code created NO topic without alertEmail, so every
  // `if (agentAlarmTopic)` guard silently skipped its action and the stack
  // deployed alarms that evaluated correctly and notified nobody.
  it('dev: still notifies with no alertEmail configured', () => {
    expectAllAlarmsReachSharedTopic('dev');
  });

  it('prod: still notifies with no alertEmail configured', () => {
    expectAllAlarmsReachSharedTopic('prod');
  });

  it('keeps the dedicated topic as a second target when an address is given', () => {
    const template = buildTemplate('prod', 'alerts@psd401.net');
    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'psd-agent-alarms-prod',
    });
    const dlq = alarmsWithActions(template).find(
      alarm => alarm.name === 'psd-agent-router-dlq-prod'
    );
    expect(dlq).toBeDefined();
    expect(dlq?.actions.length).toBeGreaterThanOrEqual(2);
  });

  it('routes the router DLQ alarm — the one that went unheard for 36 days', () => {
    const dlq = routerDlqAlarm('prod');
    expect(dlq).toBeDefined();
    expect(reachesSharedTopic(dlq!, 'prod')).toBe(true);
  });

  it('watches for its own notification-delivery failures', () => {
    // A publish that fails leaves the alarm in ALARM and tells nobody; this
    // metric is the only trace, so it needs an alarm of its own.
    const template = buildTemplate('prod', 'alerts@psd401.net');
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'psd-agent-alarm-delivery-failures-prod',
      MetricName: 'NumberOfNotificationsFailed',
    });
    const delivery = alarmsWithActions(template).find(
      alarm => alarm.name === 'psd-agent-alarm-delivery-failures-prod'
    );
    expect(delivery).toBeDefined();
    expect(reachesSharedTopic(delivery!, 'prod')).toBe(true);
  });

  it('refuses to wire an alarm before the targets exist', () => {
    // The previous `?? []` made this case a silent no-op: the alarm
    // synthesized, deployed, and notified nobody. Empty can only mean "called
    // too early", because the shared topic is always present, so it must fail
    // at synth rather than in production.
    const stack = new cdk.Stack(new cdk.App(), 'T', {
      env: { account: TEST_ACCOUNT, region: REGION },
    });
    const alarm = new cloudwatch.Alarm(stack, 'A', {
      metric: new cloudwatch.Metric({ namespace: 'X', metricName: 'Y' }),
      threshold: 1,
      evaluationPeriods: 1,
    });
    expect(() =>
      notifyAgentAlarm(alarm, { agentAlarmTargets: [] } as never)
    ).toThrow(/before agentAlarmTargets was populated/);
    expect(() =>
      notifyAgentAlarm(alarm, {} as never)
    ).toThrow(/before agentAlarmTargets was populated/);
  });

  it('passes the AgentCore runtime id to the router without an SSM lookup', () => {
    const fns = buildTemplate('prod', 'alerts@psd401.net').findResources(
      'AWS::Lambda::Function'
    );
    const router = Object.values(fns).find(fn => {
      const env = (
        fn as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } }
      ).Properties?.Environment?.Variables;
      // ROUTER_QUEUE_URL alone also matches the cron Lambda, which publishes to
      // the same queue. TOKEN_LIMIT_PER_INTERACTION is the router's own.
      return (
        env !== undefined &&
        'ROUTER_QUEUE_URL' in env &&
        'TOKEN_LIMIT_PER_INTERACTION' in env
      );
    });
    expect(router).toBeDefined();
    const vars = (
      router as { Properties: { Environment: { Variables: Record<string, unknown> } } }
    ).Properties.Environment.Variables;
    expect(vars).toHaveProperty('AGENTCORE_RUNTIME_ID');
  });
});
