import * as cdk from "aws-cdk-lib"
import { Construct } from "constructs"
import { TaggingAspect } from "./tagging-aspect"
import { IEnvironmentConfig } from "../config/environment-config"

export interface BaseStackProps extends cdk.StackProps {
  deploymentEnvironment: "dev" | "staging" | "prod"
  config: IEnvironmentConfig
  projectName?: string
  owner?: string
  alertEmail?: string
}

export abstract class BaseStack extends cdk.Stack {
  public readonly deploymentEnvironment: string
  public readonly config: IEnvironmentConfig
  protected readonly projectName: string

  constructor(scope: Construct, id: string, props: BaseStackProps) {
    // Extract our custom properties and pass only StackProps to parent
    const {
      deploymentEnvironment,
      config,
      projectName,
      owner: _owner,
      ...stackProps
    } = props

    super(scope, id, {
      ...stackProps,
      stackName: `${projectName || "AIStudio"}-${id}-${deploymentEnvironment}`,
      description: `${id} for ${deploymentEnvironment} environment`,
      terminationProtection: deploymentEnvironment === "prod",
    })

    this.deploymentEnvironment = deploymentEnvironment
    this.config = config
    this.projectName = projectName || "AIStudio"

    // Apply tagging aspect automatically
    cdk.Aspects.of(this).add(
      new TaggingAspect({
        environment: props.deploymentEnvironment,
        projectName: this.projectName,
        owner: props.owner || "TSD Engineering",
        stackName: this.stackName,
      })
    )

    // Add standard outputs
    this.addStandardOutputs()

    // Call abstract initialization method
    this.defineResources(props)
  }

  /**
   * Abstract method that child classes must implement to define their resources
   */
  protected abstract defineResources(props: BaseStackProps): void

  /**
   * Helper method to get environment-specific values
   */
  protected getEnvValue<T>(devValue: T, prodValue: T): T {
    return this.deploymentEnvironment === "prod" ? prodValue : devValue
  }

  /**
   * Helper to determine removal policy based on environment
   */
  protected getRemovalPolicy(): cdk.RemovalPolicy {
    return this.deploymentEnvironment === "prod"
      ? cdk.RemovalPolicy.RETAIN
      : cdk.RemovalPolicy.DESTROY
  }

  /**
   * Add standard CloudFormation outputs
   */
  private addStandardOutputs(): void {
    new cdk.CfnOutput(this, "StackEnvironment", {
      value: this.deploymentEnvironment,
      description: "Environment for this stack",
      exportName: `${this.stackName}-Environment`,
    })

    new cdk.CfnOutput(this, "StackVersion", {
      value: process.env.CDK_VERSION || "unknown",
      description: "CDK version used for deployment",
    })
  }

  /**
   * Helper to create SSM parameters for cross-stack references
   */
  protected createParameter(
    name: string,
    value: string,
    description?: string
  ): void {
    new cdk.aws_ssm.StringParameter(this, `${name}Param`, {
      parameterName: `/${this.projectName.toLowerCase()}/${this.deploymentEnvironment}/${name}`,
      stringValue: value,
      description: description || `${name} for ${this.stackName}`,
    })
  }
}
