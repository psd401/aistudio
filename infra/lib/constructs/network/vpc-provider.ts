import * as cdk from "aws-cdk-lib"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import * as ssm from "aws-cdk-lib/aws-ssm"
import * as lambda from "aws-cdk-lib/aws-lambda"
import * as cr from "aws-cdk-lib/custom-resources"
import * as iam from "aws-cdk-lib/aws-iam"
import * as logs from "aws-cdk-lib/aws-logs"
import { Construct } from "constructs"
import { SharedVPC } from "./shared-vpc"
import { IEnvironmentConfig } from "../config/environment-config"

/**
 * VPC Provider for cross-stack VPC sharing.
 *
 * This provider implements a per-environment singleton pattern to ensure only one VPC
 * is created per environment, even when multiple stacks need VPC access.
 *
 * Usage in stacks:
 * ```typescript
 * const vpc = VPCProvider.getOrCreate(this, environment, config);
 * ```
 *
 * How it works:
 * 1. First stack creates the VPC and stores metadata in SSM Parameter Store
 * 2. Subsequent stacks use AwsCustomResource to look up VPC at deploy time
 * 3. The owning stack continues to synthesize the VPC resources on every deploy
 * 4. SSM parameters are automatically cleaned up when stack is deleted
 *
 * Benefits:
 * - Single VPC shared across all stacks (reduces costs)
 * - Automatic cross-stack reference handling
 * - No circular dependencies
 * - Proper cleanup on stack deletion via custom resource
 * - Full subnet metadata preserved (tags, groups, etc.)
 *
 * SSM Parameters Created:
 * - /aistudio/{environment}/vpc-id
 * - /aistudio/{environment}/vpc-owner-stack-id
 * - /aistudio/{environment}/vpc-cidr
 * - /aistudio/{environment}/vpc-azs
 * - /aistudio/{environment}/vpc-*-subnet-ids (public, private, data, isolated)
 *
 * @see https://docs.aws.amazon.com/cdk/v2/guide/resources.html#resources_referencing
 */
export class VPCProvider {
  // Cache VPC instances per environment to support multi-environment synthesis
  private static vpcInstances: Map<string, SharedVPC> = new Map()

  /**
   * Get or create the shared VPC for the environment.
   *
   * This method determines whether the current stack owns the VPC or should import it:
   * - If VPC doesn't exist yet: creates it and marks current stack as owner
   * - If current stack is the owner: continues to synthesize VPC resources
   * - If another stack owns the VPC: imports it using runtime SSM lookup
   *
   * @param scope - The construct scope
   * @param environment - The environment name (dev, staging, prod)
   * @param config - The environment configuration
   * @returns The VPC instance
   */
  public static getOrCreate(
    scope: Construct,
    environment: string,
    config: IEnvironmentConfig
  ): ec2.IVpc {
    const stack = cdk.Stack.of(scope)
    const stackId = stack.stackName

    // Determine if this stack should own the VPC based on stack name
    // DatabaseStack creates the VPC, other stacks import it
    const shouldOwnVpc = stackId.includes("DatabaseStack")

    if (shouldOwnVpc) {
      // Check if VPC already created in this synthesis (only cache for owner stack)
      const cachedVpc = this.vpcInstances.get(environment)
      if (cachedVpc) {
        return cachedVpc.vpc
      }

      // This stack owns the VPC - create it
      const vpcInstance = new SharedVPC(scope, "SharedVPC", {
        environment: environment as "dev" | "staging" | "prod",
        config,
        enableFlowLogs: true,
        enableVpcEndpoints: true,
      })

      // Store VPC metadata in SSM for cross-stack references
      this.storeVpcMetadata(scope, environment, vpcInstance, stackId)

      // Cache for this synthesis (owner stack only)
      this.vpcInstances.set(environment, vpcInstance)

      return vpcInstance.vpc
    } else {
      // Another stack owns the VPC - import it using runtime lookup
      // DO NOT cache imported VPCs to ensure each stack gets its own import construct
      return this.import(scope, environment)
    }
  }

  /**
   * Store VPC metadata in SSM Parameter Store for cross-stack references.
   *
   * Stores all VPC metadata including subnet IDs for complete cross-stack references.
   * Adds custom resource for automatic cleanup on stack deletion.
   */
  private static storeVpcMetadata(
    scope: Construct,
    environment: string,
    vpcInstance: SharedVPC,
    ownerStackId: string
  ): void {
    // Store VPC ID
    new ssm.StringParameter(scope, "VPCIdParameter", {
      parameterName: `/aistudio/${environment}/vpc-id`,
      stringValue: vpcInstance.vpc.vpcId,
      description: `Shared VPC ID for ${environment} environment`,
    })

    // Store owner stack ID
    new ssm.StringParameter(scope, "VPCOwnerStackIdParameter", {
      parameterName: `/aistudio/${environment}/vpc-owner-stack-id`,
      stringValue: ownerStackId,
      description: `Stack that owns the VPC for ${environment} environment`,
    })

    // Store VPC CIDR
    new ssm.StringParameter(scope, "VPCCidrParameter", {
      parameterName: `/aistudio/${environment}/vpc-cidr`,
      stringValue: vpcInstance.vpc.vpcCidrBlock,
      description: `VPC CIDR block for ${environment} environment`,
    })

    // Store Availability Zones
    new ssm.StringParameter(scope, "VPCAZsParameter", {
      parameterName: `/aistudio/${environment}/vpc-azs`,
      stringValue: vpcInstance.vpc.availabilityZones.join(","),
      description: `Availability zones for ${environment} environment`,
    })

    // Store Public Subnet IDs
    new ssm.StringParameter(scope, "VPCPublicSubnetIdsParameter", {
      parameterName: `/aistudio/${environment}/vpc-public-subnet-ids`,
      stringValue: vpcInstance.publicSubnets
        .map((subnet) => subnet.subnetId)
        .join(","),
      description: `Public subnet IDs for ${environment} environment`,
    })

    // Store Private Application Subnet IDs
    new ssm.StringParameter(scope, "VPCPrivateSubnetIdsParameter", {
      parameterName: `/aistudio/${environment}/vpc-private-subnet-ids`,
      stringValue: vpcInstance.privateSubnets
        .map((subnet) => subnet.subnetId)
        .join(","),
      description: `Private application subnet IDs for ${environment} environment`,
    })

    // Store Data Subnet IDs
    new ssm.StringParameter(scope, "VPCDataSubnetIdsParameter", {
      parameterName: `/aistudio/${environment}/vpc-data-subnet-ids`,
      stringValue: vpcInstance.dataSubnets
        .map((subnet) => subnet.subnetId)
        .join(","),
      description: `Private data subnet IDs for ${environment} environment`,
    })

    // Store Isolated Subnet IDs
    new ssm.StringParameter(scope, "VPCIsolatedSubnetIdsParameter", {
      parameterName: `/aistudio/${environment}/vpc-isolated-subnet-ids`,
      stringValue: vpcInstance.isolatedSubnets
        .map((subnet) => subnet.subnetId)
        .join(","),
      description: `Isolated subnet IDs for ${environment} environment`,
    })

    // Add custom resource for SSM parameter cleanup on stack deletion
    this.addSsmCleanupResource(scope, environment)
  }

  /**
   * Add custom resource to clean up SSM parameters when stack is deleted.
   *
   * This prevents orphaned parameters that could cause confusion on redeploy.
   */
  private static addSsmCleanupResource(
    scope: Construct,
    environment: string
  ): void {
    // Create log group for cleanup Lambda
    const logGroup = new logs.LogGroup(scope, "SSMCleanupLogGroup", {
      logGroupName: `/aws/lambda/vpc-ssm-cleanup-${environment}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })

    // Create explicit role to avoid CDK's deprecated fromAwsManagedPolicyName
    const cleanupLambdaRole = new iam.Role(scope, "SSMCleanupLambdaRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromManagedPolicyArn(
          scope,
          "SSMCleanupLambdaBasicExecPolicy",
          "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
        ),
      ],
    })

    // Lambda function to delete SSM parameters on stack deletion
    const cleanupLambda = new lambda.Function(scope, "SSMCleanupLambda", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      timeout: cdk.Duration.minutes(2),
      logGroup,
      role: cleanupLambdaRole,
      code: lambda.Code.fromInline(`
        const { SSMClient, DeleteParameterCommand, GetParametersByPathCommand } = require('@aws-sdk/client-ssm');

        exports.handler = async (event) => {
          console.log('Event:', JSON.stringify(event, null, 2));

          if (event.RequestType === 'Delete') {
            const ssm = new SSMClient({ region: process.env.AWS_REGION });
            const prefix = \`/aistudio/\${event.ResourceProperties.Environment}/vpc-\`;

            try {
              // Get all VPC-related parameters
              const getParams = new GetParametersByPathCommand({
                Path: \`/aistudio/\${event.ResourceProperties.Environment}\`,
                Recursive: true
              });

              const response = await ssm.send(getParams);

              // Delete each parameter
              if (response.Parameters) {
                for (const param of response.Parameters) {
                  if (param.Name.includes('vpc-')) {
                    console.log(\`Deleting parameter: \${param.Name}\`);
                    const deleteCmd = new DeleteParameterCommand({ Name: param.Name });
                    await ssm.send(deleteCmd);
                  }
                }
              }

              console.log('SSM parameters cleaned up successfully');
              return { PhysicalResourceId: event.PhysicalResourceId || 'ssm-cleanup' };
            } catch (error) {
              console.error('Error cleaning up SSM parameters:', error);
              // Don't fail the deletion - just log the error
              return { PhysicalResourceId: event.PhysicalResourceId || 'ssm-cleanup' };
            }
          }

          return { PhysicalResourceId: event.PhysicalResourceId || 'ssm-cleanup' };
        };
      `),
    })

    // Grant permissions to delete SSM parameters
    cleanupLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "ssm:DeleteParameter",
          "ssm:GetParametersByPath",
        ],
        resources: [
          `arn:aws:ssm:${cdk.Stack.of(scope).region}:${
            cdk.Stack.of(scope).account
          }:parameter/aistudio/${environment}/vpc-*`,
        ],
      })
    )

    // Create explicit role for the Provider's framework Lambda to avoid deprecated fromAwsManagedPolicyName
    const providerFrameworkRole = new iam.Role(scope, "SSMCleanupProviderFrameworkRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromManagedPolicyArn(
          scope,
          "SSMCleanupProviderFrameworkExecPolicy",
          "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
        ),
      ],
    })

    // Create custom resource provider with explicit framework role
    const provider = new cr.Provider(scope, "SSMCleanupProvider", {
      onEventHandler: cleanupLambda,
      frameworkOnEventRole: providerFrameworkRole,
      logGroup: new logs.LogGroup(scope, "SSMCleanupProviderLogGroup", {
        logGroupName: `/aws/lambda/vpc-ssm-cleanup-provider-${environment}`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    })

    // Create custom resource
    new cdk.CustomResource(scope, "SSMCleanupResource", {
      serviceToken: provider.serviceToken,
      properties: {
        Environment: environment,
      },
    })
  }

  /**
   * Import existing VPC using CDK's built-in lookup mechanism.
   *
   * This method uses Vpc.fromLookup() which resolves VPC attributes at synthesis time,
   * avoiding the CloudFormation list token warnings that occur with runtime lookups.
   *
   * The VPC is identified by its name tag, which is set when the VPC is created.
   * CDK caches the lookup results in cdk.context.json for consistent deployments.
   *
   * Benefits over previous AwsCustomResource approach:
   * - Resolves subnet lists at synthesis time (no list tokens)
   * - Automatically includes route table IDs
   * - Works with all CDK constructs requiring subnet information
   * - Simpler code (no custom resources needed)
   *
   * @param scope - The construct scope
   * @param environment - The environment name
   * @returns The imported VPC with full metadata
   */
  public static import(scope: Construct, environment: string): ec2.IVpc {
    // Use CDK's built-in VPC lookup which resolves at synthesis time
    // This avoids CloudFormation list tokens and provides full subnet metadata
    return ec2.Vpc.fromLookup(scope, "ImportedVPC", {
      vpcName: `aistudio-${environment}-vpc`,
    })
  }

  /**
   * Check if a VPC exists for the given environment.
   *
   * This is useful for conditional logic or validation before attempting
   * to create or import a VPC.
   *
   * @param scope - The construct scope
   * @param environment - The environment name
   * @returns True if VPC exists, false otherwise
   */
  public static exists(scope: Construct, environment: string): boolean {
    try {
      const vpcId = ssm.StringParameter.valueForStringParameter(
        scope,
        `/aistudio/${environment}/vpc-id`
      )
      return vpcId !== "" && vpcId !== "dummy-value"
    } catch {
      return false
    }
  }
}
