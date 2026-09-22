import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as customResources from 'aws-cdk-lib/custom-resources';
import { EcsServiceConstruct } from './constructs/ecs-service';
import { VPCProvider, EnvironmentConfig } from './constructs';
import { ServiceRoleFactory } from './constructs/security';

export interface FrontendStackEcsProps extends cdk.StackProps {
  environment: 'dev' | 'prod';
  baseDomain: string;
  /**
   * Custom subdomain to use instead of environment-based default.
   * For example: 'dev-ecs' will create 'dev-ecs.aistudio.psd401.ai'
   * If not provided, defaults to 'dev' for dev or root domain for prod
   */
  customSubdomain?: string;
  documentsBucketName?: string; // Optional for backward compatibility
  agentWorkspaceBucketName?: string; // Optional for backward compatibility (#925)
  atriumSandboxOrigin?: string; // Optional; falls back to SSM (#1052)
  /**
   * Atrium artifact sandbox CDN allowlist (#1750) — the comma-separated origin
   * list ALSO baked into the sandbox host's CSP `script-src`/`style-src` by
   * AtriumSandboxStack. Injected as `ATRIUM_ALLOWED_ARTIFACT_CDNS` so the app
   * can tell every artifact author (Nexus chat, the MCP content tools) exactly
   * which origins a `<script src>` may use. Both sides read the same CDK
   * context key, so the guidance can never drift from the enforced CSP.
   */
  atriumAllowedArtifactCdns?: string;
  atriumEventsTopicArn?: string; // Optional; SNS topic for content events (#1055)
  /**
   * Agent-platform migration Lambda. When supplied, this stack invokes it only
   * after the lock-aware frontend ECS service has completed its deployment.
   */
  scheduleTargetBackfillFunction?: lambda.IFunction;
  /**
   * If true, will look up existing VPC from database stack.
   * If false, will create a new VPC for ECS (not recommended - prefer VPC sharing)
   */
  useExistingVpc?: boolean;
  /**
   * If false, skip DNS and certificate setup.
   * Useful for CI/CD validation where hosted zones don't exist.
   */
  setupDns?: boolean;
}

/**
 * ECS Fargate-based frontend stack for AI Studio.
 * Replaces Amplify hosting with containerized Next.js deployment
 * for native HTTP/2 streaming support.
 */
export class FrontendStackEcs extends cdk.Stack {
  public readonly ecsService: EcsServiceConstruct;

  constructor(scope: Construct, id: string, props: FrontendStackEcsProps) {
    super(scope, id, props);

    const { environment, baseDomain } = props;

    // Get environment configuration
    const config = EnvironmentConfig.get(environment);

    // ============================================================================
    // Use shared VPC (VPC consolidation pattern)
    // ============================================================================
    // Uses VPCProvider to get or create the shared VPC
    // This consolidates networking infrastructure and reduces costs:
    // - Eliminates duplicate NAT gateways (saves $45-90/month)
    // - Shared VPC endpoints reduce data transfer costs
    // - Simplified network management and security
    const vpc = VPCProvider.getOrCreate(this, environment, config);

    // Retrieve bucket name from SSM Parameter Store
    const documentsBucketName = props.documentsBucketName ||
      ssm.StringParameter.valueForStringParameter(
        this, `/aistudio/${environment}/documents-bucket-name`
      );

    // Agent workspace bucket (#925) — prefer the cross-stack prop from
    // AgentPlatformStack; fall back to the SSM param for backward compatibility
    // / partial deploys, mirroring documentsBucketName above.
    const agentWorkspaceBucketName = props.agentWorkspaceBucketName ||
      ssm.StringParameter.valueForStringParameter(
        this, `/aistudio/${environment}/agent-workspace-bucket-name`
      );

    // Atrium artifact sandbox origin (#1052) — prefer the cross-stack prop from
    // AtriumSandboxStack; fall back to the SSM param it publishes, mirroring
    // documentsBucketName above. Injected into the task as ATRIUM_SANDBOX_ORIGIN
    // so the app never needs a hand-set or build-time origin value.
    const atriumSandboxOrigin = props.atriumSandboxOrigin ||
      ssm.StringParameter.valueForStringParameter(
        this, `/aistudio/${environment}/atrium-sandbox-origin`
      );

    // Atrium content events SNS topic ARN (#1055) — prefer the cross-stack prop
    // from AtriumEventsStack; fall back to the SSM param it publishes. Injected
    // as ATRIUM_EVENTS_TOPIC_ARN; the app's events publisher no-ops if unset.
    const atriumEventsTopicArn = props.atriumEventsTopicArn ||
      ssm.StringParameter.valueForStringParameter(
        this, `/aistudio/${environment}/atrium-events-topic-arn`
      );

    // ============================================================================
    // DNS and SSL Certificate Configuration
    // ============================================================================
    // Build the full domain name
    // If customSubdomain provided, use it (e.g., 'dev-ecs' -> 'dev-ecs.aistudio.psd401.ai')
    // Otherwise use environment-based default ('dev' -> 'dev.aistudio.psd401.ai')
    const subdomain = props.customSubdomain
      ? `${props.customSubdomain}.${baseDomain}`
      : (environment === 'dev' ? `dev.${baseDomain}` : baseDomain);

    const { collabJwtSecret, guardrailHashSecret, oidcCookieSecret } =
      this.createApplicationSecrets(environment);

    const { oidcSigningJwksSecret, oidcKeyBootstrapResource } =
      this.createOidcSigningResources(environment);

    this.createMcpTokenEncryptionKey(environment);

    // ============================================================================
    // Create ECS Service with ALB
    // ============================================================================
    this.ecsService = new EcsServiceConstruct(this, 'EcsService', {
      vpc,
      environment,
      documentsBucketName,
      agentWorkspaceBucketName,
      atriumSandboxOrigin,
      atriumAllowedArtifactCdns: props.atriumAllowedArtifactCdns ?? '',
      atriumEventsTopicArn,
      enableContainerInsights: true,
      enableFargateSpot: true, // Enable Fargate Spot for cost optimization
      spotRatio: environment === 'prod' ? 50 : 100, // 50% Spot in prod, 100% in dev
      enableScheduledScaling: environment === 'prod', // Scheduled scaling for production
      createHttpListener: false, // We'll create HTTP listener with redirect below
      // Docker image configuration
      dockerImageSource: 'fromAsset', // CDK builds and pushes image automatically
      dockerfilePath: '../', // Dockerfile in project root
      // Auth configuration from Cognito stack outputs
      authUrl: `https://${subdomain}`,
      cognitoClientId: cdk.Fn.importValue(`${environment}-CognitoUserPoolClientId`),
      cognitoIssuer: `https://cognito-idp.${this.region}.amazonaws.com/${cdk.Fn.importValue(`${environment}-CognitoUserPoolId`)}`,
      // Database configuration from SSM parameters
      rdsResourceArn: ssm.StringParameter.valueForStringParameter(this, `/aistudio/${environment}/db-cluster-arn`),
      rdsSecretArn: ssm.StringParameter.valueForStringParameter(this, `/aistudio/${environment}/db-secret-arn`),
      // Auth secret from Secrets Manager
      authSecretArn: cdk.Fn.importValue(`${environment}-AuthSecretArn`),
      // Atrium collab token signing secret (#1051, created above)
      collabJwtSecretArn: collabJwtSecret.secretArn,
      // Guardrail violation-log hash secret (#727, created above)
      guardrailHashSecretArn: guardrailHashSecret.secretArn,
      // Dedicated oidc-provider cookie key (created above)
      oidcCookieSecretArn: oidcCookieSecret.secretArn,
      // OIDC-only signing key set (#1285, created and bootstrapped above)
      oidcSigningJwksSecretArn: oidcSigningJwksSecret.secretArn,
      // K-12 Content Safety: Guardrails resources from GuardrailsStack
      // These enable precise IAM scoping for Bedrock and SNS.
      guardrailArn: cdk.Fn.importValue(`${environment}-GuardrailArn`),
      violationTopicArn: cdk.Fn.importValue(`${environment}-ViolationTopicArn`),
    });
    this.ecsService.node.addDependency(oidcKeyBootstrapResource);
    if (props.scheduleTargetBackfillFunction) {
      this.createScheduleTargetBackfillTrigger(
        props.scheduleTargetBackfillFunction,
      );
    }

    this.configureDns(props, baseDomain, subdomain);

    const webAcl = this.configureWebApplicationFirewall(environment);

    this.configureOutputs(environment, subdomain, webAcl);

  }
  private createApplicationSecrets(environment: 'dev' | 'prod'): {
    collabJwtSecret: secretsmanager.Secret;
    guardrailHashSecret: secretsmanager.Secret;
    oidcCookieSecret: secretsmanager.Secret;
  } {
    // ============================================================================
    // Atrium Collab Token Signing Secret (#1051)
    // ============================================================================
    // Dedicated HS256 signing key for Atrium collab session tokens. These tokens
    // ride in the collaboration websocket URL (?token=...) and therefore land in
    // ALB access logs and any reverse proxy logs — unlike NextAuth session
    // cookies, which are HttpOnly and never appear in a URL. Keeping this key
    // separate from AUTH_SECRET means an AUTH_SECRET leak cannot be used to forge
    // collab tokens with arbitrary oid/write claims. Read by lib/content/collab/
    // collab-token.ts. Injected as the COLLAB_JWT_SECRET env var below.
    const collabJwtSecret = new secretsmanager.Secret(this, 'CollabJwtSecret', {
      secretName: `aistudio-${environment}-collab-jwt-secret`,
      description: 'Atrium collab token signing secret (kept separate from AUTH_SECRET)',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'COLLAB_JWT_SECRET',
        excludePunctuation: true,
        passwordLength: 32,
      },
      removalPolicy: environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ============================================================================
    // Guardrail Violation-Log Hash Secret (Issue #727 / chat outage 2026-07-06)
    // ============================================================================
    // HMAC key for pseudonymizing session/user ids in guardrail-violation logs
    // (lib/safety/bedrock-guardrails-service.ts hashValue). Without a configured
    // secret the app REFUSES to hash and logs a fixed 'redacted' placeholder —
    // private but uncorrelatable, so per-student violation triage needs this set.
    // A missing secret briefly took down every Nexus chat request when the app
    // treated it as a production startup error; the secret is now provisioned
    // here so real per-session hashing works, and the app degrades gracefully if
    // it ever goes missing again. Injected as GUARDRAIL_HASH_SECRET below.
    const guardrailHashSecret = new secretsmanager.Secret(this, 'GuardrailHashSecret', {
      secretName: `aistudio-${environment}-guardrail-hash-secret`,
      description: 'HMAC key for pseudonymizing ids in guardrail violation logs',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'GUARDRAIL_HASH_SECRET',
        excludePunctuation: true,
        passwordLength: 32,
      },
      removalPolicy: environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ============================================================================
    // OIDC Provider Cookie Secret (#1285 deployment readiness)
    // ============================================================================
    // oidc-provider encrypts/signs its own interaction, session, and state
    // cookies. Keep this key separate from AUTH_SECRET so a NextAuth session-key
    // compromise does not extend to the OAuth provider. The value is injected
    // into ECS at task start; operators never need to hand-configure it.
    const oidcCookieSecret = new secretsmanager.Secret(this, 'OidcCookieSecret', {
      secretName: `aistudio/${environment}/oauth/oidc-cookie-secret`,
      description: 'Dedicated oidc-provider cookie encryption and signing secret',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'OIDC_COOKIE_SECRET',
        excludePunctuation: true,
        passwordLength: 32,
      },
      removalPolicy: environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    cdk.Tags.of(oidcCookieSecret).add('Environment', environment);
    cdk.Tags.of(oidcCookieSecret).add('ManagedBy', 'cdk');

    return { collabJwtSecret, guardrailHashSecret, oidcCookieSecret };
  }

  private createOidcSigningResources(environment: 'dev' | 'prod'): {
    oidcSigningJwksSecret: secretsmanager.Secret;
    oidcKeyBootstrapResource: cdk.CustomResource;
  } {
    // ============================================================================
    // OIDC Signing JWK Set (#1285)
    // ============================================================================
    // oidc-provider needs private JWK material at its JOSE boundary, while the
    // application/delegated-token signer remains non-exportable KMS. This
    // dedicated encrypted secret is shared by every task and initialized once
    // by a least-privilege custom resource. The bootstrap never overwrites an
    // initialized key set, so deployments and task restarts do not rotate keys.
    const oidcSigningJwksSecret = new secretsmanager.Secret(
      this,
      'OidcSigningJwksSecret',
      {
        secretName: `aistudio/${environment}/oauth/oidc-signing-jwks`,
        description:
          'Exportable OIDC-only RSA JWK set; separate from the application KMS signer',
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ version: 0 }),
          generateStringKey: 'bootstrap',
          excludePunctuation: true,
          passwordLength: 32,
        },
        removalPolicy:
          environment === 'prod'
            ? cdk.RemovalPolicy.RETAIN
            : cdk.RemovalPolicy.DESTROY,
      }
    );
    cdk.Tags.of(oidcSigningJwksSecret).add('Environment', environment);
    cdk.Tags.of(oidcSigningJwksSecret).add('ManagedBy', 'cdk');

    const oidcBootstrapFunctionName = `aistudio-oidc-key-bootstrap-${environment}`;
    const oidcBootstrapRole = ServiceRoleFactory.createLambdaRole(
      this,
      'OidcKeyBootstrapRole',
      {
        functionName: oidcBootstrapFunctionName,
        environment,
        region: this.region,
        account: this.account,
        secrets: [{ arn: oidcSigningJwksSecret.secretArn }],
        additionalPolicies: [
          new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                actions: ['secretsmanager:PutSecretValue'],
                resources: [oidcSigningJwksSecret.secretArn],
              }),
            ],
          }),
        ],
        // The account boundary intentionally permits only secret reads. This
        // one-shot bootstrap role needs exact-ARN PutSecretValue.
        enablePermissionBoundary: false,
      }
    );
    const oidcKeyBootstrap = new lambda.Function(
      this,
      'OidcKeyBootstrapFunction',
      {
        functionName: oidcBootstrapFunctionName,
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'index.handler',
        code: lambda.Code.fromAsset('lambdas/oidc-key-bootstrap'),
        role: oidcBootstrapRole,
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
      }
    );
    const oidcKeyBootstrapResource = new cdk.CustomResource(
      this,
      'OidcKeyBootstrap',
      {
        serviceToken: oidcKeyBootstrap.functionArn,
        properties: {
          SecretId: oidcSigningJwksSecret.secretArn,
          // AWS::CloudFormation::CustomResource has no standard Tags property.
          // Carry the same governance metadata in its provider properties.
          Environment: environment,
          ManagedBy: 'cdk',
        },
      }
    );
    cdk.Tags.of(oidcKeyBootstrap).add('Environment', environment);
    cdk.Tags.of(oidcKeyBootstrap).add('ManagedBy', 'cdk');
    oidcKeyBootstrapResource.node.addDependency(oidcSigningJwksSecret);

    return { oidcSigningJwksSecret, oidcKeyBootstrapResource };
  }

  private createMcpTokenEncryptionKey(environment: 'dev' | 'prod'): void {
    // ============================================================================
    // MCP Token Encryption Key (AES-256-GCM DEK)
    // ============================================================================
    // Random 64-character alphanumeric password used as HKDF input key material.
    // The token-encryption module derives the actual 32-byte AES key via HKDF-SHA-256.
    // ECS task role has wildcard access to aistudio/{env}/* secrets (ecs-service.ts:257).
    //
    // ROTATION WARNING: Do NOT enable automatic rotation on this secret.
    // Rotating the secret value will make all existing encrypted tokens in
    // nexus_mcp_user_tokens unreadable (AES-GCM auth tag verification will fail).
    // Key versioning (ver/kid in payload) must be implemented first, along with
    // a re-encryption migration script. See lib/crypto/token-encryption.ts module doc.
    // See: lib/crypto/token-encryption.ts, Issue #777
    new secretsmanager.Secret(this, 'McpTokenEncryptionKey', {
      secretName: `aistudio/${environment}/mcp/token-encryption-key`,
      description: 'AES-256-GCM data encryption key for MCP connector OAuth tokens',
      generateSecretString: {
        excludePunctuation: true,
        includeSpace: false,
        passwordLength: 64,
      },
      removalPolicy: environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
  }

  private configureDns(
    props: FrontendStackEcsProps,
    baseDomain: string,
    subdomain: string
  ): void {
    // ============================================================================
    // DNS and SSL Certificate
    // ============================================================================

    if (props.setupDns !== false) {

      // Look up hosted zone - need to find the parent zone (psd401.ai)
      // baseDomain might be 'aistudio.psd401.ai', so we need to extract 'psd401.ai'
      const zoneDomain = baseDomain.includes('.')
        ? baseDomain.split('.').slice(-2).join('.') // Extract 'psd401.ai' from 'aistudio.psd401.ai'
        : baseDomain; // If no subdomain, use as-is

      const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
        domainName: zoneDomain,
      });

      // Create SSL certificate
      const certificate = new acm.Certificate(this, 'Certificate', {
        domainName: subdomain,
        validation: acm.CertificateValidation.fromDns(hostedZone),
      });

      // Add HTTPS listener with certificate
      this.ecsService.loadBalancer.addListener('HttpsListener', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [certificate],
        defaultTargetGroups: [this.ecsService.targetGroup],
      });

      // Create HTTP listener that redirects to HTTPS
      this.ecsService.loadBalancer.addListener('HttpListener', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultAction: elbv2.ListenerAction.redirect({
          protocol: 'HTTPS',
          port: '443',
          permanent: true,
        }),
      });

      // Create DNS record pointing to ALB
      new route53.ARecord(this, 'AliasRecord', {
        zone: hostedZone,
        recordName: subdomain,
        target: route53.RecordTarget.fromAlias(
          new targets.LoadBalancerTarget(this.ecsService.loadBalancer)
        ),
      });
    } else {
      // No DNS setup - create HTTP listener only for development/CI
      this.ecsService.loadBalancer.addListener('HttpListener', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultTargetGroups: [this.ecsService.targetGroup],
      });
    }
  }

  /**
   * Phase two of the schedule-target rollout. AgentPlatformStack deploys the
   * migration Lambda first; this trigger is created only after CloudFormation
   * has brought the new lock-aware frontend service to steady state.
   */
  private createScheduleTargetBackfillTrigger(
    backfill: lambda.IFunction,
  ): void {
    const migrationVersion = 'legacy-schedule-records-and-targets-v4';
    const invocation = {
      service: 'Lambda',
      action: 'invoke',
      parameters: {
        FunctionName: backfill.functionName,
        // A full group can take longer than the custom-resource provider's
        // synchronous SDK timeout. Let Lambda's configured async retries,
        // DLQ, and internal IAM-propagation backoff supervise the migration
        // after acceptance.
        InvocationType: 'Event',
        Payload: JSON.stringify({
          RequestType: 'Create',
          phase: 'records',
          migrationVersion,
        }),
      },
      physicalResourceId: customResources.PhysicalResourceId.of(
        `agent-schedule-target-backfill-${migrationVersion}`,
      ),
    };
    const trigger = new customResources.AwsCustomResource(
      this,
      'ScheduleTargetBackfillAfterFrontend',
      {
        onCreate: invocation,
        // The v3 trigger already exists in deployed stacks. An explicit update
        // hook guarantees this version is freshly invoked instead of relying
        // on create-only custom-resource behavior.
        onUpdate: invocation,
        policy: customResources.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['lambda:InvokeFunction'],
            resources: [backfill.functionArn],
          }),
        ]),
        installLatestAwsSdk: false,
      },
    );
    trigger.node.addDependency(this.ecsService.service);
  }

  private configureWebApplicationFirewall(
    environment: 'dev' | 'prod'
  ): wafv2.CfnWebACL {
    // ============================================================================
    // AWS WAF for Application Protection
    // ============================================================================
    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      scope: 'REGIONAL', // ALB uses REGIONAL, CloudFront uses CLOUDFRONT
      defaultAction: { allow: {} },
      description: `WAF for AIStudio ${environment} environment`,
      rules: buildWebAclRules(),
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: `EcsWAF-${environment}`,
      },
      customResponseBodies: {
        RateLimitBody: {
          contentType: 'APPLICATION_JSON',
          content: '{"error": "Too many requests. Please try again later."}',
        },
      },
    });

    // Associate WAF with ALB
    new wafv2.CfnWebACLAssociation(this, 'WebAclAssociation', {
      resourceArn: this.ecsService.loadBalancer.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    });

    // Full WAF logging to CloudWatch Logs. Until 2026-09-22 the only record of
    // a block was the per-rule metric plus `get-sampled-requests`, which keeps
    // three hours and never shows the body — so a user's "HTTP 403" report
    // from the morning could not be attributed by the afternoon. The log
    // carries the terminating rule, every label the managed groups added
    // (including the counted body signatures), the URI, headers and client
    // IP. Cookie and Authorization headers are redacted; WAF never logs
    // request bodies. WAF requires the log-group name to start with
    // `aws-waf-logs-`, and rejects the `:*` suffix CDK appends to log-group
    // ARNs, hence the split.
    const wafLogGroup = new logs.LogGroup(this, 'WebAclLogGroup', {
      logGroupName: `aws-waf-logs-aistudio-${environment}`,
      retention: environment === 'prod'
        ? logs.RetentionDays.ONE_MONTH
        : logs.RetentionDays.ONE_WEEK,
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });
    new wafv2.CfnLoggingConfiguration(this, 'WebAclLogging', {
      resourceArn: webAcl.attrArn,
      logDestinationConfigs: [
        cdk.Fn.select(0, cdk.Fn.split(':*', wafLogGroup.logGroupArn)),
      ],
      redactedFields: [
        { singleHeader: { Name: 'authorization' } },
        { singleHeader: { Name: 'cookie' } },
      ],
    });

    return webAcl;
  }

  private configureOutputs(
    environment: 'dev' | 'prod',
    subdomain: string,
    webAcl: wafv2.CfnWebACL
  ): void {
    // ============================================================================
    // Outputs (ECS-related outputs are in the construct, only add stack-specific ones here)
    // ============================================================================
    new cdk.CfnOutput(this, 'ApplicationUrl', {
      value: `https://${subdomain}`,
      description: 'Application URL',
      exportName: `${environment}-ecs-ApplicationUrl`,
    });

    new cdk.CfnOutput(this, 'WAFArn', {
      value: webAcl.attrArn,
      description: 'WAF WebACL ARN',
      exportName: `${environment}-ecs-WAFArn`,
    });


    // ============================================================================
    // Deployment Information
    // ============================================================================
    // Note: With ContainerImage.fromAsset(), CDK automatically builds and pushes
    // the Docker image during deployment. No manual Docker commands required!
    new cdk.CfnOutput(this, 'DeploymentInfo', {
      value: [
        '=== ECS Deployment ===',
        `CDK automatically builds and pushes Docker images during deployment.`,
        ``,
        `To deploy updates:`,
        `  cd infra && bunx cdk deploy ${this.stackName}`,
        ``,
        `To monitor deployment:`,
        `  aws ecs describe-services --cluster ${this.ecsService.cluster.clusterName} --services ${this.ecsService.service.serviceName}`,
        ``,
        `To view logs:`,
        `  aws logs tail /ecs/aistudio-${environment} --follow`,
        ``,
        `Application URL:`,
        `  https://${subdomain}`,
      ].join('\n'),
      description: 'ECS deployment information',
    });
  }

}

/**
 * Request paths whose BODY is authenticated AI traffic rather than a form
 * post: Nexus chat (the whole conversation, re-sent every turn, including
 * tool results and model output) and the agent runtime's server-to-server
 * calls (model proxy, credentials, workspace storage — proxy-signed, see the
 * rate-limit rule). The managed body-inspection signatures are COUNTED, not
 * blocked, on these paths; see BODY_SIGNATURE_RULES.
 */
export const NEXUS_CHAT_PREFIX = '/api/nexus/chat';
export const AGENT_API_PREFIX = '/api/agent/';
export const AI_BODY_PATH_PREFIXES = [NEXUS_CHAT_PREFIX, AGENT_API_PREFIX] as const;

/**
 * Every managed rule that inspects the request body, per rule group, with the
 * namespace of the label it adds. Names come from
 * `aws wafv2 describe-managed-rule-group` (2026-09-22); the label is the rule
 * name with `_BODY` written `_Body`, e.g.
 * `awswaf:managed:aws:core-rule-set:CrossSiteScripting_Body`.
 *
 * Why not just exclude these rules on the AI paths with a scope-down? A
 * managed rule group cannot be scoped per rule, and running a second copy of
 * each group for the AI paths costs its full capacity again (Core alone is
 * 700 WCU; the ACL sits at ~1,100 of the 1,500 WCU included before
 * surcharges). The documented alternative is the label pattern used here: each
 * group runs once for everyone with its body rules set to COUNT (they still
 * add their labels and keep their per-rule metrics), and one cheap custom rule
 * after the groups BLOCKS on those labels for every path that is NOT an AI
 * body path. Net effect: identical blocking everywhere else, counting only on
 * the AI paths, and the per-signature metric survives so false positives on
 * real conversations stay visible.
 *
 * Context: on 2026-09-22 `CrossSiteScripting_BODY` blocked every follow-up in
 * a Nexus conversation whose history carried Gemini Google Search grounding
 * HTML (`search_suggestions: "<style>…"`) with a bare 403 that never reached
 * the app, and `SQLi_BODY` blocked the agent runtime's
 * `POST /api/agent/credentials` during scheduled morning briefs. Same rule
 * family as the Atrium artifact block fixed in #1199.
 */
export const BODY_SIGNATURE_RULES = {
  // AWSManagedRulesCommonRuleSet
  core: {
    labelNamespace: 'awswaf:managed:aws:core-rule-set:',
    rules: ['CrossSiteScripting_BODY', 'GenericLFI_BODY', 'EC2MetaDataSSRF_BODY'],
  },
  // AWSManagedRulesKnownBadInputsRuleSet
  knownBadInputs: {
    labelNamespace: 'awswaf:managed:aws:known-bad-inputs:',
    rules: ['JavaDeserializationRCE_BODY', 'Log4JRCE_BODY', 'ReactJSRCE_BODY'],
  },
  // AWSManagedRulesSQLiRuleSet
  sqli: {
    labelNamespace: 'awswaf:managed:aws:sql-database:',
    rules: ['SQLi_BODY'],
  },
} as const;

/**
 * Core rules that have been COUNT-only everywhere since the WAF was added
 * (#306): the 8 KB body cap breaks every upload, and the RFI body check fires
 * on ordinary AI prompts. They are NOT re-blocked by BodySignaturesBlock.
 */
export const ALWAYS_COUNTED_CORE_RULES = ['SizeRestrictions_BODY', 'GenericRFI_BODY'] as const;

/** The label a managed body rule adds when it matches, e.g. `…:SQLi_Body`. */
export function bodySignatureLabel(labelNamespace: string, ruleName: string): string {
  return `${labelNamespace}${ruleName.replace(/_BODY$/, '_Body')}`;
}

/** Every label BodySignaturesBlock blocks on, in rule-group order. */
export function bodySignatureLabels(): string[] {
  return Object.values(BODY_SIGNATURE_RULES).flatMap((group) =>
    group.rules.map((rule) => bodySignatureLabel(group.labelNamespace, rule))
  );
}

/** URI path starts with `prefix` (no text transformation). */
function pathPrefixStatement(prefix: string): wafv2.CfnWebACL.StatementProperty {
  return {
    byteMatchStatement: {
      fieldToMatch: { uriPath: {} },
      positionalConstraint: 'STARTS_WITH',
      searchString: prefix,
      textTransformations: [{ priority: 0, type: 'NONE' }],
    },
  };
}

function countOverrides(
  ruleNames: readonly string[]
): wafv2.CfnWebACL.RuleActionOverrideProperty[] {
  return ruleNames.map((name) => ({ name, actionToUse: { count: {} } }));
}

/**
 * The ALB WebACL rule list. Kept as a pure function (no stack state) so the
 * rule shape can be asserted in `infra/test/frontend-waf-body-signatures.test.ts`
 * without synthesizing the whole frontend stack.
 */
export function buildWebAclRules(): wafv2.CfnWebACL.RuleProperty[] {
  return [
    // Per-IP rate limiting for BROWSER traffic.
    //
    // scopeDownStatement excludes /api/agent/* — server-to-server calls
    // from the agent runtime. Those arrive from a handful of NAT egress
    // IPs, so a per-IP browser budget counts an entire fleet as one
    // client. #1353 routed every agent LLM call through
    // /api/agent/model-proxy, and an agentic turn makes many calls per
    // user message; on 2026-07-27 that produced 4,849 blocked requests in
    // a single 5-minute window and the dev agent could not answer at all.
    // The rule itself (added #306, 2025-10-03) is unchanged and still
    // correct for the browser traffic it was written for.
    //
    // Excluding this prefix does not remove authentication: /api/agent/*
    // is gated by a proxy-signed invocation context
    // (verifyAgentInvocationContext) and, in the deployed runtime, by the
    // Cedar egress allowlist. The WAF was never what protected it.
    {
      name: 'RateLimitRule',
      priority: 1,
      statement: {
        rateBasedStatement: {
          limit: 2000, // 2000 requests per 5 minutes per IP
          aggregateKeyType: 'IP',
          // Written out literally (not via pathPrefixStatement) because
          // tests/unit/waf-agent-api-scope-down.test.ts asserts on this
          // exact source text; root CI runs that test, not the infra suite.
          scopeDownStatement: {
            notStatement: {
              statement: {
                byteMatchStatement: {
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: 'STARTS_WITH',
                  searchString: '/api/agent/',
                  textTransformations: [
                    { priority: 0, type: 'NONE' },
                  ],
                },
              },
            },
          },
        },
      },
      action: {
        block: {
          customResponse: {
            responseCode: 429,
            customResponseBodyKey: 'RateLimitBody',
          },
        },
      },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'RateLimitRule',
      },
    },
    // AWS Managed Core Rule Set. Its body rules are COUNT here and re-blocked
    // outside the AI paths by BodySignaturesBlock below (see
    // BODY_SIGNATURE_RULES for why).
    {
      name: 'AWSManagedRulesCommonRuleSet',
      priority: 2,
      overrideAction: { none: {} },
      statement: {
        managedRuleGroupStatement: {
          vendorName: 'AWS',
          name: 'AWSManagedRulesCommonRuleSet',
          ruleActionOverrides: countOverrides([
            ...ALWAYS_COUNTED_CORE_RULES,
            ...BODY_SIGNATURE_RULES.core.rules,
          ]),
        },
      },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'CommonRuleSet',
      },
    },
    // Known bad inputs (same body-rule treatment).
    {
      name: 'AWSManagedRulesKnownBadInputsRuleSet',
      priority: 3,
      overrideAction: { none: {} },
      statement: {
        managedRuleGroupStatement: {
          vendorName: 'AWS',
          name: 'AWSManagedRulesKnownBadInputsRuleSet',
          ruleActionOverrides: countOverrides(
            BODY_SIGNATURE_RULES.knownBadInputs.rules
          ),
        },
      },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'KnownBadInputs',
      },
    },
    // SQL injection protection (same body-rule treatment).
    {
      name: 'AWSManagedRulesSQLiRuleSet',
      priority: 4,
      overrideAction: { none: {} },
      statement: {
        managedRuleGroupStatement: {
          vendorName: 'AWS',
          name: 'AWSManagedRulesSQLiRuleSet',
          ruleActionOverrides: countOverrides(
            BODY_SIGNATURE_RULES.sqli.rules
          ),
        },
      },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'SQLiRuleSet',
      },
    },
    // Re-apply the counted body signatures as a BLOCK everywhere except the
    // AI body paths. Must run AFTER the managed groups: a label match only
    // sees labels added by rules evaluated earlier in the web ACL.
    {
      name: 'BodySignaturesBlock',
      priority: 5,
      action: { block: {} },
      statement: {
        andStatement: {
          statements: [
            {
              orStatement: {
                statements: bodySignatureLabels().map((label) => ({
                  labelMatchStatement: { scope: 'LABEL', key: label },
                })),
              },
            },
            {
              notStatement: {
                statement: {
                  orStatement: {
                    statements: AI_BODY_PATH_PREFIXES.map((prefix) =>
                      pathPrefixStatement(prefix)
                    ),
                  },
                },
              },
            },
          ],
        },
      },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'BodySignaturesBlock',
      },
    },
  ];
}
