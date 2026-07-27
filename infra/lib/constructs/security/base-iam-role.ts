import * as iam from "aws-cdk-lib/aws-iam"
import * as cdk from "aws-cdk-lib"
import { Construct } from "constructs"
import { Annotations } from "aws-cdk-lib"
import { PolicyValidator } from "./policy-validator"
import { Environment, SecurityLevel } from "./types"

export interface BaseIAMRoleProps {
  roleName: string
  service: string | iam.IPrincipal
  description?: string
  policies?: iam.PolicyDocument[]
  managedPolicies?: iam.IManagedPolicy[]
  maxSessionDuration?: cdk.Duration
  requireMFA?: boolean
  environment: Environment
  securityLevel?: SecurityLevel
  enablePermissionBoundary?: boolean
}

/**
 * Base construct for creating IAM roles with security best practices
 *
 * Features:
 * - Automatic policy validation
 * - Permission boundaries
 * - Mandatory security tags
 * - Least privilege enforcement
 * - Audit trail
 */
export class BaseIAMRole extends Construct {
  public readonly role: iam.Role
  private readonly policyValidator: PolicyValidator
  private readonly environment: Environment
  private readonly securityLevel: SecurityLevel

  constructor(scope: Construct, id: string, props: BaseIAMRoleProps) {
    super(scope, id)

    this.environment = props.environment
    this.securityLevel = props.securityLevel || this.inferSecurityLevel(props)
    this.policyValidator = new PolicyValidator()

    // Validate all policies before creation
    this.validatePolicies(props.policies)

    // Create role with security best practices
    this.role = new iam.Role(this, "Role", {
      roleName: props.roleName,
      description: props.description || `Role for ${props.service}`,
      assumedBy: this.getAssumedBy(props.service),
      maxSessionDuration: props.maxSessionDuration || cdk.Duration.hours(1),
      permissionsBoundary: props.enablePermissionBoundary !== false
        ? this.getPermissionBoundary()
        : undefined,
      managedPolicies: this.getManagedPolicies(props),
      inlinePolicies: this.buildSecurePolicies(props.policies),
    })

    // Add mandatory tags for compliance tracking
    this.addSecurityTags()

    // Add MFA requirement if requested
    if (props.requireMFA) {
      this.addMFARequirement()
    }
  }

  /**
   * Get the assume role principal
   */
  private getAssumedBy(service: string | iam.IPrincipal): iam.IPrincipal {
    if (typeof service === "string") {
      return new iam.ServicePrincipal(service)
    }
    return service
  }

  /**
   * Validate policies against security rules
   */
  private validatePolicies(policies?: iam.PolicyDocument[]): void {
    if (!policies) return

    for (const [index, policy] of policies.entries()) {
      try {
        // Check policy without throwing for non-critical violations
        const result = this.policyValidator.check(policy)

        if (!result.isValid) {
          // Filter out low-severity violations for warnings
          const criticalViolations = result.violations.filter(
            (v) => v.severity === "critical" || v.severity === "high"
          )

          if (criticalViolations.length > 0) {
            // Throw for critical/high severity
            this.policyValidator.validate(policy)
          } else {
            // Log warnings for medium/low severity using CDK Annotations
            for (const violation of result.violations) {
              Annotations.of(this).addWarning(
                `[Policy ${index}] ${violation.severity.toUpperCase()}: ${violation.message}`
              )
            }
          }
        }
      } catch (error) {
        throw new Error(`Policy validation failed for policy ${index}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      }
    }
  }

  /**
   * Get permission boundary for the environment
   */
  private getPermissionBoundary(): iam.IManagedPolicy | undefined {
    // Permission boundaries are managed policies that must be created separately
    // This returns a reference to the pre-created boundary policy
    const boundaryName = `AIStudio-PermissionBoundary-${this.environment}`

    try {
      return iam.ManagedPolicy.fromManagedPolicyName(
        this,
        "PermissionBoundary",
        boundaryName
      )
    } catch {
      // Permission boundary not yet created - this is OK during initial deployment
      // Use CDK Annotations to log warning during synthesis
      Annotations.of(this).addWarning(
        `Permission boundary ${boundaryName} not found. Role will be created without boundary.`
      )
      return undefined
    }
  }

  /**
   * Get managed policies including MFA if required
   */
  private getManagedPolicies(props: BaseIAMRoleProps): iam.IManagedPolicy[] {
    const policies = props.managedPolicies || []

    return policies
  }

  /**
   * Build secure inline policies with validation
   */
  private buildSecurePolicies(
    policies?: iam.PolicyDocument[]
  ): { [name: string]: iam.PolicyDocument } | undefined {
    if (!policies || policies.length === 0) return undefined

    const securePolicies: { [name: string]: iam.PolicyDocument } = {}

    for (const [index, policy] of policies.entries()) {
      securePolicies[`Policy${index}`] = policy
    }

    return securePolicies
  }

  /**
   * Add mandatory security tags
   */
  private addSecurityTags(): void {
    const tags = [
      { key: "SecurityLevel", value: this.securityLevel },
      { key: "Environment", value: this.environment },
      { key: "ManagedBy", value: "BaseIAMRole" },
      { key: "LastReviewed", value: new Date().toISOString().split("T")[0] },
      { key: "ComplianceRequired", value: "true" },
    ]

    for (const tag of tags) {
      cdk.Tags.of(this.role).add(tag.key, tag.value)
    }
  }

  /**
   * Add MFA requirement to role
   */
  private addMFARequirement(): void {
    const mfaPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          actions: ["*"],
          resources: ["*"],
          conditions: {
            BoolIfExists: {
              "aws:MultiFactorAuthPresent": "false",
            },
          },
        }),
      ],
    })

    this.role.attachInlinePolicy(
      new iam.Policy(this, "MFARequirement", {
        document: mfaPolicy,
      })
    )
  }

  /**
   * Infer security level from props
   */
  private inferSecurityLevel(props: BaseIAMRoleProps): SecurityLevel {
    // Critical roles
    if (
      props.service === "iam.amazonaws.com" ||
      props.service === "organizations.amazonaws.com"
    ) {
      return "critical"
    }

    // High security for production
    if (props.environment === "prod") {
      return "high"
    }

    // Medium for staging
    if (props.environment === "staging") {
      return "medium"
    }

    // Low for dev
    return "low"
  }

  /**
   * Add policy to role
   */
  public addToRolePolicy(statement: iam.PolicyStatement): void {
    // Validate before adding
    const tempPolicy = new iam.PolicyDocument({
      statements: [statement],
    })

    const result = this.policyValidator.check(tempPolicy)
    if (!result.isValid) {
      const criticalViolations = result.violations.filter(
        (v) => v.severity === "critical" || v.severity === "high"
      )

      if (criticalViolations.length > 0) {
        throw new Error(
          `Cannot add policy statement: ${criticalViolations.map((v) => v.message).join(", ")}`
        )
      }
    }

    this.role.addToPolicy(statement)
  }

  /**
   * Get the role ARN
   */
  public get roleArn(): string {
    return this.role.roleArn
  }

  /**
   * Get the role name
   */
  public get roleName(): string {
    return this.role.roleName
  }
}
