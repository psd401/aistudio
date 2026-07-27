/**
 * CDK assertions for trusted broker credentials and the model-facing
 * AgentCore execution boundary.
 *
 * Asserts the trusted web tier receives the provisioned credentials while the
 * model-facing runtime receives neither secret selectors nor data-plane IAM:
 *   1. a NEW empty secret `psd-agent/<env>/aistudio-mcp-api-key`;
 *   2. a SECOND bootstrap Lambda + custom resource (distinct from the atrium
 *      content-key bootstrap — they must not share a service user), carrying a
 *      per-deploy Nonce and KEY_PROFILE=mcp;
 *   3. no service credential selector or direct S3/DynamoDB/RDS/Secrets Manager
 *      permission reaches AgentCore.
 *
 * Synth notes: the AgentPlatformStack imports the shared VPC via
 * `Vpc.fromLookup(vpcName: aistudio-<env>-vpc)` and the AgentCore runtime pins
 * its subnets to us-east-1b/us-east-1c. The cached lookup only spans 1a/1b, so we
 * inject a VPC context blob remapped to 1b/1c under a test account, and set
 * `agentImageTag` so the (otherwise image-gated) AgentCore runtime — the sole
 * consumer of the runtime env vars — is actually synthesized. Lambda asset
 * bundling is disabled (`aws:cdk:bundling-stacks: []`) so the test never runs
 * `bun install`/`tsc`; Docker image assets are only fingerprinted at synth, not
 * built. Lives in the `infra` jest project (roots: infra/test).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AgentPlatformStack } from '../lib/agent-platform-stack';
import { EnvironmentConfig } from '../lib/constructs';

const TEST_ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const ENV = 'dev';

// The real cached dev VPC lookup (spans 1a/1b). We clone it under the test
// account and remap us-east-1a -> us-east-1c so the AgentCore runtime's
// 1b/1c private-subnet selection resolves to two subnets.
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
      // Skip lambda asset bundling (no bun install / tsc during the test).
      'aws:cdk:bundling-stacks': [],
      // Force the (image-gated) AgentCore runtime so runtimeEnvVars materialize.
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

describe('AgentPlatformStack — AI Studio MCP key provisioning (#1100)', () => {
  let template: Template;

  beforeAll(() => {
    template = buildTemplate();
  });

  it('creates the empty psd-agent/<env>/aistudio-mcp-api-key secret', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: `psd-agent/${ENV}/aistudio-mcp-api-key`,
    });
  });

  it('adds the MCP bootstrap Lambda alongside the atrium content-key bootstrap (two distinct bootstraps)', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: `psd-agent-aistudio-mcp-key-bootstrap-${ENV}`,
    });
    // The atrium bootstrap must still exist — the MCP key is a SECOND instance,
    // not a replacement (they own distinct service users / secrets).
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: `psd-agent-atrium-key-bootstrap-${ENV}`,
    });
  });

  it('wires the MCP bootstrap Lambda with KEY_PROFILE=mcp and its own secret', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: `psd-agent-aistudio-mcp-key-bootstrap-${ENV}`,
      Environment: {
        Variables: {
          KEY_PROFILE: 'mcp',
          SERVICE_USER_COGNITO_SUB: 'service-account:psd-aistudio-agent',
        },
      },
    });
  });

  it('adds a SECOND per-deploy-Nonce key-provisioning custom resource', () => {
    // Both the atrium and MCP provisioners carry a per-deploy `Nonce`; the
    // Bedrock/other custom resources do not. Requiring >= 2 with a Nonce proves
    // the MCP provisioner is a distinct custom resource, not a reused one.
    const customResources = template.findResources('AWS::CloudFormation::CustomResource');
    const withNonce = Object.values(customResources).filter(
      (r) => (r as { Properties?: Record<string, unknown> }).Properties &&
        'Nonce' in (r as { Properties: Record<string, unknown> }).Properties
    );
    expect(withNonce.length).toBeGreaterThanOrEqual(2);
  });

  it('serves the MCP provisioner from the MCP provider (guards against a serviceToken swap)', () => {
    // A copy-paste that pointed AistudioMcpKeyProvisioner at the atrium provider
    // would leave the MCP secret unpopulated (the atrium Lambda no-ops), silently
    // reproducing #1100 with CI green. Pin the ServiceToken to the MCP provider.
    const crs = template.findResources('AWS::CloudFormation::CustomResource');
    const mcpEntry = Object.entries(crs).find(([logicalId]) =>
      logicalId.startsWith('AistudioMcpKeyProvisioner')
    );
    expect(mcpEntry).toBeDefined();
    const serviceToken = JSON.stringify(
      (mcpEntry![1] as { Properties?: { ServiceToken?: unknown } }).Properties?.ServiceToken
    );
    expect(serviceToken).toContain('AistudioMcpKeyProvider');
    expect(serviceToken).not.toContain('AtriumContentKeyProvider');
  });

  it('the two bootstrap Lambdas target DISTINCT service users (no cross-revocation)', () => {
    // The core invariant: replaceActiveKey revokes ALL of a service user's active
    // keys, so a shared user would make the two bootstraps revoke each other.
    const fns = template.findResources('AWS::Lambda::Function');
    const subFor = (fnName: string): unknown => {
      const entry = Object.values(fns).find(
        (f) =>
          (f as { Properties?: { FunctionName?: string } }).Properties?.FunctionName === fnName
      ) as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } } | undefined;
      return entry?.Properties?.Environment?.Variables?.SERVICE_USER_COGNITO_SUB;
    };
    const atriumSub = subFor(`psd-agent-atrium-key-bootstrap-${ENV}`);
    const mcpSub = subFor(`psd-agent-aistudio-mcp-key-bootstrap-${ENV}`);
    expect(atriumSub).toBe('service-account:psd-atrium-agent');
    expect(mcpSub).toBe('service-account:psd-aistudio-agent');
    expect(atriumSub).not.toBe(mcpSub);
  });

  it('scopes the MCP bootstrap role secret access to the MCP secret, not the atrium one', () => {
    // Guards against an IAM-ARN swap between the two near-identical roles.
    interface Statement { Sid?: string; Resource?: unknown }
    const statements: Statement[] = [];
    for (const policy of Object.values(template.findResources('AWS::IAM::Policy'))) {
      const doc = (policy as { Properties?: { PolicyDocument?: { Statement?: Statement[] } } })
        .Properties?.PolicyDocument?.Statement;
      if (Array.isArray(doc)) statements.push(...doc);
    }
    for (const role of Object.values(template.findResources('AWS::IAM::Role'))) {
      const inline = (role as { Properties?: { Policies?: Array<{ PolicyDocument?: { Statement?: Statement[] } }> } })
        .Properties?.Policies ?? [];
      for (const p of inline) {
        if (Array.isArray(p.PolicyDocument?.Statement)) statements.push(...p.PolicyDocument!.Statement!);
      }
    }
    const mcpStmt = statements.find((s) => s.Sid === 'ReadWriteMcpKeySecret');
    expect(mcpStmt).toBeDefined();
    const resourceJson = JSON.stringify(mcpStmt!.Resource);
    expect(resourceJson).toContain('AistudioMcpApiKeySecret');
    expect(resourceJson).not.toContain('AtriumContentApiKeySecret');
  });

  it('does not expose service credentials or data-plane selectors to the runtime', () => {
    const runtimes = template.findResources('AWS::BedrockAgentCore::Runtime');
    expect(Object.keys(runtimes).length).toBe(1);
    const runtime = Object.values(runtimes)[0] as {
      Properties: { EnvironmentVariables: Record<string, unknown> };
    };
    const envVars = runtime.Properties.EnvironmentVariables;
    const forbiddenVariables = [
      'AISTUDIO_MCP_API_KEY_SECRET_ID',
      'AISTUDIO_CONTENT_API_KEY_SECRET_ID',
      'AGENT_GATEWAY_CONFIG_SECRET_ID',
      'CANVA_OAUTH_SECRET_ID',
      'AGENT_INTERNAL_API_KEY_SECRET_ID',
      'AGENT_BEDROCK_API_KEY_SECRET_ID',
      'GOOGLE_OAUTH_CLIENT_SECRET_ID',
      'WORKSPACE_BUCKET',
      'USERS_TABLE',
      'SIGNALS_TABLE',
      'TRIAGE_TABLE',
      'DB_CLUSTER_ARN',
      'DB_SECRET_ARN',
    ];
    for (const variable of forbiddenVariables) {
      expect(envVars).not.toHaveProperty(variable);
    }
  });

  it('denies AgentCore direct access to service secrets and application data planes', () => {
    interface Statement {
      Action?: string | string[];
      Effect?: string;
      Resource?: unknown;
      Sid?: string;
    }

    const roles = template.findResources('AWS::IAM::Role');
    const roleEntry = Object.entries(roles).find(
      ([, role]) =>
        (role as { Properties?: { RoleName?: string } }).Properties?.RoleName
          === `psd-agentcore-execution-${ENV}`
    );
    expect(roleEntry).toBeDefined();
    const [roleLogicalId, roleResource] = roleEntry!;
    const statements: Statement[] = [];
    const inlinePolicies = (
      roleResource as {
        Properties?: {
          Policies?: Array<{ PolicyDocument?: { Statement?: Statement[] } }>;
        };
      }
    ).Properties?.Policies ?? [];
    for (const policy of inlinePolicies) {
      if (Array.isArray(policy.PolicyDocument?.Statement)) {
        statements.push(...policy.PolicyDocument.Statement);
      }
    }

    for (const policy of Object.values(template.findResources('AWS::IAM::Policy'))) {
      const properties = (
        policy as {
          Properties?: {
            PolicyDocument?: { Statement?: Statement[] };
            Roles?: unknown[];
          };
        }
      ).Properties;
      if (
        (JSON.stringify(properties?.Roles) ?? '').includes(roleLogicalId)
        && Array.isArray(properties?.PolicyDocument?.Statement)
      ) {
        statements.push(...properties.PolicyDocument.Statement);
      }
    }

    const allowedActions = statements
      .filter((statement) => statement.Effect === 'Allow')
      .flatMap((statement) =>
        Array.isArray(statement.Action) ? statement.Action : [statement.Action]
      )
      .filter((action): action is string => typeof action === 'string');

    for (const servicePrefix of ['s3:', 'dynamodb:', 'rds-data:', 'secretsmanager:']) {
      expect(allowedActions.some((action) => action.startsWith(servicePrefix))).toBe(false);
    }

    const directModelInvocations = statements.filter((statement) => {
      const actions = Array.isArray(statement.Action)
        ? statement.Action
        : [statement.Action];
      return statement.Effect === 'Allow' && actions.includes('bedrock:InvokeModel');
    });
    expect(directModelInvocations).toHaveLength(1);
    expect(directModelInvocations[0].Sid).toBe('BedrockMemoryEmbeddingOnly');
    expect(JSON.stringify(directModelInvocations[0].Resource))
      .toContain('amazon.titan-embed-text-v2:0');
  });

  it('keeps the signing-secret deny as defense in depth', () => {
    interface Statement {
      Action?: string | string[];
      Effect?: string;
      Sid?: string;
    }
    const policies = template.findResources('AWS::IAM::Policy');
    const statements = Object.values(policies).flatMap((policy) => {
      const document = (
        policy as { Properties?: { PolicyDocument?: { Statement?: Statement[] } } }
      ).Properties?.PolicyDocument;
      return document?.Statement ?? [];
    });
    expect(statements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Sid: 'DenyInvocationSigningSecret',
        Effect: 'Deny',
        Action: 'secretsmanager:GetSecretValue',
      }),
    ]));
  });
});
