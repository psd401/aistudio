import * as cdk from "aws-cdk-lib"
import { EnvironmentConfig } from "../../lib/constructs/config/environment-config"

describe("EnvironmentConfig", () => {
  describe("Development Environment", () => {
    test("should return cost-optimized configuration for dev", () => {
      const config = EnvironmentConfig.get("dev")

      expect(config.costOptimization).toBe(true)
      expect(config.database.minCapacity).toBe(0.5)
      expect(config.database.maxCapacity).toBe(2)
      expect(config.database.autoPause).toBe(true)
      expect(config.database.deletionProtection).toBe(false)
      expect(config.database.multiAz).toBe(false)
    })

    test("should have minimal compute configuration for dev", () => {
      const config = EnvironmentConfig.get("dev")

      expect(config.compute.lambdaMemory).toBe(1024)
      expect(config.compute.lambdaTimeout).toEqual(cdk.Duration.minutes(5))
      expect(config.compute.ecsDesiredCount).toBe(1)
      expect(config.compute.ecsFargateSpot).toBe(true)
      expect(config.compute.ecsAutoScaling).toBe(false)
    })

    test("should have minimal monitoring for dev", () => {
      const config = EnvironmentConfig.get("dev")

      expect(config.monitoring.detailedMetrics).toBe(false)
      expect(config.monitoring.alarmingEnabled).toBe(false)
      expect(config.monitoring.logRetention).toBe(cdk.aws_logs.RetentionDays.ONE_WEEK)
      expect(config.monitoring.tracingEnabled).toBe(false)
    })

    test("should have minimal network configuration for dev", () => {
      const config = EnvironmentConfig.get("dev")

      expect(config.network.maxAzs).toBe(2)
      expect(config.network.natGateways).toBe(1)
      expect(config.network.vpcEndpoints).toEqual(["s3", "secretsmanager"])
    })

    test("should have short backup retention for dev", () => {
      const config = EnvironmentConfig.get("dev")

      expect(config.database.backupRetention).toEqual(cdk.Duration.days(1))
    })
  })

  describe("Production Environment", () => {
    test("should return reliability-optimized configuration for prod", () => {
      const config = EnvironmentConfig.get("prod")

      expect(config.costOptimization).toBe(false)
      expect(config.database.minCapacity).toBe(1)
      expect(config.database.maxCapacity).toBe(4)
      expect(config.database.autoPause).toBe(false)
      expect(config.database.deletionProtection).toBe(true)
      expect(config.database.multiAz).toBe(false)
    })

    test("should have maximum compute configuration for prod", () => {
      const config = EnvironmentConfig.get("prod")

      expect(config.compute.lambdaMemory).toBe(3008)
      expect(config.compute.lambdaTimeout).toEqual(cdk.Duration.minutes(15))
      expect(config.compute.ecsDesiredCount).toBe(2)
      expect(config.compute.ecsFargateSpot).toBe(false)
      expect(config.compute.ecsAutoScaling).toBe(true)
    })

    test("should have comprehensive monitoring for prod", () => {
      const config = EnvironmentConfig.get("prod")

      expect(config.monitoring.detailedMetrics).toBe(true)
      expect(config.monitoring.alarmingEnabled).toBe(true)
      expect(config.monitoring.logRetention).toBe(cdk.aws_logs.RetentionDays.ONE_MONTH)
      expect(config.monitoring.tracingEnabled).toBe(true)
    })

    test("should have comprehensive network configuration for prod", () => {
      const config = EnvironmentConfig.get("prod")

      expect(config.network.maxAzs).toBe(3)
      expect(config.network.natGateways).toBe(3)
      expect(config.network.vpcEndpoints).toEqual([
        "s3",
        "secretsmanager",
        "rds",
        "ecs",
        "ecr",
        "logs",
      ])
    })

    test("should have longer backup retention for prod", () => {
      const config = EnvironmentConfig.get("prod")

      expect(config.database.backupRetention).toEqual(cdk.Duration.days(7))
    })
  })

  describe("Staging Environment", () => {
    test("should return balanced configuration for staging", () => {
      const config = EnvironmentConfig.get("staging")

      expect(config.costOptimization).toBe(false)
      expect(config.database.minCapacity).toBe(1)
      expect(config.database.maxCapacity).toBe(4)
      expect(config.database.autoPause).toBe(false)
      expect(config.database.deletionProtection).toBe(false)
      expect(config.database.multiAz).toBe(true)
    })

    test("should have moderate compute configuration for staging", () => {
      const config = EnvironmentConfig.get("staging")

      expect(config.compute.lambdaMemory).toBe(2048)
      expect(config.compute.lambdaTimeout).toEqual(cdk.Duration.minutes(10))
      expect(config.compute.ecsDesiredCount).toBe(1)
      expect(config.compute.ecsFargateSpot).toBe(true)
      expect(config.compute.ecsAutoScaling).toBe(true)
    })

    test("should have comprehensive monitoring for staging", () => {
      const config = EnvironmentConfig.get("staging")

      expect(config.monitoring.detailedMetrics).toBe(true)
      expect(config.monitoring.alarmingEnabled).toBe(true)
      expect(config.monitoring.logRetention).toBe(cdk.aws_logs.RetentionDays.TWO_WEEKS)
      expect(config.monitoring.tracingEnabled).toBe(true)
    })

    test("should have moderate network configuration for staging", () => {
      const config = EnvironmentConfig.get("staging")

      expect(config.network.maxAzs).toBe(2)
      expect(config.network.natGateways).toBe(2)
      expect(config.network.vpcEndpoints).toEqual([
        "s3",
        "secretsmanager",
        "rds",
        "ecs",
      ])
    })

    test("should have moderate backup retention for staging", () => {
      const config = EnvironmentConfig.get("staging")

      expect(config.database.backupRetention).toEqual(cdk.Duration.days(3))
    })
  })

  describe("Error Handling", () => {
    test("should throw error for unknown environment", () => {
      expect(() => EnvironmentConfig.get("unknown")).toThrow(
        "No configuration found for environment: unknown"
      )
    })

    test("should throw error for empty environment", () => {
      expect(() => EnvironmentConfig.get("")).toThrow(
        "No configuration found for environment: "
      )
    })
  })

  describe("Configuration Override", () => {
    // Save original configs to restore after tests
    const originalDevConfig = EnvironmentConfig.get("dev")

    afterEach(() => {
      // Restore original config after each test
      EnvironmentConfig.override("dev", originalDevConfig)
    })

    test("should allow overriding specific configuration values", () => {
      EnvironmentConfig.override("dev", {
        database: {
          minCapacity: 1,
          maxCapacity: 4,
          autoPause: false,
          backupRetention: cdk.Duration.days(7),
          deletionProtection: true,
          multiAz: true,
        },
      })

      const config = EnvironmentConfig.get("dev")

      expect(config.database.minCapacity).toBe(1)
      expect(config.database.maxCapacity).toBe(4)
      expect(config.database.autoPause).toBe(false)
    })

    test("should preserve non-overridden configuration values", () => {
      const originalConfig = EnvironmentConfig.get("dev")
      const originalLambdaMemory = originalConfig.compute.lambdaMemory

      EnvironmentConfig.override("dev", {
        database: {
          minCapacity: 1,
          maxCapacity: 4,
          autoPause: false,
          backupRetention: cdk.Duration.days(7),
          deletionProtection: true,
          multiAz: true,
        },
      })

      const config = EnvironmentConfig.get("dev")

      // Database config should be overridden
      expect(config.database.minCapacity).toBe(1)

      // Other configs should remain unchanged
      expect(config.compute.lambdaMemory).toBe(originalLambdaMemory)
      expect(config.monitoring.detailedMetrics).toBe(false)
      expect(config.network.natGateways).toBe(1)
    })

    test("should allow partial override of nested configuration", () => {
      EnvironmentConfig.override("dev", {
        compute: {
          lambdaMemory: 2048,
          lambdaTimeout: cdk.Duration.minutes(10),
          ecsDesiredCount: 2,
          ecsFargateSpot: false,
          ecsAutoScaling: true,
        },
      })

      const config = EnvironmentConfig.get("dev")

      expect(config.compute.lambdaMemory).toBe(2048)
      expect(config.compute.lambdaTimeout).toEqual(cdk.Duration.minutes(10))

      // Database config should remain unchanged
      expect(config.database.minCapacity).toBe(0.5)
    })
  })

  describe("Type Safety", () => {
    test("should have all required database configuration fields", () => {
      const config = EnvironmentConfig.get("dev")

      expect(config.database).toHaveProperty("minCapacity")
      expect(config.database).toHaveProperty("maxCapacity")
      expect(config.database).toHaveProperty("autoPause")
      expect(config.database).toHaveProperty("backupRetention")
      expect(config.database).toHaveProperty("deletionProtection")
      expect(config.database).toHaveProperty("multiAz")
    })

    test("should have all required compute configuration fields", () => {
      const config = EnvironmentConfig.get("dev")

      expect(config.compute).toHaveProperty("lambdaMemory")
      expect(config.compute).toHaveProperty("lambdaTimeout")
      expect(config.compute).toHaveProperty("ecsDesiredCount")
      expect(config.compute).toHaveProperty("ecsFargateSpot")
      expect(config.compute).toHaveProperty("ecsAutoScaling")
    })

    test("should have all required monitoring configuration fields", () => {
      const config = EnvironmentConfig.get("dev")

      expect(config.monitoring).toHaveProperty("detailedMetrics")
      expect(config.monitoring).toHaveProperty("alarmingEnabled")
      expect(config.monitoring).toHaveProperty("logRetention")
      expect(config.monitoring).toHaveProperty("tracingEnabled")
    })

    test("should have all required network configuration fields", () => {
      const config = EnvironmentConfig.get("dev")

      expect(config.network).toHaveProperty("maxAzs")
      expect(config.network).toHaveProperty("natGateways")
      expect(config.network).toHaveProperty("vpcEndpoints")
    })

    test("should have costOptimization field", () => {
      const config = EnvironmentConfig.get("dev")

      expect(config).toHaveProperty("costOptimization")
      expect(typeof config.costOptimization).toBe("boolean")
    })
  })

  describe("Configuration Consistency", () => {
    test("dev should be more cost-optimized than prod", () => {
      const devConfig = EnvironmentConfig.get("dev")
      const prodConfig = EnvironmentConfig.get("prod")

      expect(devConfig.database.minCapacity).toBeLessThan(prodConfig.database.minCapacity)
      expect(devConfig.compute.lambdaMemory).toBeLessThan(prodConfig.compute.lambdaMemory)
      expect(devConfig.network.natGateways).toBeLessThan(prodConfig.network.natGateways)
    })

    test("prod should have better reliability than dev", () => {
      const devConfig = EnvironmentConfig.get("dev")
      const prodConfig = EnvironmentConfig.get("prod")

      // multiAz disabled for prod (reader instance removed per #832 — re-add when traffic warrants)
      expect(prodConfig.database.multiAz).toBe(false)
      expect(devConfig.database.multiAz).toBe(false)

      expect(prodConfig.database.deletionProtection).toBe(true)
      expect(devConfig.database.deletionProtection).toBe(false)

      expect(prodConfig.monitoring.detailedMetrics).toBe(true)
      expect(devConfig.monitoring.detailedMetrics).toBe(false)
    })

    test("staging should be between dev and prod", () => {
      const devConfig = EnvironmentConfig.get("dev")
      const stagingConfig = EnvironmentConfig.get("staging")
      const prodConfig = EnvironmentConfig.get("prod")

      expect(stagingConfig.database.minCapacity).toBeGreaterThan(devConfig.database.minCapacity)
      // Staging and prod now share same min ACU (1) after right-sizing per #832
      expect(stagingConfig.database.minCapacity).toBeLessThanOrEqual(prodConfig.database.minCapacity)

      expect(stagingConfig.compute.lambdaMemory).toBeGreaterThan(devConfig.compute.lambdaMemory)
      expect(stagingConfig.compute.lambdaMemory).toBeLessThan(prodConfig.compute.lambdaMemory)
    })
  })
})
