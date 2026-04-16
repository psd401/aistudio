import * as cdk from "aws-cdk-lib"

export interface DatabaseConfig {
  minCapacity: number
  maxCapacity: number
  autoPause: boolean
  backupRetention: cdk.Duration
  deletionProtection: boolean
  multiAz: boolean
}

export interface ComputeConfig {
  lambdaMemory: number
  lambdaTimeout: cdk.Duration
  ecsDesiredCount: number
  ecsFargateSpot: boolean
  ecsAutoScaling: boolean
}

export interface MonitoringConfig {
  detailedMetrics: boolean
  alarmingEnabled: boolean
  logRetention: cdk.aws_logs.RetentionDays
  tracingEnabled: boolean
}

export interface NetworkConfig {
  maxAzs: number
  natGateways: number
  vpcEndpoints: string[]
}

export interface AgentCronSchedules {
  morningBrief: string
  eveningWrap: string
  weeklySummary: string
  kaizenScan: string
}

export interface AgentConfig {
  microVmIdleTimeoutMinutes: number
  cronSchedules: AgentCronSchedules
}

export interface IEnvironmentConfig {
  database: DatabaseConfig
  compute: ComputeConfig
  monitoring: MonitoringConfig
  network: NetworkConfig
  agent: AgentConfig
  costOptimization: boolean
  securityAlertEmail?: string
}

export class EnvironmentConfig {
  private static configs: Map<string, IEnvironmentConfig> = new Map()

  static {
    // Development configuration - optimized for cost
    EnvironmentConfig.configs.set("dev", {
      database: {
        minCapacity: 0.5,
        maxCapacity: 2,
        autoPause: true,
        backupRetention: cdk.Duration.days(1),
        deletionProtection: false,
        multiAz: false,
      },
      compute: {
        lambdaMemory: 1024,
        lambdaTimeout: cdk.Duration.minutes(5),
        ecsDesiredCount: 1,
        ecsFargateSpot: true,
        ecsAutoScaling: false,
      },
      monitoring: {
        detailedMetrics: false,
        alarmingEnabled: false,
        logRetention: cdk.aws_logs.RetentionDays.ONE_WEEK,
        tracingEnabled: false,
      },
      network: {
        maxAzs: 2,
        natGateways: 1,
        vpcEndpoints: ["s3", "secretsmanager"],
      },
      agent: {
        microVmIdleTimeoutMinutes: 30,
        cronSchedules: {
          morningBrief: "cron(0 16 ? * MON-FRI *)",
          eveningWrap: "cron(0 1 ? * TUE-SAT *)",
          weeklySummary: "cron(0 22 ? * FRI *)",
          kaizenScan: "cron(0 3 ? * MON *)",
        },
      },
      costOptimization: true,
    })

    // Production configuration - cost/reliability balanced
    // Right-sized from 2-8 ACU to 1-4 based on CloudWatch metrics (issue #832):
    // avg 1.41 ACU, peak 6.0 ACU over sustained monitoring period.
    // maxCapacity set to 6 (not 4) to cover the observed 6.0 ACU peak — Aurora
    // cannot scale beyond max, so 4 would throttle during peak traffic events.
    // multiAz: false — reader removed at current traffic (avg 1.1 connections, peak 24).
    // Set multiAz: true to re-enable reader when multi-district traffic warrants it.
    EnvironmentConfig.configs.set("prod", {
      database: {
        minCapacity: 1,
        maxCapacity: 6,
        autoPause: false,
        backupRetention: cdk.Duration.days(7),
        deletionProtection: true,
        multiAz: false,
      },
      compute: {
        lambdaMemory: 3008,
        lambdaTimeout: cdk.Duration.minutes(15),
        ecsDesiredCount: 2,
        ecsFargateSpot: false,
        ecsAutoScaling: true,
      },
      monitoring: {
        detailedMetrics: true,
        alarmingEnabled: true,
        logRetention: cdk.aws_logs.RetentionDays.ONE_MONTH,
        tracingEnabled: true,
      },
      network: {
        maxAzs: 3,
        natGateways: 3,
        vpcEndpoints: [
          "s3",
          "secretsmanager",
          "rds",
          "ecs",
          "ecr",
          "logs",
        ],
      },
      agent: {
        microVmIdleTimeoutMinutes: 60,
        cronSchedules: {
          morningBrief: "cron(0 16 ? * MON-FRI *)",
          eveningWrap: "cron(0 1 ? * TUE-SAT *)",
          weeklySummary: "cron(0 22 ? * FRI *)",
          kaizenScan: "cron(0 3 ? * MON *)",
        },
      },
      costOptimization: false,
    })

    // Staging configuration - balanced
    // Note: staging has multiAz: true while prod has multiAz: false (issue #832).
    // Staging is intentionally a canary for reader-instance behavior before re-enabling
    // in prod. Once prod traffic warrants a reader, set prod.multiAz: true.
    EnvironmentConfig.configs.set("staging", {
      database: {
        minCapacity: 1,
        maxCapacity: 4,
        autoPause: false,
        backupRetention: cdk.Duration.days(3),
        deletionProtection: false,
        multiAz: true,
      },
      compute: {
        lambdaMemory: 2048,
        lambdaTimeout: cdk.Duration.minutes(10),
        ecsDesiredCount: 1,
        ecsFargateSpot: true,
        ecsAutoScaling: true,
      },
      monitoring: {
        detailedMetrics: true,
        alarmingEnabled: true,
        logRetention: cdk.aws_logs.RetentionDays.TWO_WEEKS,
        tracingEnabled: true,
      },
      network: {
        maxAzs: 2,
        natGateways: 2,
        vpcEndpoints: ["s3", "secretsmanager", "rds", "ecs"],
      },
      agent: {
        microVmIdleTimeoutMinutes: 30,
        cronSchedules: {
          morningBrief: "cron(0 16 ? * MON-FRI *)",
          eveningWrap: "cron(0 1 ? * TUE-SAT *)",
          weeklySummary: "cron(0 22 ? * FRI *)",
          kaizenScan: "cron(0 3 ? * MON *)",
        },
      },
      costOptimization: false,
    })
  }

  public static get(environment: string): IEnvironmentConfig {
    const config = this.configs.get(environment)
    if (!config) {
      throw new Error(`No configuration found for environment: ${environment}`)
    }
    return config
  }

  public static override(
    environment: string,
    overrides: Partial<IEnvironmentConfig>
  ): void {
    const baseConfig = this.get(environment)
    this.configs.set(environment, {
      ...baseConfig,
      ...overrides,
      database: { ...baseConfig.database, ...overrides.database },
      compute: { ...baseConfig.compute, ...overrides.compute },
      monitoring: { ...baseConfig.monitoring, ...overrides.monitoring },
      network: { ...baseConfig.network, ...overrides.network },
      agent: {
        ...baseConfig.agent,
        ...overrides.agent,
        cronSchedules: {
          ...baseConfig.agent.cronSchedules,
          ...overrides.agent?.cronSchedules,
        },
      },
    })
  }
}
