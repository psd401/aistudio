import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as autoscaling from 'aws-cdk-lib/aws-applicationautoscaling';

export interface EcsServiceConstructProps {
  vpc: ec2.IVpc;
  environment: 'dev' | 'prod';
  documentsBucketName: string;
  enableContainerInsights?: boolean;
  enableFargateSpot?: boolean;
  /**
   * Percentage of tasks to run on Fargate Spot (0-100).
   * Only applies when enableFargateSpot is true.
   * For production, recommended: 50 (mixed strategy)
   * For dev/staging, recommended: 100 (maximum savings)
   * @default 100 for dev, 50 for prod
   */
  spotRatio?: number;
  /**
   * Enable scheduled scaling for predictable traffic patterns.
   * Scales up during business hours, down after hours.
   * @default true for prod, false for dev
   */
  enableScheduledScaling?: boolean;
  /**
   * If false, HTTP listener will not be created automatically.
   * This allows the parent stack to configure HTTPS and HTTP->HTTPS redirect.
   */
  createHttpListener?: boolean;
  /**
   * Initial desired count for ECS service.
   *
   * With fromAsset (default), this can safely be set to 1 because CDK builds
   * and pushes the Docker image BEFORE creating the ECS service.
   *
   * The DesiredCount property is removed from CloudFormation via escape hatch
   * to prevent resets on updates, allowing auto-scaling to manage task count.
   *
   * @default 1
   */
  initialDesiredCount?: number;
  /**
   * Docker image source strategy for the ECS task.
   *
   * - **fromAsset** (RECOMMENDED): CDK builds Dockerfile and pushes to ECR during deployment
   *   - Solves chicken-and-egg problem (image exists before service creation)
   *   - Single command deployment (no manual Docker steps)
   *   - Production-ready and AWS-recommended
   *   - CI/CD friendly
   *
   * - **fromEcrRepository**: Reference existing ECR image (requires manual push)
   *   - Use when external CI/CD builds images
   *   - Requires image with 'latest' tag exists before deployment
   *
   * @default 'fromAsset'
   */
  dockerImageSource?: 'fromAsset' | 'fromEcrRepository';
  /**
   * Path to directory containing Dockerfile (relative to infra/ directory).
   * Only used when dockerImageSource='fromAsset'.
   *
   * @default '../' (project root directory)
   */
  dockerfilePath?: string;
  /**
   * NextAuth base URL (e.g., "https://dev-ecs.aistudio.psd401.ai")
   */
  authUrl: string;
  /**
   * AWS Cognito User Pool Client ID
   */
  cognitoClientId: string;
  /**
   * AWS Cognito Issuer URL
   */
  cognitoIssuer: string;
  /**
   * RDS Aurora cluster ARN
   */
  rdsResourceArn: string;
  /**
   * RDS database credentials secret ARN
   */
  rdsSecretArn: string;
  /**
   * NextAuth secret ARN from Secrets Manager
   */
  authSecretArn: string;
  /**
   * Internal API secret ARN from Secrets Manager (for scheduled execution authentication)
   */
  internalApiSecretArn: string;
}

/**
 * ECS Fargate service construct for the AI Studio Next.js application.
 * Provides HTTP/2 streaming support through Application Load Balancer.
 */
export class EcsServiceConstruct extends Construct {
  public readonly cluster: ecs.Cluster;
  public readonly service: ecs.FargateService;
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly taskRole: iam.Role;
  public readonly repository: ecr.Repository;
  public readonly targetGroup: elbv2.ApplicationTargetGroup;

  constructor(scope: Construct, id: string, props: EcsServiceConstructProps) {
    super(scope, id);

    const { vpc, environment, documentsBucketName } = props;

    // ============================================================================
    // ECR Repository for container images
    // ============================================================================
    this.repository = new ecr.Repository(this, 'Repository', {
      repositoryName: `aistudio-${environment}`,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.MUTABLE,
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      lifecycleRules: [
        {
          description: 'Keep last 10 images',
          maxImageCount: 10,
          rulePriority: 1,
        },
      ],
    });

    // ============================================================================
    // VPC Endpoints (required because PUBLIC subnets can't reach AWS services)
    // ============================================================================
    // VPC Endpoints are now provided by SharedVPC construct
    // SharedVPC creates comprehensive endpoints including:
    // - S3 Gateway Endpoint (for ECR - ECR stores layers in S3)
    // - Secrets Manager Interface Endpoint (for AUTH_SECRET at task startup)
    // - ECR, CloudWatch Logs, and other AWS service endpoints
    //
    // This eliminates duplicate endpoint creation and ensures consistent
    // VPC endpoint configuration across all stacks using the shared VPC.

    // ============================================================================
    // ECS Cluster with Container Insights
    // ============================================================================
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `aistudio-${environment}`,
      vpc,
      /**
       * Container Insights V2 for enhanced ECS monitoring
       * Default: ENABLED for comprehensive observability
       * - Provides task-level CPU/memory metrics
       * - Enables AWS Distro for OpenTelemetry (ADOT) integration
       * - Required for CloudWatch Container Insights dashboards
       * Can be disabled via props.enableContainerInsights = false
       */
      containerInsightsV2: (props.enableContainerInsights ?? true)
        ? ecs.ContainerInsights.ENABLED
        : ecs.ContainerInsights.DISABLED,
    });

    // ============================================================================
    // Application Load Balancer
    // ============================================================================
    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      description: 'Security group for Application Load Balancer',
      allowAllOutbound: true,
    });

    // Allow HTTPS from internet
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS from internet'
    );

    // Allow HTTP for ALB health checks and redirect
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP for redirect to HTTPS'
    );

    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: albSecurityGroup,
      http2Enabled: true,
      deletionProtection: environment === 'prod',
      idleTimeout: cdk.Duration.seconds(300), // 5 minutes for long streaming requests
    });

    // ============================================================================
    // ECS Task Definition
    // ============================================================================
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/ecs/aistudio-${environment}`,
      retention: environment === 'prod'
        ? logs.RetentionDays.ONE_MONTH
        : logs.RetentionDays.ONE_WEEK,
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    // Task Execution Role - for pulling images and writing logs
    const taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Grant ECR pull permissions
    this.repository.grantPull(taskExecutionRole);

    // Grant Secrets Manager access for environment variables
    taskExecutionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:GetSecretValue',
        'secretsmanager:DescribeSecret',
      ],
      resources: [
        `arn:aws:secretsmanager:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:secret:aistudio-${environment}-*`,
        `arn:aws:secretsmanager:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:secret:aistudio/${environment}/*`,
        // Explicit permissions for both secrets
        props.authSecretArn,
        props.internalApiSecretArn,
      ],
    }));

    // Task Role - for application permissions (same as current SSR Compute Role)
    this.taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: `ECS Task role for AI Studio ${environment}`,
      inlinePolicies: {
        'RDSDataAPIAccess': new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'rds-data:ExecuteStatement',
                'rds-data:BatchExecuteStatement',
                'rds-data:BeginTransaction',
                'rds-data:CommitTransaction',
                'rds-data:RollbackTransaction',
              ],
              resources: [
                `arn:aws:rds:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:cluster:*`, // Wildcard to match any cluster name (CDK generates unique names)
              ],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'secretsmanager:GetSecretValue',
                'secretsmanager:DescribeSecret',
              ],
              resources: [
                `arn:aws:secretsmanager:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:secret:aistudio-${environment}-*`,
                `arn:aws:secretsmanager:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:secret:aistudio/${environment}/*`,
                props.rdsSecretArn, // Include actual database secret ARN
                props.authSecretArn, // Include auth secret
                props.internalApiSecretArn, // Include internal API secret
              ],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                's3:GetObject',
                's3:PutObject',
                's3:DeleteObject',
                's3:ListBucket',
                's3:HeadObject',
                's3:HeadBucket',
              ],
              resources: [
                `arn:aws:s3:::${documentsBucketName}`,
                `arn:aws:s3:::${documentsBucketName}/*`,
              ],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'sqs:SendMessage',
                'sqs:GetQueueAttributes',
                'sqs:GetQueueUrl',
              ],
              resources: [
                `arn:aws:sqs:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:aistudio-${environment}-*`,
                `arn:aws:sqs:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:AIStudio-*-${environment}`,
              ],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['lambda:InvokeFunction'],
              resources: [
                `arn:aws:lambda:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:function:aistudio-${environment}-schedule-executor`,
              ],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'dynamodb:GetItem',
                'dynamodb:PutItem',
                'dynamodb:UpdateItem',
                'dynamodb:Query',
                'dynamodb:Scan',
              ],
              resources: [
                `arn:aws:dynamodb:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:table/aistudio-${environment}-*`,
                `arn:aws:dynamodb:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:table/AIStudio-*-${environment}`,
              ],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'bedrock:InvokeModel',
                'bedrock:InvokeModelWithResponseStream',
              ],
              resources: [
                'arn:aws:bedrock:*::foundation-model/*',
                'arn:aws:bedrock:*:*:inference-profile/*',
                'arn:aws:bedrock:*:*:provisioned-model/*',
              ],
            }),
          ],
        }),
      },
    });

    // Task Definition
    const cpu = environment === 'prod' ? 1024 : 512; // 1 vCPU prod, 0.5 dev
    const memory = environment === 'prod' ? 2048 : 1024; // 2GB prod, 1GB dev

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      cpu,
      memoryLimitMiB: memory,
      executionRole: taskExecutionRole,
      taskRole: this.taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      // Add bind mount volumes for read-only filesystem support (Fargate uses ephemeral storage, not tmpfs)
      volumes: [
        {
          name: 'tmp',
        },
        {
          name: 'nextjs-cache',
        },
        {
          name: 'nextjs-home',
        },
      ],
    });

    // ============================================================================
    // Container Image Strategy
    // ============================================================================
    // Determine image source based on configuration
    // - fromAsset (default): CDK builds and pushes image during deployment
    // - fromEcrRepository: Requires manual image push before deployment
    const containerImage = props.dockerImageSource === 'fromEcrRepository'
      ? ecs.ContainerImage.fromEcrRepository(this.repository, 'latest')
      : ecs.ContainerImage.fromAsset(props.dockerfilePath || '../', {
          file: 'Dockerfile.graviton', // Use Graviton-optimized Dockerfile for ARM64
          platform: ecr_assets.Platform.LINUX_ARM64, // Match runtimePlatform
          exclude: [
            'infra/',         // Exclude CDK infrastructure code
            '.git/',          // Exclude git history
            'node_modules/',  // Will be installed fresh in Docker
            '.next/',         // Will be built in Docker
            'tests/',         // Exclude test files
            '*.md',           // Exclude documentation
            '.env*',          // Exclude environment files (use secrets instead)
          ],
        });

    // Retrieve environment variables from SSM Parameter Store
    // These will be set during deployment
    const container = taskDefinition.addContainer('NextJsContainer', {
      containerName: 'nextjs-app',
      image: containerImage,
      memoryLimitMiB: memory,
      memoryReservationMiB: Math.floor(memory * 0.8), // Soft limit for better resource management
      cpu,
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'frontend',
      }),
      environment: {
        NODE_ENV: 'production',
        AWS_REGION: cdk.Stack.of(this).region,
        NEXT_PUBLIC_AWS_REGION: cdk.Stack.of(this).region,
        PORT: '3000',
        ENVIRONMENT: environment,
        // Memory optimization - 70% of container memory
        NODE_OPTIONS: `--max-old-space-size=${Math.floor(memory * 0.7)}`,
        // Application configuration
        S3_BUCKET_NAME: documentsBucketName,
        DOCUMENTS_BUCKET_NAME: documentsBucketName, // Legacy name for compatibility
        RDS_DATABASE_NAME: 'aistudio',
        AUTH_URL: props.authUrl,
        AUTH_COGNITO_CLIENT_ID: props.cognitoClientId,
        AUTH_COGNITO_ISSUER: props.cognitoIssuer,
        RDS_RESOURCE_ARN: props.rdsResourceArn,
        RDS_SECRET_ARN: props.rdsSecretArn,
        // Queue URLs from Processing Stack exports
        EMBEDDING_QUEUE_URL: cdk.Fn.importValue(`${environment}-EmbeddingQueueUrl`),
        FILE_PROCESSING_QUEUE_URL: cdk.Fn.importValue(`${environment}-FileProcessingQueueUrl`),
        // Queue URLs from Document Processing Stack exports
        PROCESSING_QUEUE_URL: cdk.Fn.importValue(`${environment}-ProcessingQueueUrl`),
        HIGH_MEMORY_QUEUE_URL: cdk.Fn.importValue(`${environment}-HighMemoryQueueUrl`),
        // Notification Queue URL from Email Notification Stack
        NOTIFICATION_QUEUE_URL: cdk.Fn.importValue(`${environment}-NotificationQueueUrl`),
        // Table names from stack exports
        DOCUMENT_JOBS_TABLE: cdk.Fn.importValue(`${environment}-DocumentJobsTableName`),
        JOB_STATUS_TABLE_NAME: cdk.Fn.importValue(`${environment}-JobStatusTableName`),
        // Lambda function names from Processing Stack exports
        EMBEDDING_GENERATOR_FUNCTION_NAME: cdk.Fn.importValue(`${environment}-EmbeddingGeneratorFunctionName`),
        URL_PROCESSOR_FUNCTION_NAME: cdk.Fn.importValue(`${environment}-URLProcessorFunctionName`),
        // Application settings
        MAX_FILE_SIZE_MB: '100',
        SQL_LOGGING: 'false',
        // Public Cognito configuration for client-side
        NEXT_PUBLIC_COGNITO_CLIENT_ID: props.cognitoClientId,
        NEXT_PUBLIC_COGNITO_USER_POOL_ID: cdk.Fn.importValue(`${environment}-CognitoUserPoolId`),
        NEXT_PUBLIC_COGNITO_DOMAIN: `aistudio-${environment}.auth.${cdk.Stack.of(this).region}.amazoncognito.com`,
        // Cognito token configuration
        COGNITO_ACCESS_TOKEN_LIFETIME_SECONDS: '43200', // 12 hours
        COGNITO_JWKS_URL: `https://aistudio-${environment}.auth.${cdk.Stack.of(this).region}.amazoncognito.com/.well-known/jwks.json`,
      },
      // Secrets injected from Secrets Manager at runtime
      secrets: {
        AUTH_SECRET: ecs.Secret.fromSecretsManager(
          secretsmanager.Secret.fromSecretCompleteArn(this, 'AuthSecret', props.authSecretArn),
          'AUTH_SECRET'
        ),
        // NEW: Internal API secret for scheduled execution authentication
        INTERNAL_API_SECRET: ecs.Secret.fromSecretsManager(
          secretsmanager.Secret.fromSecretCompleteArn(this, 'InternalApiSecret', props.internalApiSecretArn),
          'INTERNAL_API_SECRET'
        ),
      },
      // Security: Read-only root filesystem with tmpfs mounts for writable directories
      readonlyRootFilesystem: true,
      // Enable init process for proper signal handling (tini)
      linuxParameters: new ecs.LinuxParameters(this, 'LinuxParameters', {
        initProcessEnabled: true, // Critical for graceful shutdown
      }),
      // File descriptor limits
      ulimits: [
        {
          name: ecs.UlimitName.NOFILE,
          softLimit: 65536,
          hardLimit: 65536,
        },
      ],
      // NOTE: Container health check removed - relying on ALB health checks instead
      // ALB health checks work reliably while container health checks have issues in isolated subnets
      // ALB checks the same /api/healthz endpoint and routes traffic only to healthy targets
    });

    // Add bind mount points for writable directories in read-only filesystem
    container.addMountPoints({
      containerPath: '/tmp',
      sourceVolume: 'tmp',
      readOnly: false,
    });
    container.addMountPoints({
      containerPath: '/app/.next/cache',
      sourceVolume: 'nextjs-cache',
      readOnly: false,
    });
    container.addMountPoints({
      containerPath: '/home/nextjs',
      sourceVolume: 'nextjs-home',
      readOnly: false,
    });

    container.addPortMappings({
      containerPort: 3000,
      protocol: ecs.Protocol.TCP,
    });

    // ============================================================================
    // ECS Service with Auto Scaling
    // ============================================================================
    const ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsSecurityGroup', {
      vpc,
      description: 'Security group for ECS tasks',
      allowAllOutbound: true,
    });

    // Allow traffic from ALB
    ecsSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(3000),
      'Allow traffic from ALB'
    );

    this.service = new ecs.FargateService(this, 'Service', {
      cluster: this.cluster,
      taskDefinition,
      serviceName: `aistudio-${environment}`,
      desiredCount: props.initialDesiredCount ?? 1,
      minHealthyPercent: environment === 'prod' ? 100 : 0,
      maxHealthyPercent: 200,
      securityGroups: [ecsSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC }, // Public subnets for internet access (Cognito auth requires internet)
      assignPublicIp: true, // CRITICAL: Tasks need public IPs to reach internet via internet gateway
      capacityProviderStrategies: this.createCapacityProviderStrategy(environment, props),
      circuitBreaker: {
        rollback: true, // Safe with fromAsset - image exists before service creation
      },
      enableExecuteCommand: true, // For debugging
    });

    // Remove DesiredCount from CloudFormation template to prevent resets on deployment
    // This allows auto-scaling and manual scaling to manage task count independently
    // AWS Best Practice: https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ecs-service.html
    //
    // When DesiredCount is omitted from CloudFormation (as of Nov 2020):
    // - Initial deployment: Uses value from initialDesiredCount parameter
    // - Subsequent deployments: Preserves current desired count (from auto-scaling or manual changes)
    // - No manual intervention required
    const cfnService = this.service.node.defaultChild as ecs.CfnService;
    cfnService.addPropertyDeletionOverride('DesiredCount');

    // ============================================================================
    // Target Group and Listener
    // ============================================================================
    this.targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/api/healthz', // Use lightweight endpoint for ALB health checks
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        healthyHttpCodes: '200',
      },
      deregistrationDelay: cdk.Duration.seconds(30),
      stickinessCookieDuration: cdk.Duration.hours(1),
      targets: [this.service],
    });

    // HTTP Listener - only create if explicitly requested
    // For production, parent stack should configure HTTPS and HTTP->HTTPS redirect
    if (props.createHttpListener !== false) {
      this.loadBalancer.addListener('HttpListener', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultTargetGroups: [this.targetGroup],
      });
    }

    // ============================================================================
    // Auto Scaling
    // ============================================================================
    const scaling = this.service.autoScaleTaskCount({
      minCapacity: 1, // Safe with fromAsset - image exists before service creation
      maxCapacity: environment === 'prod' ? 10 : 3,
    });

    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(300), // 5 minutes
      scaleOutCooldown: cdk.Duration.seconds(60), // 1 minute
    });

    scaling.scaleOnMemoryUtilization('MemoryScaling', {
      targetUtilizationPercent: 80,
      scaleInCooldown: cdk.Duration.seconds(300),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    // Scheduled scaling for production (optional, controlled by prop)
    if (props.enableScheduledScaling && environment === 'prod') {
      this.addScheduledScaling(scaling);
    }

    // ============================================================================
    // Outputs and SSM Parameters
    // ============================================================================
    new ssm.StringParameter(this, 'LoadBalancerDnsParam', {
      parameterName: `/aistudio/${environment}/alb-dns-name`,
      stringValue: this.loadBalancer.loadBalancerDnsName,
      description: 'ALB DNS name for ECS service',
    });

    new ssm.StringParameter(this, 'EcrRepositoryUriParam', {
      parameterName: `/aistudio/${environment}/ecr-repository-uri`,
      stringValue: this.repository.repositoryUri,
      description: 'ECR repository URI for container images',
    });

    new ssm.StringParameter(this, 'EcsClusterNameParam', {
      parameterName: `/aistudio/${environment}/ecs-cluster-name`,
      stringValue: this.cluster.clusterName,
      description: 'ECS cluster name',
    });

    new ssm.StringParameter(this, 'EcsServiceNameParam', {
      parameterName: `/aistudio/${environment}/ecs-service-name`,
      stringValue: this.service.serviceName,
      description: 'ECS service name',
    });

    new ssm.StringParameter(this, 'AlbSecurityGroupIdParam', {
      parameterName: `/aistudio/${environment}/alb-security-group-id`,
      stringValue: albSecurityGroup.securityGroupId,
      description: 'ALB security group ID for Lambda ingress rules',
    });

    // CloudFormation Outputs with unique export names
    new cdk.CfnOutput(this, 'LoadBalancerDnsName', {
      value: this.loadBalancer.loadBalancerDnsName,
      description: 'ALB DNS name',
      exportName: `${environment}-ecs-AlbDnsName`,
    });

    new cdk.CfnOutput(this, 'EcrRepositoryUri', {
      value: this.repository.repositoryUri,
      description: 'ECR Repository URI',
      exportName: `${environment}-ecs-EcrRepositoryUri`,
    });

    new cdk.CfnOutput(this, 'EcsClusterName', {
      value: this.cluster.clusterName,
      description: 'ECS Cluster Name',
      exportName: `${environment}-ecs-EcsClusterName`,
    });

    new cdk.CfnOutput(this, 'EcsServiceName', {
      value: this.service.serviceName,
      description: 'ECS Service Name',
      exportName: `${environment}-ecs-EcsServiceName`,
    });

    new cdk.CfnOutput(this, 'TaskRoleArn', {
      value: this.taskRole.roleArn,
      description: 'ECS Task Role ARN',
      exportName: `${environment}-ecs-EcsTaskRoleArn`,
    });
  }

  /**
   * Create optimized capacity provider strategy based on environment and configuration
   */
  private createCapacityProviderStrategy(
    environment: string,
    props: EcsServiceConstructProps
  ): ecs.CapacityProviderStrategy[] {
    // If Fargate Spot not enabled, use on-demand only
    if (!props.enableFargateSpot) {
      return [
        {
          capacityProvider: 'FARGATE',
          base: 1,
          weight: 1,
        },
      ];
    }

    // Determine spot ratio (default: 100 for dev, 50 for prod)
    const spotRatio = props.spotRatio ?? (environment === 'prod' ? 50 : 100);

    if (environment === 'prod') {
      // Production: Mixed strategy for reliability
      // Base capacity on-demand, burst capacity on Spot
      return [
        {
          capacityProvider: 'FARGATE',
          base: 2, // Always keep 2 tasks on-demand for stability
          weight: 100 - spotRatio,
        },
        {
          capacityProvider: 'FARGATE_SPOT',
          weight: spotRatio,
        },
      ];
    } else {
      // Dev/Staging: Mixed strategy with Spot preference but on-demand fallback
      // Changed from 100% Spot to 70/30 mix for availability resilience
      return [
        {
          capacityProvider: 'FARGATE',
          base: 1, // Always keep 1 task on-demand for availability
          weight: 30,
        },
        {
          capacityProvider: 'FARGATE_SPOT',
          weight: 70, // Prefer Spot for cost savings
        },
      ];
    }
  }

  /**
   * Add scheduled scaling for predictable traffic patterns
   *
   * IMPORTANT: Times are in UTC and assume PST (UTC-8) year-round.
   * During PDT (Daylight Saving Time, March-November), scaling will occur 1 hour early.
   *
   * To adjust for DST, manually update these schedules twice per year:
   * - March (PDT begins): Add 1 hour to all UTC times
   * - November (PST returns): Subtract 1 hour from all UTC times
   *
   * Alternative: Monitor actual traffic patterns and adjust based on CloudWatch metrics.
   */
  private addScheduledScaling(scaling: ecs.ScalableTaskCount): void {
    // Scale up before business hours (Mon-Fri 7:30 AM PST/PDT)
    // PST (Nov-Mar): 7:30 AM PST = 3:30 PM UTC (15:30)
    // PDT (Mar-Nov): 7:30 AM PDT = 2:30 PM UTC (14:30)
    // Currently configured for PST
    scaling.scaleOnSchedule('MorningScaleUp', {
      schedule: autoscaling.Schedule.cron({
        hour: '15', // 7:30 AM PST = 3:30 PM UTC (adjust to 14 during PDT)
        minute: '30',
        weekDay: 'MON-FRI',
      }),
      minCapacity: 4,
      maxCapacity: 20,
    });

    // Scale down after business hours (8:00 PM PST/PDT)
    // PST: 8:00 PM PST = 4:00 AM UTC next day
    // PDT: 8:00 PM PDT = 3:00 AM UTC next day
    scaling.scaleOnSchedule('EveningScaleDown', {
      schedule: autoscaling.Schedule.cron({
        hour: '4', // 8:00 PM PST = 4:00 AM UTC next day (adjust to 3 during PDT)
        minute: '0',
        weekDay: 'TUE-SAT', // Next day in UTC
      }),
      minCapacity: 2,
      maxCapacity: 10,
    });

    // Weekend scaling (lower capacity on Saturday midnight PST/PDT)
    scaling.scaleOnSchedule('WeekendScaling', {
      schedule: autoscaling.Schedule.cron({
        hour: '8', // Midnight PST = 8:00 AM UTC (adjust to 7 during PDT)
        minute: '0',
        weekDay: 'SAT',
      }),
      minCapacity: 1,
      maxCapacity: 5,
    });
  }

  /**
   * Create CloudWatch dashboard for monitoring the ECS service
   * Includes streaming performance metrics and ALB health monitoring
   */
  /**
   * Create CloudWatch alarms for ECS service monitoring
   */
  public createAlarms(props: {
    environment: string;
    alarmTopic?: cloudwatch_actions.SnsAction;
  }): cloudwatch.Alarm[] {
    const alarms: cloudwatch.Alarm[] = [];

    // High error rate alarm
    const errorRateAlarm = new cloudwatch.Alarm(this, 'HighErrorRate', {
      alarmName: `${props.environment}-ecs-high-error-rate`,
      alarmDescription: 'ECS 5XX error rate exceeds threshold',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName: 'HTTPCode_Target_5XX_Count',
        dimensionsMap: {
          LoadBalancer: this.loadBalancer.loadBalancerFullName,
        },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 10,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarms.push(errorRateAlarm);

    // Unhealthy target alarm
    const unhealthyTargetAlarm = new cloudwatch.Alarm(this, 'UnhealthyTargets', {
      alarmName: `${props.environment}-ecs-unhealthy-targets`,
      alarmDescription: 'ECS has unhealthy targets',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName: 'UnHealthyHostCount',
        dimensionsMap: {
          TargetGroup: this.targetGroup.targetGroupFullName,
          LoadBalancer: this.loadBalancer.loadBalancerFullName,
        },
        statistic: 'Average',
        period: cdk.Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarms.push(unhealthyTargetAlarm);

    // High CPU alarm
    const highCpuAlarm = new cloudwatch.Alarm(this, 'HighCPU', {
      alarmName: `${props.environment}-ecs-high-cpu`,
      alarmDescription: 'ECS CPU utilization exceeds 80%',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ECS',
        metricName: 'CPUUtilization',
        dimensionsMap: {
          ServiceName: this.service.serviceName,
          ClusterName: this.cluster.clusterName,
        },
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 80,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarms.push(highCpuAlarm);

    // High memory alarm
    const highMemoryAlarm = new cloudwatch.Alarm(this, 'HighMemory', {
      alarmName: `${props.environment}-ecs-high-memory`,
      alarmDescription: 'ECS memory utilization exceeds 85%',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ECS',
        metricName: 'MemoryUtilization',
        dimensionsMap: {
          ServiceName: this.service.serviceName,
          ClusterName: this.cluster.clusterName,
        },
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 85,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarms.push(highMemoryAlarm);

    // No running tasks alarm
    const noTasksAlarm = new cloudwatch.Alarm(this, 'NoRunningTasks', {
      alarmName: `${props.environment}-ecs-no-running-tasks`,
      alarmDescription: 'ECS service has no running tasks',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ECS',
        metricName: 'RunningTaskCount',
        dimensionsMap: {
          ServiceName: this.service.serviceName,
          ClusterName: this.cluster.clusterName,
        },
        statistic: 'Average',
        period: cdk.Duration.minutes(1),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    alarms.push(noTasksAlarm);

    // Add alarm actions if SNS topic provided
    if (props.alarmTopic) {
      const topic = props.alarmTopic;
      alarms.forEach(alarm => alarm.addAlarmAction(topic));
    }

    return alarms;
  }
}
