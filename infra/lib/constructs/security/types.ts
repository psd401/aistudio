import * as iam from "aws-cdk-lib/aws-iam"
import * as cdk from "aws-cdk-lib"

/**
 * Environment types for IAM resources
 */
export type Environment = "dev" | "staging" | "prod"

/**
 * Security level for IAM roles
 */
export type SecurityLevel = "low" | "medium" | "high" | "critical"

/**
 * Validation result from policy validation
 */
export interface ValidationResult {
  isValid: boolean
  violations: PolicyViolation[]
}

/**
 * Individual policy violation
 */
export interface PolicyViolation {
  rule: string
  severity: "low" | "medium" | "high" | "critical"
  message: string
  statementIndex?: number
  fix?: string
}

/**
 * Policy validation error thrown when validation fails
 */
export class PolicyValidationError extends Error {
  constructor(public readonly results: ValidationResult[]) {
    const messages = results.map((r) => r.violations.map((v) => v.message).join("\n")).join("\n")
    super(`Policy validation failed:\n${messages}`)
    this.name = "PolicyValidationError"
  }
}

/**
 * Validation rule interface
 */
export interface ValidationRule {
  name: string
  severity: "low" | "medium" | "high" | "critical"
  validate(policy: iam.PolicyDocument): ValidationResult
}

/**
 * Audit report for IAM policies
 */
export interface AuditReport {
  totalPolicies: number
  violationsFound: number
  violations: PolicyAuditViolation[]
  timestamp: string
  environment: Environment
}

/**
 * Policy audit violation (for existing policies)
 */
export interface PolicyAuditViolation {
  policyArn: string
  policyName: string
  issues: PolicyViolation[]
  riskLevel: number
}

/**
 * Props for service role factory
 */
export interface ServiceRoleProps {
  environment: Environment
  region: string
  account: string
  additionalPolicies?: iam.PolicyDocument[]
  /**
   * Set false ONLY for roles whose duties the account-wide
   * AIStudio-PermissionBoundary cannot express (e.g. secretsmanager write
   * actions — the boundary deliberately allows secrets READS only). The
   * role's identity policies remain the sole grant, so keep them exact-ARN.
   * Precedent: the AgentCore execution role (full factory bypass).
   */
  enablePermissionBoundary?: boolean
}

/**
 * Lambda role specific props
 */
export interface LambdaRoleProps extends ServiceRoleProps {
  functionName: string
  vpcEnabled?: boolean
  secrets?: string[]
  s3Buckets?: string[]
  dynamodbTables?: string[]
  sqsQueues?: string[]
  snsTopics?: string[]
}

/**
 * ECS task role specific props
 */
export interface ECSTaskRoleProps extends ServiceRoleProps {
  taskName: string
  secrets?: string[]
  s3Buckets?: string[]
  dynamodbTables?: string[]
  sqsQueues?: string[]
  snsTopics?: string[]
  ecrRepositories?: string[]
}

/**
 * Permission boundary configuration
 */
export interface PermissionBoundaryConfig {
  environment: Environment
  maxSessionDuration: cdk.Duration
  allowedServices: string[]
  deniedActions: string[]
}
