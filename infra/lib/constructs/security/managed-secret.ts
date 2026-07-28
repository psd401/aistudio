import * as cdk from "aws-cdk-lib"
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager"
import * as kms from "aws-cdk-lib/aws-kms"
import * as lambda from "aws-cdk-lib/aws-lambda"
import * as iam from "aws-cdk-lib/aws-iam"
import * as logs from "aws-cdk-lib/aws-logs"
import { Construct } from "constructs"
import { IEnvironmentConfig } from "../config/environment-config"
import * as path from "node:path"

/**
 * Supported secret types with their default configurations
 */
export enum SecretType {
  DATABASE = "database",
  API_KEY = "api-key",
  OAUTH = "oauth",
  CERTIFICATE = "certificate",
  CUSTOM = "custom",
}

/**
 * Configuration for a managed secret with rotation and compliance features
 */
export interface ManagedSecretProps {
  /**
   * Unique name for the secret (will be prefixed with project/environment)
   */
  readonly secretName: string

  /**
   * Human-readable description of the secret
   */
  readonly description?: string

  /**
   * Type of secret determines default rotation schedule and compliance requirements
   */
  readonly secretType: SecretType

  /**
   * Environment configuration for the deployment
   */
  readonly config: IEnvironmentConfig

  /**
   * Deployment environment (dev, staging, prod)
   */
  readonly deploymentEnvironment: string

  /**
   * Enable automatic rotation
   * @default true
   */
  readonly rotationEnabled?: boolean

  /**
   * Custom rotation schedule (overrides default for secret type)
   */
  readonly rotationSchedule?: cdk.Duration

  /**
   * Regions to replicate this secret to for disaster recovery
   * @default [] - no replication
   */
  readonly replicateToRegions?: string[]

  /**
   * Configuration for auto-generated secrets
   * If not provided, secret must be manually set after creation
   */
  readonly generateSecretString?: secretsmanager.SecretStringGenerator

  /**
   * Additional tags for compliance and organization
   */
  readonly tags?: { [key: string]: string }

  /**
   * Custom rotation Lambda function (if not using standard rotation)
   */
  readonly customRotationLambda?: lambda.IFunction

  /**
   * Project name for prefixing
   * @default "AIStudio"
   */
  readonly projectName?: string
}

/**
 * Managed Secret Construct with automatic rotation, replication, and compliance monitoring
 *
 * Features:
 * - Automatic KMS encryption with key rotation
 * - Configurable automatic rotation schedules
 * - Cross-region replication for disaster recovery
 * - Comprehensive tagging for compliance
 * - CloudWatch alarms for rotation failures
 * - CloudTrail integration for audit
 *
 * @example
 * ```typescript
 * new ManagedSecret(this, 'DatabaseSecret', {
 *   secretName: 'db-master-password',
 *   secretType: SecretType.DATABASE,
 *   config: environmentConfig,
 *   deploymentEnvironment: 'prod',
 *   rotationEnabled: true,
 *   replicateToRegions: ['us-west-2']
 * })
 * ```
 */
export class ManagedSecret extends Construct {
  public readonly secret: secretsmanager.Secret
  public readonly encryptionKey: kms.Key
  private rotationLambda?: lambda.Function
  private readonly projectName: string
  private readonly deploymentEnvironment: string

  constructor(scope: Construct, id: string, props: ManagedSecretProps) {
    super(scope, id)

    this.projectName = props.projectName || "AIStudio"
    this.deploymentEnvironment = props.deploymentEnvironment

    // Create multi-region KMS key for encryption
    this.encryptionKey = this.createEncryptionKey(props)

    // Create the secret with all configurations
    this.secret = this.createSecret(props)

    // Apply compliance tags
    this.applyComplianceTags(props)

    // Setup rotation if enabled
    if (props.rotationEnabled !== false) {
      this.setupRotation(props)
    }

    // Setup monitoring and alarms
    this.setupMonitoring(props)

    // Create CloudFormation outputs
    this.createOutputs(props)
  }

  /**
   * Creates a KMS key with automatic rotation for secret encryption
   */
  private createEncryptionKey(props: ManagedSecretProps): kms.Key {
    const key = new kms.Key(this, "EncryptionKey", {
      description: `Encryption key for ${props.secretName}`,
      enableKeyRotation: true,
      alias: `alias/${this.projectName.toLowerCase()}/${this.deploymentEnvironment}/${props.secretName}`,
      removalPolicy: this.getRemovalPolicy(props),
    })

    // Add key policy for Secrets Manager
    key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AllowSecretsManagerEncryption",
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal("secretsmanager.amazonaws.com")],
        actions: [
          "kms:Decrypt",
          "kms:DescribeKey",
          "kms:CreateGrant",
          "kms:GenerateDataKey",
        ],
        resources: ["*"],
        conditions: {
          StringEquals: {
            "kms:ViaService": `secretsmanager.${cdk.Stack.of(this).region}.amazonaws.com`,
          },
        },
      })
    )

    return key
  }

  /**
   * Creates the secret with replication if configured
   */
  private createSecret(props: ManagedSecretProps): secretsmanager.Secret {
    const fullSecretName = `/${this.projectName.toLowerCase()}/${this.deploymentEnvironment}/${props.secretName}`

    // Configure replication if specified
    const replicaRegions = props.replicateToRegions?.map((region) => ({
      region,
    }))

    return new secretsmanager.Secret(this, "Secret", {
      secretName: fullSecretName,
      description: props.description || `${props.secretType} secret for ${props.secretName}`,
      encryptionKey: this.encryptionKey,
      generateSecretString:
        props.generateSecretString ?? this.getDefaultSecretGenerator(props.secretType),
      replicaRegions,
      removalPolicy: this.getRemovalPolicy(props),
    })
  }

  /**
   * Sets up automatic rotation for the secret
   */
  private setupRotation(props: ManagedSecretProps): void {
    if (props.customRotationLambda) {
      // Use custom rotation function
      this.setupCustomRotation(props, props.customRotationLambda)
    } else {
      // For all secret types, create custom rotation lambda
      this.rotationLambda = this.createRotationLambda(props)
      this.setupCustomRotation(props, this.rotationLambda)
    }
  }

  /**
   * Creates a rotation Lambda function for non-database secrets
   */
  private createRotationLambda(props: ManagedSecretProps): lambda.Function {
    // Get the path to the rotation Lambda code based on secret type
    const rotationCodePath = this.getRotationCodePath(props.secretType)

    // Sanitize secret name for Lambda function name (replace / with -)
    const sanitizedSecretName = props.secretName.replace(/\//g, "-")

    const rotationFunction = new lambda.Function(this, "RotationFunction", {
      functionName: `${this.projectName}-${this.deploymentEnvironment}-${sanitizedSecretName}-rotation`,
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: "index.handler",
      code: lambda.Code.fromAsset(rotationCodePath),
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      architecture: lambda.Architecture.ARM_64,
      logGroup: new logs.LogGroup(this, "RotationLogGroup", {
        logGroupName: `/aws/lambda/${this.projectName}-${this.deploymentEnvironment}-${sanitizedSecretName}-rotation`,
        retention: props.config.monitoring.logRetention,
        removalPolicy: this.getRemovalPolicy(props),
      }),
      environment: {
        SECRETS_MANAGER_ENDPOINT: `https://secretsmanager.${cdk.Stack.of(this).region}.amazonaws.com`,
      },
    })

    // Grant permissions to the rotation function
    this.secret.grantRead(rotationFunction)
    this.secret.grantWrite(rotationFunction)

    // Add permissions to describe the secret
    rotationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:DescribeSecret", "secretsmanager:GetRandomPassword"],
        resources: [this.secret.secretArn],
      })
    )

    return rotationFunction
  }

  /**
   * Configures custom rotation with a Lambda function
   */
  private setupCustomRotation(
    props: ManagedSecretProps,
    rotationLambda: lambda.IFunction
  ): void {
    const schedule = props.rotationSchedule ?? this.getDefaultRotationSchedule(props.secretType)

    this.secret.addRotationSchedule("CustomRotation", {
      rotationLambda,
      automaticallyAfter: schedule,
    })
  }

  /**
   * Applies comprehensive tags for compliance and organization
   */
  private applyComplianceTags(props: ManagedSecretProps): void {
    const tags: { [key: string]: string } = {
      ManagedBy: "SecretsManager",
      SecretType: props.secretType,
      RotationEnabled: (props.rotationEnabled !== false).toString(),
      Environment: this.deploymentEnvironment,
      ProjectName: this.projectName,
      LastReviewed: new Date().toISOString().split("T")[0],
      ...props.tags,
    }

    for (const [key, value] of Object.entries(tags)) {
      cdk.Tags.of(this.secret).add(key, value)
      cdk.Tags.of(this.encryptionKey).add(key, value)
    }
  }

  /**
   * Sets up CloudWatch monitoring and alarms for rotation failures
   */
  private setupMonitoring(props: ManagedSecretProps): void {
    if (!props.config.monitoring.alarmingEnabled) {
      return
    }

    // Create alarm for rotation failures
    if (this.rotationLambda) {
      const alarm = this.rotationLambda
        .metricErrors({
          period: cdk.Duration.minutes(5),
          statistic: "Sum",
        })
        .createAlarm(this, "RotationFailureAlarm", {
          alarmName: `${this.projectName}-${this.deploymentEnvironment}-${props.secretName}-rotation-failure`,
          alarmDescription: `Secret rotation failed for ${props.secretName}`,
          threshold: 1,
          evaluationPeriods: 1,
          treatMissingData: cdk.aws_cloudwatch.TreatMissingData.NOT_BREACHING,
        })

      cdk.Tags.of(alarm).add("Critical", "true")
    }
  }

  /**
   * Creates CloudFormation outputs for secret reference
   */
  private createOutputs(props: ManagedSecretProps): void {
    new cdk.CfnOutput(this, "SecretArn", {
      value: this.secret.secretArn,
      description: `ARN of ${props.secretName} secret`,
      exportName: `${this.projectName}-${this.deploymentEnvironment}-${props.secretName}-arn`,
    })

    new cdk.CfnOutput(this, "SecretName", {
      value: this.secret.secretName,
      description: `Name of ${props.secretName} secret`,
      exportName: `${this.projectName}-${this.deploymentEnvironment}-${props.secretName}-name`,
    })
  }

  /**
   * Returns default secret string generator based on secret type
   */
  private getDefaultSecretGenerator(
    secretType: SecretType
  ): secretsmanager.SecretStringGenerator | undefined {
    const generators: Record<SecretType, secretsmanager.SecretStringGenerator | undefined> = {
      [SecretType.DATABASE]: {
        secretStringTemplate: JSON.stringify({ username: "admin" }),
        generateStringKey: "password",
        excludePunctuation: true,
        passwordLength: 32,
      },
      [SecretType.API_KEY]: {
        excludePunctuation: true,
        includeSpace: false,
        passwordLength: 64,
      },
      [SecretType.OAUTH]: undefined, // OAuth secrets should be manually configured
      [SecretType.CERTIFICATE]: undefined, // Certificates should be manually uploaded
      [SecretType.CUSTOM]: {
        excludePunctuation: true,
        passwordLength: 32,
      },
    }

    return generators[secretType]
  }

  /**
   * Returns default rotation schedule based on secret type
   */
  private getDefaultRotationSchedule(secretType: SecretType): cdk.Duration {
    const schedules: Record<SecretType, cdk.Duration> = {
      [SecretType.DATABASE]: cdk.Duration.days(30),
      [SecretType.API_KEY]: cdk.Duration.days(90),
      [SecretType.OAUTH]: cdk.Duration.days(7),
      [SecretType.CERTIFICATE]: cdk.Duration.days(60),
      [SecretType.CUSTOM]: cdk.Duration.days(90),
    }

    return schedules[secretType]
  }

  /**
   * Gets removal policy based on environment
   */
  private getRemovalPolicy(props: ManagedSecretProps): cdk.RemovalPolicy {
    return props.deploymentEnvironment === "prod"
      ? cdk.RemovalPolicy.RETAIN
      : cdk.RemovalPolicy.DESTROY
  }

  /**
   * Returns the file path to the rotation Lambda code based on secret type
   *
   * Maps secret types to their corresponding Lambda handler directories:
   * - DATABASE -> infra/lambdas/secret-rotation/database
   * - API_KEY -> infra/lambdas/secret-rotation/api-key
   * - OAUTH -> infra/lambdas/secret-rotation/oauth
   * - CUSTOM -> infra/lambdas/secret-rotation/custom
   * - CERTIFICATE -> infra/lambdas/secret-rotation/custom
   */
  private getRotationCodePath(secretType: SecretType): string {
    const rotationPaths: Record<SecretType, string> = {
      [SecretType.DATABASE]: path.join(__dirname, "../../../lambdas/secret-rotation/database"),
      [SecretType.API_KEY]: path.join(__dirname, "../../../lambdas/secret-rotation/api-key"),
      [SecretType.OAUTH]: path.join(__dirname, "../../../lambdas/secret-rotation/oauth"),
      [SecretType.CERTIFICATE]: path.join(__dirname, "../../../lambdas/secret-rotation/custom"),
      [SecretType.CUSTOM]: path.join(__dirname, "../../../lambdas/secret-rotation/custom"),
    }

    return rotationPaths[secretType]
  }

  /**
   * Grants read access to the secret
   */
  public grantRead(grantee: iam.IGrantable): iam.Grant {
    return this.secret.grantRead(grantee)
  }

  /**
   * Grants write access to the secret
   */
  public grantWrite(grantee: iam.IGrantable): iam.Grant {
    return this.secret.grantWrite(grantee)
  }

  /**
   * Grants decrypt access to the KMS key
   */
  public grantDecrypt(grantee: iam.IGrantable): iam.Grant {
    return this.encryptionKey.grantDecrypt(grantee)
  }
}
