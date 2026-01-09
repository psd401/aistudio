import * as cdk from "aws-cdk-lib"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import * as logs from "aws-cdk-lib/aws-logs"
import * as s3 from "aws-cdk-lib/aws-s3"
import { Construct } from "constructs"
import { IEnvironmentConfig } from "../config/environment-config"

export interface SharedVPCProps {
  environment: "dev" | "staging" | "prod"
  config: IEnvironmentConfig
  enableFlowLogs?: boolean
  /**
   * Enable gateway VPC endpoints (S3, DynamoDB).
   * These are FREE and recommended for all environments.
   * @default true
   */
  enableGatewayEndpoints?: boolean
  /**
   * Enable interface VPC endpoints (ECR, Secrets Manager, etc.).
   * These cost ~$7.30/month per endpoint per AZ.
   * DISABLED by default for cost optimization (Issue #617).
   * All AWS services work reliably through NAT gateways.
   * @default false
   */
  enableInterfaceEndpoints?: boolean
  /**
   * @deprecated Use enableGatewayEndpoints and enableInterfaceEndpoints instead.
   * For backwards compatibility: if true, enables gateway endpoints only.
   */
  enableVpcEndpoints?: boolean
}

/**
 * Shared VPC construct for AI Studio infrastructure.
 *
 * This construct creates a single, shared VPC with proper subnet segmentation,
 * gateway endpoints, and flow logs for network visibility.
 *
 * Features:
 * - Multi-AZ deployment for high availability
 * - Separate subnets for different workload types (public, private app, private data, isolated)
 * - NAT gateways for outbound internet access
 * - Gateway endpoints for S3 and DynamoDB (FREE - always enabled)
 * - VPC flow logs to S3 for security monitoring
 *
 * Cost Optimization (Issue #617):
 * - Interface VPC endpoints DISABLED by default (saves ~$428/month)
 * - All AWS services work reliably through NAT gateways
 * - Gateway endpoints (S3, DynamoDB) are free and always created
 * - Flow logs to S3 with lifecycle policies (cheaper than CloudWatch Logs)
 *
 * Security:
 * - Private subnets for application and database workloads
 * - Isolated subnets for sensitive workloads
 * - Flow logs for network traffic analysis
 *
 * @see https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Scenario2.html
 */
export class SharedVPC extends Construct {
  public readonly vpc: ec2.IVpc
  public readonly publicSubnets: ec2.ISubnet[]
  public readonly privateSubnets: ec2.ISubnet[]
  public readonly dataSubnets: ec2.ISubnet[]
  public readonly isolatedSubnets: ec2.ISubnet[]
  public readonly vpcEndpoints: Map<string, ec2.IInterfaceVpcEndpoint>
  public readonly flowLogBucket?: s3.IBucket

  constructor(scope: Construct, id: string, props: SharedVPCProps) {
    super(scope, id)

    const { environment, config } = props

    // Create VPC with optimized configuration
    this.vpc = new ec2.Vpc(this, "SharedVPC", {
      vpcName: `aistudio-${environment}-vpc`,
      maxAzs: config.network.maxAzs,
      natGateways: config.network.natGateways,
      natGatewayProvider: this.createOptimizedNatProvider(environment),

      subnetConfiguration: [
        {
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: "Private-Application",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 22, // Larger subnet for applications (1024 IPs)
        },
        {
          name: "Private-Data",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24, // Standard subnet for databases (256 IPs)
        },
        {
          name: "Isolated",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24, // Isolated subnet for sensitive workloads
        },
      ],

      // Enable DNS for private hosted zones and VPC endpoints
      enableDnsHostnames: true,
      enableDnsSupport: true,
    })

    // Tag subnets for better identification
    this.tagSubnets()

    // Store subnet references
    this.publicSubnets = this.vpc.publicSubnets

    // Private-Application subnets (for ECS, Lambda, etc.)
    const privateAppSubnets = this.vpc.selectSubnets({
      subnetGroupName: "Private-Application",
    }).subnets
    this.privateSubnets = privateAppSubnets

    // Private-Data subnets (for RDS, ElastiCache, etc.)
    this.dataSubnets = this.vpc.selectSubnets({
      subnetGroupName: "Private-Data",
    }).subnets

    // Isolated subnets (no internet access)
    this.isolatedSubnets = this.vpc.isolatedSubnets

    // Initialize VPC endpoints map
    this.vpcEndpoints = new Map<string, ec2.IInterfaceVpcEndpoint>()

    // Gateway endpoints (S3, DynamoDB) - FREE, always recommended
    // Enable by default unless explicitly disabled
    const enableGateway = props.enableGatewayEndpoints !== false &&
                          props.enableVpcEndpoints !== false
    if (enableGateway) {
      this.createGatewayEndpoints()
    }

    // Interface endpoints - PAID (~$7.30/month per endpoint per AZ)
    // DISABLED by default for cost optimization (Issue #617)
    // All AWS services work reliably through NAT gateways
    if (props.enableInterfaceEndpoints === true) {
      this.createInterfaceEndpoints(environment, config)
    }

    // Enable VPC Flow Logs
    if (props.enableFlowLogs !== false) {
      this.flowLogBucket = this.enableVpcFlowLogs(environment)
    }

    // Add CloudWatch metrics
    this.addVpcMetrics(environment)
  }

  /**
   * Check if environment is production or staging (requires prod-level resources).
   */
  private isProduction(environment: string): boolean {
    return environment === "prod" || environment === "staging"
  }

  /**
   * Create NAT provider for all environments.
   *
   * Uses managed NAT gateways for all environments (dev, staging, prod).
   *
   * Note: Previously used NAT instances for dev to save costs (~$5/month),
   * but NAT instances require AMI lookups at synth time which don't work
   * with the --no-lookups flag used in CI/CD pipelines.
   *
   * Cost: ~$45/month per NAT gateway (consistent across all environments)
   * Benefit: Managed service, no AMI lookups, more reliable, consistent behavior
   */
  private createOptimizedNatProvider(
    environment: string
  ): ec2.NatProvider {
    // Use managed NAT gateways for all environments
    // This avoids AMI lookup issues in CI/CD with --no-lookups flag
    return ec2.NatProvider.gateway()
  }

  /**
   * Create gateway VPC endpoints for S3 and DynamoDB.
   *
   * Gateway endpoints are FREE (no hourly cost, only data transfer charges)
   * and are recommended for all environments.
   *
   * - S3: For object storage access (ECR images, file uploads, etc.)
   * - DynamoDB: For NoSQL database access
   */
  private createGatewayEndpoints(): void {
    this.vpc.addGatewayEndpoint("S3Endpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [
        { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    })

    this.vpc.addGatewayEndpoint("DynamoDBEndpoint", {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    })
  }

  /**
   * Create interface VPC endpoints for AWS services.
   *
   * IMPORTANT: Interface endpoints cost ~$7.30/month per endpoint per AZ.
   * This is DISABLED by default for cost optimization (Issue #617).
   *
   * All AWS services (ECR, Secrets Manager, CloudWatch, etc.) work reliably
   * through NAT gateways. Interface endpoints are only needed for:
   * - High-volume data transfer to specific services
   * - Strict security requirements preventing NAT gateway usage
   * - Very latency-sensitive applications
   *
   * For a typical K-12 school district application, NAT gateways are sufficient.
   *
   * To enable, set enableInterfaceEndpoints: true in SharedVPCProps.
   */
  private createInterfaceEndpoints(
    environment: string,
    _config: IEnvironmentConfig
  ): void {
    // Security group for VPC endpoints
    const endpointSg = new ec2.SecurityGroup(this, "VpcEndpointSg", {
      vpc: this.vpc,
      description: "Security group for VPC endpoints",
      allowAllOutbound: false,
    })

    endpointSg.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      "Allow HTTPS from VPC"
    )

    // Interface endpoints configuration
    // Essential endpoints for all environments
    const essentialEndpoints = [
      {
        name: "SecretsManager",
        service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      },
      {
        name: "RDS",
        service: ec2.InterfaceVpcEndpointAwsService.RDS,
      },
      {
        name: "RDSData",
        service: ec2.InterfaceVpcEndpointAwsService.RDS_DATA,
      },
      {
        name: "ECRApi",
        service: ec2.InterfaceVpcEndpointAwsService.ECR,
      },
      {
        name: "ECRDkr",
        service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      },
      {
        name: "CloudWatchLogs",
        service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      },
      {
        name: "CloudWatchMonitoring",
        service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_MONITORING,
      },
      {
        name: "SNS",
        service: ec2.InterfaceVpcEndpointAwsService.SNS,
      },
      {
        name: "SQS",
        service: ec2.InterfaceVpcEndpointAwsService.SQS,
      },
      {
        name: "Lambda",
        service: ec2.InterfaceVpcEndpointAwsService.LAMBDA,
      },
      {
        name: "SSM",
        service: ec2.InterfaceVpcEndpointAwsService.SSM,
      },
      {
        name: "KMS",
        service: ec2.InterfaceVpcEndpointAwsService.KMS,
      },
      {
        name: "ECS",
        service: ec2.InterfaceVpcEndpointAwsService.ECS,
      },
      {
        name: "ECSAgent",
        service: ec2.InterfaceVpcEndpointAwsService.ECS_AGENT,
      },
      {
        name: "ECSTelemetry",
        service: ec2.InterfaceVpcEndpointAwsService.ECS_TELEMETRY,
      },
    ]

    // Production-only endpoints (expensive but useful for prod workloads)
    const productionOnlyEndpoints = [
      {
        name: "Textract",
        service: ec2.InterfaceVpcEndpointAwsService.TEXTRACT,
      },
      {
        name: "Comprehend",
        service: ec2.InterfaceVpcEndpointAwsService.COMPREHEND,
      },
    ]

    // Determine which endpoints to create based on environment
    // Production and staging get full endpoint suite
    const endpointsToCreate = this.isProduction(environment)
      ? [...essentialEndpoints, ...productionOnlyEndpoints]
      : essentialEndpoints

    // Create interface endpoints
    for (const endpoint of endpointsToCreate) {
      const vpcEndpoint = this.vpc.addInterfaceEndpoint(
        `${endpoint.name}Endpoint`,
        {
          service: endpoint.service,
          securityGroups: [endpointSg],
          privateDnsEnabled: true,
          subnets: {
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          },
        }
      )

      this.vpcEndpoints.set(endpoint.name, vpcEndpoint)
    }
  }

  /**
   * Enable VPC Flow Logs for network traffic monitoring.
   *
   * Flow logs are stored in S3 with lifecycle policies for cost optimization:
   * - Dev: 30-day retention
   * - Prod/Staging: 90-day retention with transition to Infrequent Access after 30 days
   *
   * Additionally, production environments get real-time CloudWatch Logs
   * for rejected traffic only (for security alerts).
   *
   * Creates explicit IAM role with least-privilege permissions for flow logs.
   */
  private enableVpcFlowLogs(environment: string): s3.IBucket {
    const isProd = this.isProduction(environment)

    // S3 bucket for flow logs (cheaper than CloudWatch Logs)
    const flowLogBucket = new s3.Bucket(this, "FlowLogBucket", {
      bucketName: `aistudio-${environment}-vpc-flow-logs-${
        cdk.Stack.of(this).account
      }`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [
        {
          enabled: true,
          expiration: cdk.Duration.days(isProd ? 90 : 30),
          transitions: isProd
            ? [
                {
                  storageClass: s3.StorageClass.INFREQUENT_ACCESS,
                  transitionAfter: cdk.Duration.days(30),
                },
              ]
            : [],
        },
      ],
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: isProd
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    })

    // Create explicit IAM role for flow logs with least-privilege permissions
    const flowLogRole = new cdk.aws_iam.Role(this, "FlowLogRole", {
      assumedBy: new cdk.aws_iam.ServicePrincipal("vpc-flow-logs.amazonaws.com"),
      description: `IAM role for VPC flow logs in ${environment} environment`,
    })

    // Grant specific permissions to write flow logs to S3
    flowLogBucket.grantWrite(flowLogRole, "vpc-flow-logs/*")

    // VPC Flow Logs to S3 with explicit role
    new ec2.FlowLog(this, "VPCFlowLog", {
      resourceType: ec2.FlowLogResourceType.fromVpc(this.vpc),
      destination: ec2.FlowLogDestination.toS3(
        flowLogBucket,
        "vpc-flow-logs"
      ),
      trafficType: ec2.FlowLogTrafficType.ALL,
      flowLogName: `${this.vpc.vpcId}-flow-log`,
      maxAggregationInterval:
        ec2.FlowLogMaxAggregationInterval.TEN_MINUTES,
    })

    // Optional: CloudWatch Logs for real-time analysis (more expensive, prod/staging only)
    if (isProd) {
      const logGroup = new logs.LogGroup(this, "FlowLogGroup", {
        logGroupName: `/aws/vpc/flowlogs/${environment}`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      })

      // Create IAM role for CloudWatch flow logs
      const cwFlowLogRole = new cdk.aws_iam.Role(this, "CWFlowLogRole", {
        assumedBy: new cdk.aws_iam.ServicePrincipal("vpc-flow-logs.amazonaws.com"),
        description: `IAM role for VPC flow logs to CloudWatch in ${environment} environment`,
      })

      // Grant permissions to write to CloudWatch Logs
      logGroup.grantWrite(cwFlowLogRole)

      new ec2.FlowLog(this, "VPCFlowLogCloudWatch", {
        resourceType: ec2.FlowLogResourceType.fromVpc(this.vpc),
        destination: ec2.FlowLogDestination.toCloudWatchLogs(logGroup, cwFlowLogRole),
        trafficType: ec2.FlowLogTrafficType.REJECT, // Only rejected traffic for alerts
      })
    }

    return flowLogBucket
  }

  /**
   * Tag subnets for better identification and ELB integration.
   */
  private tagSubnets(): void {
    // Tag public subnets for ELB
    for (const subnet of this.vpc.publicSubnets) {
      cdk.Tags.of(subnet).add("kubernetes.io/role/elb", "1")
      cdk.Tags.of(subnet).add("SubnetType", "Public")
      cdk.Tags.of(subnet).add("Name", `aistudio-public-${subnet.availabilityZone}`)
    }

    // Tag private subnets
    for (const subnet of this.vpc.privateSubnets) {
      cdk.Tags.of(subnet).add("kubernetes.io/role/internal-elb", "1")
      cdk.Tags.of(subnet).add("SubnetType", "Private-Application")
      cdk.Tags.of(subnet).add(
        "Name",
        `aistudio-private-app-${subnet.availabilityZone}`
      )
    }

    // Tag isolated subnets
    for (const subnet of this.vpc.isolatedSubnets) {
      cdk.Tags.of(subnet).add("SubnetType", "Isolated")
      cdk.Tags.of(subnet).add(
        "Name",
        `aistudio-isolated-${subnet.availabilityZone}`
      )
    }
  }

  /**
   * Add CloudWatch metrics for VPC monitoring.
   *
   * Creates a CloudWatch dashboard with:
   * - NAT Gateway data transfer metrics (prod/staging only)
   * - VPC Endpoint usage metrics
   *
   * Note: Metrics will populate after resources are deployed and generate traffic.
   * Dashboard shows aggregated metrics across all NAT gateways and endpoints.
   */
  private addVpcMetrics(environment: string): void {
    // Custom CloudWatch dashboard for VPC metrics removed
    // Metrics now exported to consolidated dashboards via MonitoringStack
    // VPC/NAT Gateway metrics available for consolidation
  }

  /**
   * Helper method to get subnets for specific workload types.
   *
   * @param workloadType - Type of workload: 'web', 'app', 'data', or 'secure'
   * @returns Subnet selection appropriate for the workload type
   */
  public getSubnetsForWorkload(
    workloadType: "web" | "app" | "data" | "secure"
  ): ec2.SubnetSelection {
    switch (workloadType) {
      case "web":
        return { subnetType: ec2.SubnetType.PUBLIC }
      case "app":
        return { subnetGroupName: "Private-Application" }
      case "data":
        return { subnetGroupName: "Private-Data" }
      case "secure":
        return { subnetType: ec2.SubnetType.PRIVATE_ISOLATED }
      default:
        return { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }
    }
  }
}
