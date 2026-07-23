import * as iam from "aws-cdk-lib/aws-iam"
import {
  ValidationResult,
  ValidationRule,
  PolicyViolation,
  PolicyValidationError,
} from "./types"

/**
 * Validates IAM policies against security best practices
 */
export class PolicyValidator {
  private readonly rules: ValidationRule[]

  constructor(rules?: ValidationRule[]) {
    this.rules = rules || [
      new NoWildcardResourcesRule(),
      new MinimalActionsRule(),
      new RequireConditionsRule(),
      new NoAdminAccessRule(),
      new ResourceTagRequirementRule(),
    ]
  }

  /**
   * Validate a policy document against all rules
   * @throws PolicyValidationError if validation fails
   */
  public validate(policy: iam.PolicyDocument): ValidationResult {
    const allViolations: PolicyViolation[] = []

    for (const rule of this.rules) {
      const result = rule.validate(policy)
      if (!result.isValid) {
        allViolations.push(...result.violations)
      }
    }

    if (allViolations.length > 0) {
      throw new PolicyValidationError([
        {
          isValid: false,
          violations: allViolations,
        },
      ])
    }

    return { isValid: true, violations: [] }
  }

  /**
   * Check policy without throwing (returns result)
   */
  public check(policy: iam.PolicyDocument): ValidationResult {
    const allViolations: PolicyViolation[] = []

    for (const rule of this.rules) {
      const result = rule.validate(policy)
      if (!result.isValid) {
        allViolations.push(...result.violations)
      }
    }

    return {
      isValid: allViolations.length === 0,
      violations: allViolations,
    }
  }
}

/**
 * Rule: No wildcard resources
 * Ensures policies use specific ARNs instead of "*"
 */
export class NoWildcardResourcesRule implements ValidationRule {
  public readonly name = "NoWildcardResources"
  public readonly severity = "high" as const

  // Allowed exceptions for wildcard resources
  private readonly ALLOWED_WILDCARD_ACTIONS = [
    "xray:PutTraceSegments",
    "xray:PutTelemetryRecords",
    "logs:CreateLogGroup",
    "cloudwatch:PutMetricData",
    "ec2:DescribeNetworkInterfaces", // VPC Lambda needs this
    "ec2:CreateNetworkInterface", // Lambda VPC ENI APIs do not support resource scoping
    "ec2:DeleteNetworkInterface",
    "ec2:AssignPrivateIpAddresses",
    "ec2:UnassignPrivateIpAddresses",
    // Textract doesn't support resource-level permissions (AWS limitation)
    // See: https://docs.aws.amazon.com/textract/latest/dg/security_iam_service-with-iam.html
    "textract:StartDocumentTextDetection",
    "textract:StartDocumentAnalysis",
    "textract:GetDocumentTextDetection",
    "textract:GetDocumentAnalysis",
  ]

  public validate(policy: iam.PolicyDocument): ValidationResult {
    const statements = policy.toJSON().Statement
    const violations: PolicyViolation[] = []

    statements?.forEach((stmt: any, index: number) => {
      // Skip if no resources defined (for identity-based policies)
      if (!stmt.Resource) return

      const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource]
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action]

      // Check if resources contain wildcards
      const hasWildcard = resources.some((r: string) => r === "*" || r.endsWith(":*/*"))

      if (hasWildcard) {
        // Check if it's an allowed exception
        const isAllowedException = actions.every((action: string) =>
          this.ALLOWED_WILDCARD_ACTIONS.includes(action)
        )

        if (!isAllowedException) {
          violations.push({
            rule: this.name,
            severity: this.severity,
            message: `Statement ${index} contains wildcard resource "*". Use specific ARNs instead. Actions: ${actions.join(", ")}`,
            statementIndex: index,
            fix: "Replace wildcard with specific resource ARNs (e.g., arn:aws:s3:::bucket-name/*)",
          })
        }
      }
    })

    return {
      isValid: violations.length === 0,
      violations,
    }
  }
}

/**
 * Rule: Minimal actions
 * Ensures policies don't grant overly broad permissions
 */
export class MinimalActionsRule implements ValidationRule {
  public readonly name = "MinimalActions"
  public readonly severity = "medium" as const

  private readonly OVERLY_BROAD_ACTIONS = [
    "*:*",
    "s3:*",
    "dynamodb:*",
    "lambda:*",
    "ec2:*",
    "iam:*",
    "rds:*",
  ]

  public validate(policy: iam.PolicyDocument): ValidationResult {
    const statements = policy.toJSON().Statement
    const violations: PolicyViolation[] = []

    statements?.forEach((stmt: any, index: number) => {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action]

      actions.forEach((action: string) => {
        if (this.OVERLY_BROAD_ACTIONS.includes(action)) {
          violations.push({
            rule: this.name,
            severity: this.severity,
            message: `Statement ${index} uses overly broad action "${action}". Specify exact actions needed.`,
            statementIndex: index,
            fix: `Replace "${action}" with specific actions (e.g., "s3:GetObject", "s3:PutObject")`,
          })
        }
      })
    })

    return {
      isValid: violations.length === 0,
      violations,
    }
  }
}

/**
 * Rule: Require conditions for sensitive operations
 * Ensures sensitive operations have proper conditions
 */
export class RequireConditionsRule implements ValidationRule {
  public readonly name = "RequireConditions"
  public readonly severity = "medium" as const

  private readonly SENSITIVE_ACTIONS = [
    "iam:CreateUser",
    "iam:CreateRole",
    "iam:AttachUserPolicy",
    "iam:AttachRolePolicy",
    "iam:PutUserPolicy",
    "iam:PutRolePolicy",
    "s3:PutBucketPolicy",
    "s3:PutBucketAcl",
    "kms:CreateKey",
    "kms:ScheduleKeyDeletion",
  ]

  public validate(policy: iam.PolicyDocument): ValidationResult {
    const statements = policy.toJSON().Statement
    const violations: PolicyViolation[] = []

    statements?.forEach((stmt: any, index: number) => {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action]
      const hasSensitiveAction = actions.some((action: string) =>
        this.SENSITIVE_ACTIONS.includes(action)
      )

      if (hasSensitiveAction && !stmt.Condition) {
        violations.push({
          rule: this.name,
          severity: this.severity,
          message: `Statement ${index} performs sensitive actions without conditions. Add conditions for enhanced security.`,
          statementIndex: index,
          fix: 'Add conditions like {"StringEquals": {"aws:RequestedRegion": "us-west-2"}}',
        })
      }
    })

    return {
      isValid: violations.length === 0,
      violations,
    }
  }
}

/**
 * Rule: No admin access
 * Prevents granting full administrator access
 */
export class NoAdminAccessRule implements ValidationRule {
  public readonly name = "NoAdminAccess"
  public readonly severity = "critical" as const

  public validate(policy: iam.PolicyDocument): ValidationResult {
    const statements = policy.toJSON().Statement
    const violations: PolicyViolation[] = []

    statements?.forEach((stmt: any, index: number) => {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action]
      const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource]

      // Check for admin-like permissions
      const hasAdminActions = actions.includes("*:*") || actions.includes("*")
      const hasWildcardResource = resources.includes("*")

      if (hasAdminActions && hasWildcardResource) {
        violations.push({
          rule: this.name,
          severity: this.severity,
          message: `Statement ${index} grants administrator access (Action: *, Resource: *). This is forbidden.`,
          statementIndex: index,
          fix: "Remove this statement and grant specific permissions instead",
        })
      }
    })

    return {
      isValid: violations.length === 0,
      violations,
    }
  }
}

/**
 * Rule: Resource tag requirement
 * Ensures policies leverage resource tags for fine-grained access control
 */
export class ResourceTagRequirementRule implements ValidationRule {
  public readonly name = "ResourceTagRequirement"
  public readonly severity = "low" as const

  private readonly TAG_SENSITIVE_SERVICES = [
    "ec2",
    "s3",
    "dynamodb",
    "lambda",
    "rds",
    "elasticache",
  ]

  public validate(policy: iam.PolicyDocument): ValidationResult {
    const statements = policy.toJSON().Statement
    const violations: PolicyViolation[] = []

    statements?.forEach((stmt: any, index: number) => {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action]

      // Check if policy affects tag-sensitive services
      const affectsTagSensitiveService = actions.some((action: string) => {
        const service = action.split(":")[0]
        return this.TAG_SENSITIVE_SERVICES.includes(service)
      })

      if (affectsTagSensitiveService && !stmt.Condition) {
        violations.push({
          rule: this.name,
          severity: this.severity,
          message: `Statement ${index} could benefit from tag-based conditions for better access control.`,
          statementIndex: index,
          fix: 'Consider adding tag conditions like {"StringEquals": {"aws:ResourceTag/Environment": "production"}}',
        })
      }
    })

    return {
      isValid: violations.length === 0,
      violations,
    }
  }
}
