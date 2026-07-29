/**
 * CloudFormation resource-cycle guard for AgentPlatformStack.
 *
 * A CDK stack can synthesize cleanly and still be rejected by CloudFormation at
 * deploy time with "Circular dependency between resources". `cdk synth` does not
 * detect intra-stack resource cycles, so nothing in the normal build catches
 * them — the failure lands mid-deploy, after asset builds.
 *
 * The regression this guards: `ScheduleTargetBackfill` granted the migration
 * Lambda permission to invoke ITSELF (continuation paging) by referencing
 * `backfill.functionArn`. That emits `Fn::GetAtt` into the role's DefaultPolicy,
 * while CDK independently makes the CfnFunction `DependsOn` that same
 * DefaultPolicy (Function adds a node dependency on its role, which covers the
 * role's child policy). Cycle:
 *
 *   ScheduleTargetBackfillLambda
 *     -> DependsOn -> ScheduleTargetBackfillRoleDefaultPolicy
 *     -> Fn::GetAtt -> ScheduleTargetBackfillLambda
 *
 * The fix formats the self-ARN from the deterministic functionName instead of
 * reading it off the construct. This test asserts the whole template stays
 * acyclic, so the same shape cannot return anywhere in the stack.
 *
 * Synth notes match infra/test/agent-platform-mcp-key.test.ts: the stack imports
 * the shared VPC via `Vpc.fromLookup`, and the AgentCore runtime pins subnets to
 * us-east-1b/1c, so the cached lookup is remapped under a test account. Asset
 * bundling is disabled so the test never runs `bun install`/`tsc`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AgentPlatformStack } from '../lib/agent-platform-stack';
import { EnvironmentConfig } from '../lib/constructs';

const TEST_ACCOUNT = '123456789012';
const REGION = 'us-east-1';

const REAL_VPC_KEY =
  'vpc-provider:account=390844780692:filter.tag:Name=aistudio-dev-vpc:region=us-east-1:returnAsymmetricSubnets=true';

function buildTemplate(environment: 'dev' | 'prod'): Template {
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
      if (subnet.availabilityZone === 'us-east-1a') subnet.availabilityZone = 'us-east-1c';
    }
  }

  const app = new cdk.App({
    context: {
      ...cdkContext,
      [testVpcKey]: vpcBlob,
      'aws:cdk:bundling-stacks': [],
      // The AgentCore runtime is image-gated; force it so the full resource
      // graph — not a reduced one — is what gets checked for cycles.
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
      alertEmail: 'alerts@psd401.net',
      appBaseUrl: `https://${environment}.aistudio.psd401.ai`,
      env: { account: TEST_ACCOUNT, region: REGION },
    }
  );

  return Template.fromStack(stack);
}

type ResourceBody = Record<string, unknown>;

/**
 * The resource names a single intrinsic points at, or null when the key is not
 * a dependency-carrying intrinsic (so the caller keeps recursing into it).
 */
function targetsOfIntrinsic(key: string, value: unknown): string[] | null {
  if (key === 'Ref') {
    return typeof value === 'string' ? [value] : [];
  }
  if (key === 'Fn::GetAtt') {
    const target = Array.isArray(value)
      ? String(value[0])
      : String(value).split('.')[0];
    return [target];
  }
  if (key === 'DependsOn') {
    return ([] as unknown[])
      .concat(value)
      .filter((dep): dep is string => typeof dep === 'string');
  }
  return null;
}

/**
 * Every edge CloudFormation itself honours: explicit `DependsOn` plus the
 * implicit ordering created by `Ref` and `Fn::GetAtt`.
 */
function dependenciesOf(body: unknown, known: Set<string>, into: Set<string>): Set<string> {
  if (body === null || typeof body !== 'object') return into;
  if (Array.isArray(body)) {
    for (const item of body) dependenciesOf(item, known, into);
    return into;
  }
  for (const [key, value] of Object.entries(body as ResourceBody)) {
    const targets = targetsOfIntrinsic(key, value);
    if (targets === null) {
      dependenciesOf(value, known, into);
      continue;
    }
    for (const target of targets) {
      if (known.has(target)) into.add(target);
    }
  }
  return into;
}

/** Returns each cycle as an ordered path, e.g. [A, B, A]. */
function findResourceCycles(template: Template): string[][] {
  const resources = template.toJSON().Resources as Record<string, ResourceBody>;
  const names = new Set(Object.keys(resources));

  const graph = new Map<string, string[]>();
  for (const [name, body] of Object.entries(resources)) {
    const deps = dependenciesOf(body, names, new Set<string>());
    deps.delete(name);
    graph.set(name, [...deps]);
  }

  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>([...names].map((n) => [n, WHITE]));
  const cycles: string[][] = [];

  for (const root of names) {
    if (color.get(root) !== WHITE) continue;
    const stack: Array<[string, string[]]> = [[root, [...(graph.get(root) ?? [])]]];
    const trail: string[] = [root];
    color.set(root, GREY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const next = frame[1].shift();
      if (next === undefined) {
        color.set(frame[0], BLACK);
        stack.pop();
        trail.pop();
        continue;
      }
      const state = color.get(next);
      if (state === GREY) {
        cycles.push([...trail.slice(trail.indexOf(next)), next]);
      } else if (state === WHITE) {
        color.set(next, GREY);
        trail.push(next);
        stack.push([next, [...(graph.get(next) ?? [])]]);
      }
    }
  }

  return cycles;
}

const defineAgentPlatformStackResourceCycleGuard = () => {
  it.each(['dev', 'prod'] as const)(
    'synthesizes %s with no CloudFormation resource cycles',
    (environment) => {
      const cycles = findResourceCycles(buildTemplate(environment));
      expect(cycles.map((cycle) => cycle.join(' -> '))).toEqual([]);
    }
  );

  it('grants the backfill Lambda self-invoke without referencing its own construct', () => {
    const template = buildTemplate('dev');
    const policies = template.findResources('AWS::IAM::Policy');
    const selfInvoke = Object.values(policies)
      .flatMap((policy) => {
        const document = (
          policy as {
            Properties?: {
              PolicyDocument?: { Statement?: Array<Record<string, unknown>> };
            };
          }
        ).Properties?.PolicyDocument;
        return document?.Statement ?? [];
      })
      .filter((statement) => statement.Sid === 'ScheduleTargetBackfillContinue');

    expect(selfInvoke).toHaveLength(1);

    // The ARN must be FORMATTED (a literal, or an Fn::Join over pseudo-params)
    // and must NOT be an Fn::GetAtt on the function — the GetAtt form is
    // precisely what reintroduces the deploy-time cycle. Assert on the shape,
    // not on one rendering: whether `formatArn` collapses to a plain string or
    // an Fn::Join depends on how the partition resolves at synth.
    const serialized = JSON.stringify(selfInvoke[0].Resource);
    expect(serialized).not.toContain('Fn::GetAtt');
    expect(serialized).toContain(
      `:lambda:${REGION}:${TEST_ACCOUNT}:function:psd-agent-schedule-target-backfill-dev`
    );
  });
};

describe(
  'AgentPlatformStack — CloudFormation resource-cycle guard',
  defineAgentPlatformStackResourceCycleGuard
);
