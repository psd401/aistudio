import * as iam from "aws-cdk-lib/aws-iam"
import * as cdk from "aws-cdk-lib"
import { Construct } from "constructs"
import * as fs from "node:fs"
import * as path from "node:path"
import { Environment } from "./types"

export interface PermissionBoundaryConstructProps {
  environment: Environment
}

/**
 * Construct to deploy permission boundary policies
 */
export class PermissionBoundaryConstruct extends Construct {
  public readonly policy: iam.ManagedPolicy

  constructor(scope: Construct, id: string, props: PermissionBoundaryConstructProps) {
    super(scope, id)

    // Load the appropriate boundary policy document
    const policyDocument = this.loadPolicyDocument(props.environment)

    // Create the managed policy
    this.policy = new iam.ManagedPolicy(this, "PermissionBoundary", {
      managedPolicyName: `AIStudio-PermissionBoundary-${props.environment}`,
      description: `Permission boundary for AI Studio ${props.environment} environment`,
      document: iam.PolicyDocument.fromJson(policyDocument),
    })

    // Add tags for compliance
    cdk.Tags.of(this.policy).add("Environment", props.environment)
    cdk.Tags.of(this.policy).add("Purpose", "PermissionBoundary")
    cdk.Tags.of(this.policy).add("ManagedBy", "CDK")
  }

  private loadPolicyDocument(environment: Environment): unknown {
    // Map staging to dev boundary for now
    const boundaryEnv = environment === "staging" ? "dev" : environment

    const policyPath = path.join(
      __dirname,
      "permission-boundaries",
      `${boundaryEnv}-boundary.json`
    )

    if (!fs.existsSync(policyPath)) {
      throw new Error(`Permission boundary policy not found: ${policyPath}`)
    }

    return JSON.parse(fs.readFileSync(policyPath, "utf-8"))
  }

  /**
   * Get the policy ARN for attaching as a permission boundary
   */
  public get policyArn(): string {
    return this.policy.managedPolicyArn
  }
}
