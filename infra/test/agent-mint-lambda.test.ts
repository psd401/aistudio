/**
 * CDK assertion test for the isolated mint Lambda (#1232 confused-deputy
 * hardening).
 *
 * Asserts the security-critical infra invariants IT (Reese) and the blast-radius
 * argument depend on:
 *   1. a dedicated `psd-agent-mint-<env>` Lambda in the VPC (private-with-egress);
 *   2. a STABLE, DETERMINISTIC role name (`psd-agent-mint-execution-role-<env>`)
 *      — the ARN IT points the Google WIF provider + SA principalSet at;
 *   3. that role grants ONLY `secretsmanager:GetSecretValue` on
 *      `psd-agent/<env>/*` (least privilege — WIF itself needs no AWS grant), and
 *      is the role the mint Lambda actually runs as.
 *
 * Synth harness mirrors agent-platform-mcp-key.test.ts: inject a remapped VPC
 * context blob under the test account, force the AgentCore runtime via
 * `agentImageTag`, and disable Lambda asset bundling so the test never runs
 * esbuild / bun install.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AgentPlatformStack } from '../lib/agent-platform-stack';
import { EnvironmentConfig } from '../lib/constructs';

const TEST_ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const ENV = 'dev';
const MINT_FN = `psd-agent-mint-${ENV}`;
const MINT_ROLE_NAME = `psd-agent-mint-execution-role-${ENV}`;

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

interface Statement { Sid?: string; Effect?: string; Action?: unknown; Resource?: unknown }

/** Collect every IAM statement attached to the role with the given RoleName. */
function statementsForRole(template: Template, roleName: string): Statement[] {
  const roles = template.findResources('AWS::IAM::Role');
  const roleEntry = Object.entries(roles).find(
    ([, r]) => (r as { Properties?: { RoleName?: string } }).Properties?.RoleName === roleName
  );
  expect(roleEntry).toBeDefined();
  const [roleLogicalId, role] = roleEntry!;

  const statements: Statement[] = [];
  // Inline policies declared directly on the role.
  const inline = (role as { Properties?: { Policies?: Array<{ PolicyDocument?: { Statement?: Statement[] } }> } })
    .Properties?.Policies ?? [];
  for (const p of inline) {
    if (Array.isArray(p.PolicyDocument?.Statement)) statements.push(...p.PolicyDocument!.Statement!);
  }
  // Standalone AWS::IAM::Policy resources attached to this role.
  for (const policy of Object.values(template.findResources('AWS::IAM::Policy'))) {
    const props = (policy as { Properties?: { Roles?: unknown[]; PolicyDocument?: { Statement?: Statement[] } } }).Properties;
    const rolesRefJson = JSON.stringify(props?.Roles ?? []);
    if (rolesRefJson.includes(roleLogicalId) && Array.isArray(props?.PolicyDocument?.Statement)) {
      statements.push(...props!.PolicyDocument!.Statement!);
    }
  }
  return statements;
}

describe('AgentPlatformStack — isolated mint Lambda (#1232)', () => {
  let template: Template;
  beforeAll(() => {
    template = buildTemplate();
  });

  it('creates the psd-agent-mint-<env> Lambda in the VPC with the DWD config secret id', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: MINT_FN,
      Environment: {
        Variables: {
          GCP_DWD_CONFIG_SECRET_ID: `psd-agent/${ENV}/gcp-dwd-config`,
          ENVIRONMENT: ENV,
        },
      },
    });
    // Runs inside the VPC (private-with-egress) — VpcConfig present.
    const fns = template.findResources('AWS::Lambda::Function');
    const mint = Object.values(fns).find(
      (f) => (f as { Properties?: { FunctionName?: string } }).Properties?.FunctionName === MINT_FN
    ) as { Properties?: { VpcConfig?: unknown; Role?: unknown } } | undefined;
    expect(mint?.Properties?.VpcConfig).toBeDefined();
  });

  it('pins a STABLE, deterministic mint role name (the ARN IT points WIF at)', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: MINT_ROLE_NAME,
    });
  });

  it('the mint Lambda runs AS the mint role (not a shared role)', () => {
    const roles = template.findResources('AWS::IAM::Role');
    const mintRoleId = Object.entries(roles).find(
      ([, r]) => (r as { Properties?: { RoleName?: string } }).Properties?.RoleName === MINT_ROLE_NAME
    )?.[0];
    expect(mintRoleId).toBeDefined();

    const fns = template.findResources('AWS::Lambda::Function');
    const mint = Object.values(fns).find(
      (f) => (f as { Properties?: { FunctionName?: string } }).Properties?.FunctionName === MINT_FN
    ) as { Properties?: { Role?: unknown } } | undefined;
    expect(JSON.stringify(mint?.Properties?.Role)).toContain(mintRoleId!);
  });

  it('the mint role grants ONLY GetSecretValue on psd-agent/<env>/* (least privilege)', () => {
    const statements = statementsForRole(template, MINT_ROLE_NAME);

    // The single data grant: read the gcp-dwd-config secret family.
    const secretStmt = statements.find((s) => s.Sid === 'ReadGcpDwdConfigSecret');
    expect(secretStmt).toBeDefined();
    expect(secretStmt!.Effect).toBe('Allow');
    const actions = Array.isArray(secretStmt!.Action) ? secretStmt!.Action : [secretStmt!.Action];
    expect(actions).toEqual(['secretsmanager:GetSecretValue']);
    expect(JSON.stringify(secretStmt!.Resource)).toContain(`secret:psd-agent/${ENV}/*`);

    // WIF is keyless — the role must NOT carry any IAM-Credentials / signJwt /
    // STS-impersonation grant, and must NOT be able to write secrets or invoke
    // other Lambdas. Assert no statement grants such actions (beyond the factory
    // base logging + x-ray, which are logs:/xray: only).
    const allActions = statements
      .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]))
      .filter((a): a is string => typeof a === 'string');
    const forbidden = allActions.filter((a) =>
      /iam:|sts:|signjwt|secretsmanager:PutSecretValue|lambda:InvokeFunction|bedrock/i.test(a)
    );
    expect(forbidden).toEqual([]);
  });
});
