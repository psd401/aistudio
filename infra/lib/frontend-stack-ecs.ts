import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import { EcsServiceConstruct } from './constructs/ecs-service';
import { VPCProvider, EnvironmentConfig } from './constructs';

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

    // ============================================================================
    // DNS and SSL Certificate Configuration
    // ============================================================================
    // Build the full domain name
    // If customSubdomain provided, use it (e.g., 'dev-ecs' -> 'dev-ecs.aistudio.psd401.ai')
    // Otherwise use environment-based default ('dev' -> 'dev.aistudio.psd401.ai')
    const subdomain = props.customSubdomain
      ? `${props.customSubdomain}.${baseDomain}`
      : (environment === 'dev' ? `dev.${baseDomain}` : baseDomain);

    // ============================================================================
    // Internal API Secret for Scheduled Execution Authentication
    // ============================================================================
    // Create secret for Lambda → ECS JWT authentication
    const internalApiSecret = new secretsmanager.Secret(this, 'InternalApiSecret', {
      secretName: `aistudio-${environment}-internal-api-secret`,
      description: 'Internal API authentication secret for scheduled execution',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'INTERNAL_API_SECRET',
        excludePunctuation: true,
        passwordLength: 32,
      },
      removalPolicy: environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // Export secret ARN to SSM for SchedulerStack to read
    new ssm.StringParameter(this, 'InternalApiSecretArnParam', {
      parameterName: `/aistudio/${environment}/internal-api-secret-arn`,
      stringValue: internalApiSecret.secretArn,
      description: 'Internal API secret ARN for Lambda JWT authentication',
    });

    // ============================================================================
    // Create ECS Service with ALB
    // ============================================================================
    this.ecsService = new EcsServiceConstruct(this, 'EcsService', {
      vpc,
      environment,
      documentsBucketName,
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
      // Internal API secret (created above)
      internalApiSecretArn: internalApiSecret.secretArn,
    });

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
      const httpsListener = this.ecsService.loadBalancer.addListener('HttpsListener', {
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

    // ============================================================================
    // AWS WAF for Application Protection
    // ============================================================================
    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      scope: 'REGIONAL', // ALB uses REGIONAL, CloudFront uses CLOUDFRONT
      defaultAction: { allow: {} },
      description: `WAF for AIStudio ${environment} environment`,
      rules: [
        // Rate limiting rule
        {
          name: 'RateLimitRule',
          priority: 1,
          statement: {
            rateBasedStatement: {
              limit: 2000, // 2000 requests per 5 minutes per IP
              aggregateKeyType: 'IP',
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
        // AWS Managed Core Rule Set
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
              excludedRules: [
                { name: 'SizeRestrictions_BODY' }, // Allow larger payloads
                { name: 'GenericRFI_BODY' }, // May trigger on AI prompts
              ],
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'CommonRuleSet',
          },
        },
        // Known bad inputs
        {
          name: 'AWSManagedRulesKnownBadInputsRuleSet',
          priority: 3,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'KnownBadInputs',
          },
        },
        // SQL injection protection
        {
          name: 'AWSManagedRulesSQLiRuleSet',
          priority: 4,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesSQLiRuleSet',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'SQLiRuleSet',
          },
        },
      ],
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


    // ============================================================================
    // SSM Parameters for Cross-Stack References
    // ============================================================================
    // Store ECS internal endpoint URL for schedule executor Lambda
    // Lambda must use the domain name (not ALB DNS) to match SSL certificate
    // Note: Uses SSM instead of CloudFormation export to avoid circular dependency with SchedulerStack
    new ssm.StringParameter(this, 'EcsInternalEndpointParam', {
      parameterName: `/aistudio/${environment}/ecs-internal-endpoint`,
      stringValue: `https://${subdomain}`,
      description: 'ECS endpoint URL for schedule executor Lambda (HTTPS via domain name)',
    });

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
        `  cd infra && npx cdk deploy ${this.stackName}`,
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
