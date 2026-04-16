// Base constructs
export { BaseStack, BaseStackProps } from "./base/base-stack"
export { TaggingAspect, TaggingConfig } from "./base/tagging-aspect"

// Configuration
export {
  EnvironmentConfig,
  IEnvironmentConfig,
  DatabaseConfig,
  ComputeConfig,
  MonitoringConfig,
  NetworkConfig,
} from "./config/environment-config"

// Compute constructs
export { LambdaConstruct, LambdaConstructProps } from "./compute/lambda-construct"
export {
  OptimizedLambda,
  OptimizedLambdaProps,
  PerformanceProfile,
  CostTarget,
  PowerTuningConfig,
  ConcurrencyConfig,
} from "./compute/optimized-lambda"
export {
  PowerTuningStateMachine,
  PowerTuningStateMachineProps,
} from "./compute/power-tuning"
export {
  SecretCacheLayer,
  SecretCacheLayerProps,
} from "./compute/secret-cache-layer"

// Network constructs
export { SharedVPC, SharedVPCProps } from "./network/shared-vpc"
export { VPCProvider } from "./network/vpc-provider"

// Database constructs
export {
  AuroraCostOptimizer,
  AuroraCostOptimizerProps,
} from "./database/aurora-cost-optimizer"
export {
  AuroraCostDashboard,
  AuroraCostDashboardProps,
} from "./database/aurora-cost-dashboard"

// Security constructs
export {
  BaseIAMRole,
  BaseIAMRoleProps,
  ServiceRoleFactory,
  PermissionBoundaryConstruct,
  PermissionBoundaryConstructProps,
  PolicyValidator,
  NoWildcardResourcesRule,
  MinimalActionsRule,
  RequireConditionsRule,
  NoAdminAccessRule,
  ResourceTagRequirementRule,
  Environment,
  SecurityLevel,
  ValidationResult,
  ValidationRule,
  PolicyViolation,
  PolicyValidationError,
  LambdaRoleProps,
  ECSTaskRoleProps,
  ServiceRoleProps,
} from "./security"

// Observability constructs
export {
  ADOTInstrumentation,
  ADOTInstrumentationProps,
  InstrumentLambdaProps,
  InstrumentECSProps,
  IntelligentAlerting,
  IntelligentAlertingProps,
  ObservabilityDashboards,
  ObservabilityDashboardsProps,
} from "./observability"
