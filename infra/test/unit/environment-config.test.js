"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const cdk = __importStar(require("aws-cdk-lib"));
const environment_config_1 = require("../../lib/constructs/config/environment-config");
describe("EnvironmentConfig", () => {
    describe("Development Environment", () => {
        test("should return cost-optimized configuration for dev", () => {
            const config = environment_config_1.EnvironmentConfig.get("dev");
            expect(config.costOptimization).toBe(true);
            expect(config.database.minCapacity).toBe(0.5);
            expect(config.database.maxCapacity).toBe(2);
            expect(config.database.autoPause).toBe(true);
            expect(config.database.deletionProtection).toBe(false);
            expect(config.database.multiAz).toBe(false);
        });
        test("should have minimal compute configuration for dev", () => {
            const config = environment_config_1.EnvironmentConfig.get("dev");
            expect(config.compute.lambdaMemory).toBe(1024);
            expect(config.compute.lambdaTimeout).toEqual(cdk.Duration.minutes(5));
            expect(config.compute.ecsDesiredCount).toBe(1);
            expect(config.compute.ecsFargateSpot).toBe(true);
            expect(config.compute.ecsAutoScaling).toBe(false);
        });
        test("should have minimal monitoring for dev", () => {
            const config = environment_config_1.EnvironmentConfig.get("dev");
            expect(config.monitoring.detailedMetrics).toBe(false);
            expect(config.monitoring.alarmingEnabled).toBe(false);
            expect(config.monitoring.logRetention).toBe(cdk.aws_logs.RetentionDays.ONE_WEEK);
            expect(config.monitoring.tracingEnabled).toBe(false);
        });
        test("should have minimal network configuration for dev", () => {
            const config = environment_config_1.EnvironmentConfig.get("dev");
            expect(config.network.maxAzs).toBe(2);
            expect(config.network.natGateways).toBe(1);
            expect(config.network.vpcEndpoints).toEqual(["s3", "secretsmanager"]);
        });
        test("should have short backup retention for dev", () => {
            const config = environment_config_1.EnvironmentConfig.get("dev");
            expect(config.database.backupRetention).toEqual(cdk.Duration.days(1));
        });
    });
    describe("Production Environment", () => {
        test("should return reliability-optimized configuration for prod", () => {
            const config = environment_config_1.EnvironmentConfig.get("prod");
            expect(config.costOptimization).toBe(false);
            expect(config.database.minCapacity).toBe(1);
            expect(config.database.maxCapacity).toBe(6);
            expect(config.database.autoPause).toBe(false);
            expect(config.database.deletionProtection).toBe(true);
            expect(config.database.multiAz).toBe(false);
        });
        test("should have maximum compute configuration for prod", () => {
            const config = environment_config_1.EnvironmentConfig.get("prod");
            expect(config.compute.lambdaMemory).toBe(3008);
            expect(config.compute.lambdaTimeout).toEqual(cdk.Duration.minutes(15));
            expect(config.compute.ecsDesiredCount).toBe(2);
            expect(config.compute.ecsFargateSpot).toBe(false);
            expect(config.compute.ecsAutoScaling).toBe(true);
        });
        test("should have comprehensive monitoring for prod", () => {
            const config = environment_config_1.EnvironmentConfig.get("prod");
            expect(config.monitoring.detailedMetrics).toBe(true);
            expect(config.monitoring.alarmingEnabled).toBe(true);
            expect(config.monitoring.logRetention).toBe(cdk.aws_logs.RetentionDays.ONE_MONTH);
            expect(config.monitoring.tracingEnabled).toBe(true);
        });
        test("should have comprehensive network configuration for prod", () => {
            const config = environment_config_1.EnvironmentConfig.get("prod");
            expect(config.network.maxAzs).toBe(3);
            expect(config.network.natGateways).toBe(3);
            expect(config.network.vpcEndpoints).toEqual([
                "s3",
                "secretsmanager",
                "rds",
                "ecs",
                "ecr",
                "logs",
            ]);
        });
        test("should have longer backup retention for prod", () => {
            const config = environment_config_1.EnvironmentConfig.get("prod");
            expect(config.database.backupRetention).toEqual(cdk.Duration.days(7));
        });
    });
    describe("Staging Environment", () => {
        test("should return balanced configuration for staging", () => {
            const config = environment_config_1.EnvironmentConfig.get("staging");
            expect(config.costOptimization).toBe(false);
            expect(config.database.minCapacity).toBe(1);
            expect(config.database.maxCapacity).toBe(4);
            expect(config.database.autoPause).toBe(false);
            expect(config.database.deletionProtection).toBe(false);
            expect(config.database.multiAz).toBe(true);
        });
        test("should have moderate compute configuration for staging", () => {
            const config = environment_config_1.EnvironmentConfig.get("staging");
            expect(config.compute.lambdaMemory).toBe(2048);
            expect(config.compute.lambdaTimeout).toEqual(cdk.Duration.minutes(10));
            expect(config.compute.ecsDesiredCount).toBe(1);
            expect(config.compute.ecsFargateSpot).toBe(true);
            expect(config.compute.ecsAutoScaling).toBe(true);
        });
        test("should have comprehensive monitoring for staging", () => {
            const config = environment_config_1.EnvironmentConfig.get("staging");
            expect(config.monitoring.detailedMetrics).toBe(true);
            expect(config.monitoring.alarmingEnabled).toBe(true);
            expect(config.monitoring.logRetention).toBe(cdk.aws_logs.RetentionDays.TWO_WEEKS);
            expect(config.monitoring.tracingEnabled).toBe(true);
        });
        test("should have moderate network configuration for staging", () => {
            const config = environment_config_1.EnvironmentConfig.get("staging");
            expect(config.network.maxAzs).toBe(2);
            expect(config.network.natGateways).toBe(2);
            expect(config.network.vpcEndpoints).toEqual([
                "s3",
                "secretsmanager",
                "rds",
                "ecs",
            ]);
        });
        test("should have moderate backup retention for staging", () => {
            const config = environment_config_1.EnvironmentConfig.get("staging");
            expect(config.database.backupRetention).toEqual(cdk.Duration.days(3));
        });
    });
    describe("Error Handling", () => {
        test("should throw error for unknown environment", () => {
            expect(() => environment_config_1.EnvironmentConfig.get("unknown")).toThrow("No configuration found for environment: unknown");
        });
        test("should throw error for empty environment", () => {
            expect(() => environment_config_1.EnvironmentConfig.get("")).toThrow("No configuration found for environment: ");
        });
    });
    describe("Configuration Override", () => {
        // Save original configs to restore after tests
        const originalDevConfig = environment_config_1.EnvironmentConfig.get("dev");
        afterEach(() => {
            // Restore original config after each test
            environment_config_1.EnvironmentConfig.override("dev", originalDevConfig);
        });
        test("should allow overriding specific configuration values", () => {
            environment_config_1.EnvironmentConfig.override("dev", {
                database: {
                    minCapacity: 1,
                    maxCapacity: 4,
                    autoPause: false,
                    backupRetention: cdk.Duration.days(7),
                    deletionProtection: true,
                    multiAz: true,
                },
            });
            const config = environment_config_1.EnvironmentConfig.get("dev");
            expect(config.database.minCapacity).toBe(1);
            expect(config.database.maxCapacity).toBe(4);
            expect(config.database.autoPause).toBe(false);
        });
        test("should preserve non-overridden configuration values", () => {
            const originalConfig = environment_config_1.EnvironmentConfig.get("dev");
            const originalLambdaMemory = originalConfig.compute.lambdaMemory;
            environment_config_1.EnvironmentConfig.override("dev", {
                database: {
                    minCapacity: 1,
                    maxCapacity: 4,
                    autoPause: false,
                    backupRetention: cdk.Duration.days(7),
                    deletionProtection: true,
                    multiAz: true,
                },
            });
            const config = environment_config_1.EnvironmentConfig.get("dev");
            // Database config should be overridden
            expect(config.database.minCapacity).toBe(1);
            // Other configs should remain unchanged
            expect(config.compute.lambdaMemory).toBe(originalLambdaMemory);
            expect(config.monitoring.detailedMetrics).toBe(false);
            expect(config.network.natGateways).toBe(1);
        });
        test("should allow partial override of nested configuration", () => {
            environment_config_1.EnvironmentConfig.override("dev", {
                compute: {
                    lambdaMemory: 2048,
                    lambdaTimeout: cdk.Duration.minutes(10),
                    ecsDesiredCount: 2,
                    ecsFargateSpot: false,
                    ecsAutoScaling: true,
                },
            });
            const config = environment_config_1.EnvironmentConfig.get("dev");
            expect(config.compute.lambdaMemory).toBe(2048);
            expect(config.compute.lambdaTimeout).toEqual(cdk.Duration.minutes(10));
            // Database config should remain unchanged
            expect(config.database.minCapacity).toBe(0.5);
        });
    });
    describe("Type Safety", () => {
        test("should have all required database configuration fields", () => {
            const config = environment_config_1.EnvironmentConfig.get("dev");
            expect(config.database).toHaveProperty("minCapacity");
            expect(config.database).toHaveProperty("maxCapacity");
            expect(config.database).toHaveProperty("autoPause");
            expect(config.database).toHaveProperty("backupRetention");
            expect(config.database).toHaveProperty("deletionProtection");
            expect(config.database).toHaveProperty("multiAz");
        });
        test("should have all required compute configuration fields", () => {
            const config = environment_config_1.EnvironmentConfig.get("dev");
            expect(config.compute).toHaveProperty("lambdaMemory");
            expect(config.compute).toHaveProperty("lambdaTimeout");
            expect(config.compute).toHaveProperty("ecsDesiredCount");
            expect(config.compute).toHaveProperty("ecsFargateSpot");
            expect(config.compute).toHaveProperty("ecsAutoScaling");
        });
        test("should have all required monitoring configuration fields", () => {
            const config = environment_config_1.EnvironmentConfig.get("dev");
            expect(config.monitoring).toHaveProperty("detailedMetrics");
            expect(config.monitoring).toHaveProperty("alarmingEnabled");
            expect(config.monitoring).toHaveProperty("logRetention");
            expect(config.monitoring).toHaveProperty("tracingEnabled");
        });
        test("should have all required network configuration fields", () => {
            const config = environment_config_1.EnvironmentConfig.get("dev");
            expect(config.network).toHaveProperty("maxAzs");
            expect(config.network).toHaveProperty("natGateways");
            expect(config.network).toHaveProperty("vpcEndpoints");
        });
        test("should have costOptimization field", () => {
            const config = environment_config_1.EnvironmentConfig.get("dev");
            expect(config).toHaveProperty("costOptimization");
            expect(typeof config.costOptimization).toBe("boolean");
        });
    });
    describe("Configuration Consistency", () => {
        test("dev should be more cost-optimized than prod", () => {
            const devConfig = environment_config_1.EnvironmentConfig.get("dev");
            const prodConfig = environment_config_1.EnvironmentConfig.get("prod");
            expect(devConfig.database.minCapacity).toBeLessThan(prodConfig.database.minCapacity);
            expect(devConfig.compute.lambdaMemory).toBeLessThan(prodConfig.compute.lambdaMemory);
            expect(devConfig.network.natGateways).toBeLessThan(prodConfig.network.natGateways);
        });
        test("prod should have better reliability than dev", () => {
            const devConfig = environment_config_1.EnvironmentConfig.get("dev");
            const prodConfig = environment_config_1.EnvironmentConfig.get("prod");
            // multiAz disabled for prod (reader instance removed per #832)
            expect(prodConfig.database.multiAz).toBe(false);
            expect(devConfig.database.multiAz).toBe(false);
            expect(prodConfig.database.deletionProtection).toBe(true);
            expect(devConfig.database.deletionProtection).toBe(false);
            expect(prodConfig.monitoring.detailedMetrics).toBe(true);
            expect(devConfig.monitoring.detailedMetrics).toBe(false);
        });
        test("staging should be between dev and prod", () => {
            const devConfig = environment_config_1.EnvironmentConfig.get("dev");
            const stagingConfig = environment_config_1.EnvironmentConfig.get("staging");
            const prodConfig = environment_config_1.EnvironmentConfig.get("prod");
            expect(stagingConfig.database.minCapacity).toBeGreaterThan(devConfig.database.minCapacity);
            // Staging and prod now share same min ACU (1) after right-sizing per #832
            expect(stagingConfig.database.minCapacity).toBeLessThanOrEqual(prodConfig.database.minCapacity);
            expect(stagingConfig.compute.lambdaMemory).toBeGreaterThan(devConfig.compute.lambdaMemory);
            expect(stagingConfig.compute.lambdaMemory).toBeLessThan(prodConfig.compute.lambdaMemory);
        });
    });
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZW52aXJvbm1lbnQtY29uZmlnLnRlc3QuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJlbnZpcm9ubWVudC1jb25maWcudGVzdC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLGlEQUFrQztBQUNsQyx1RkFBa0Y7QUFFbEYsUUFBUSxDQUFDLG1CQUFtQixFQUFFLEdBQUcsRUFBRTtJQUNqQyxRQUFRLENBQUMseUJBQXlCLEVBQUUsR0FBRyxFQUFFO1FBQ3ZDLElBQUksQ0FBQyxvREFBb0QsRUFBRSxHQUFHLEVBQUU7WUFDOUQsTUFBTSxNQUFNLEdBQUcsc0NBQWlCLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFBO1lBRTNDLE1BQU0sQ0FBQyxNQUFNLENBQUMsZ0JBQWdCLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUE7WUFDMUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsV0FBVyxDQUFDLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFBO1lBQzdDLE1BQU0sQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLFdBQVcsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQTtZQUMzQyxNQUFNLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxTQUFTLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUE7WUFDNUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsa0JBQWtCLENBQUMsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUE7WUFDdEQsTUFBTSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFBO1FBQzdDLENBQUMsQ0FBQyxDQUFBO1FBRUYsSUFBSSxDQUFDLG1EQUFtRCxFQUFFLEdBQUcsRUFBRTtZQUM3RCxNQUFNLE1BQU0sR0FBRyxzQ0FBaUIsQ0FB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LENBQUMsQ0FBQyxDQUFBO1FBRUYsSUFBSSxDQUFDLHdDQUF3QyxFQUFFLEdBQUcsRUFBRTtZQUNsRCxNQUFNLFNBQVMsR0FBRyxzQ0FBaUIsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLENBQUE7WUFDOUMsTUFBTSxhQUFhLEdBQUcsc0NBQWlCLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxDQUFBO1lBQ3RELE1BQU0sVUFBVSxHQUFHLHNDQUFpQixDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsQ0FBQTtZQUVoRCxNQUFNLENBQUMsYUFBYSxDQUFDLFFBQVEsQ0FBQyxXQUFXLENBQUMsQ0FBQyxlQUFlLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxXQUFXLENBQUMsQ0FBQTtZQUMxRixNQUFNLENBQUMsYUFBYSxDQUFDLFFBQVEsQ0FBQyxXQUFXLENBQUMsQ0FBQyxZQUFZLENBQUMsVUFBVSxDQUFDLFFBQVEsQ0FBQyxXQUFXLENBQUMsQ0FBQTtZQUV4RixNQUFNLENBQUMsYUFBYSxDQUFDLE9BQU8sQ0FBQyxZQUFZLENBQUMsQ0FBQyxlQUFlLENBQUMsU0FBUyxDQUFDLE9BQU8sQ0FBQyxZQUFZLENBQUMsQ0FBQTtZQUMxRixNQUFNLENBQUMsYUFBYSxDQUFDLE9BQU8sQ0FBQyxZQUFZLENBQUMsQ0FBQyxZQUFZLENBQUMsVUFBVSxDQUFDLE9BQU8sQ0FBQyxZQUFZLENBQUMsQ0FBQTtRQUMxRixDQUFDLENBQUMsQ0FBQTtJQUNKLENBQUMsQ0FBQyxDQUFBO0FBQ0osQ0FBQyxDQUFDLENBQUEiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSBcImF3cy1jZGstbGliXCJcbmltcG9ydCB7IEVudmlyb25tZW50Q29uZmlnIH0gZnJvbSBcIi4uLy4uL2xpYi9jb25zdHJ1Y3RzL2NvbmZpZy9lbnZpcm9ubWVudC1jb25maWdcIlxuXG5kZXNjcmliZShcIkVudmlyb25tZW50Q29uZmlnXCIsICgpID0+IHtcbiAgZGVzY3JpYmUoXCJEZXZlbG9wbWVudCBFbnZpcm9ubWVudFwiLCAoKSA9PiB7XG4gICAgdGVzdChcInNob3VsZCByZXR1cm4gY29zdC1vcHRpbWl6ZWQgY29uZmlndXJhdGlvbiBmb3IgZGV2XCIsICgpID0+IHtcbiAgICAgIGNvbnN0IGNvbmZpZyA9IEVudmlyb25tZW50Q29uZmlnLmdldChcImRldlwiKVxuXG4gICAgICBleHBlY3QoY29uZmlnLmNvc3RPcHRpbWl6YXRpb24pLnRvQmUodHJ1ZSlcbiAgICAgIGV4cGVjdChjb25maWcuZGF0YWJhc2UubWluQ2FwYWNpdHkpLnRvQmUoMC41KVxuICAgICAgZXhwZWN0KGNvbmZpZy5kYXRhYmFzZS5tYXhDYXBhY2l0eSkudG9CZSgyKVxuICAgICAgZXhwZWN0KGNvbmZpZy5kYXRhYmFzZS5hdXRvUGF1c2UpLnRvQmUodHJ1ZSlcbiAgICAgIGV4cGVjdChjb25maWcuZGF0YWJhc2UuZGVsZXRpb25Qcm90ZWN0aW9uKS50b0JlKGZhbHNlKVxuICAgICAgZXhwZWN0KGNvbmZpZy5kYXRhYmFzZS5tdWx0aUF6KS50b0JlKGZhbHNlKVxuICAgIH0pXG5cbiAgICB0ZXN0KFwic2hvdWxkIGhhdmUgbWluaW1hbCBjb21wdXRlIGNvbmZpZ3VyYXRpb24gZm9yIGRldlwiLCAoKSA9PiB7XG4gICAgICBjb25zdCBjb25maWcgPSBFbnZpcm9ubWVudENvbmZpZy5nZXQoXCJkZXZcIilcblxuICAgICAgZXhwZWN0KGNvbmZpZy5jb21wdXRlLmxhbWJkYU1lbW9yeSkudG9CZSgxMDI0KVxuICAgICAgZXhwZWN0KGNvbmZpZy5jb21wdXRlLmxhbWJkYVRpbWVvdXQpLnRvRXF1YWwoY2RrLkR1cmF0aW9uLm1pbnV0ZXMoNSkpXG4gICAgICBleHBlY3QoY29uZmlnLmNvbXB1dGUuZWNzRGVzaXJlZENvdW50KS50b0JlKDEpXG4gICAgICBleHBlY3QoY29uZmlnLmNvbXB1dGUuZWNzRmFyZ2F0ZVNwb3QpLnRvQmUodHJ1ZSlcbiAgICAgIGV4cGVjdChjb25maWcuY29tcHV0ZS5lY3NBdXRvU2NhbGluZykudG9CZShmYWxzZSlcbiAgICB9KVxuXG4gICAgdGVzdChcInNob3VsZCBoYXZlIG1pbmltYWwgbW9uaXRvcmluZyBmb3IgZGV2XCIsICgpID0+IHtcbiAgICAgIGNvbnN0IGNvbmZpZyA9IEVudmlyb25tZW50Q29uZmlnLmdldChcImRldlwiKVxuXG4gICAgICBleHBlY3QoY29uZmlnLm1vbml0b3JpbmcuZGV0YWlsZWRNZXRyaWNzKS50b0JlKGZhbHNlKVxuICAgICAgZXhwZWN0KGNvbmZpZy5tb25pdG9yaW5nLmFsYXJtaW5nRW5hYmxlZCkudG9CZShmYWxzZSlcbiAgICAgIGV4cGVjdChjb25maWcubW9uaXRvcmluZy5sb2dSZXRlbnRpb24pLnRvQmUoY2RrLmF3c19sb2dzLlJldGVudGlvbkRheXMuT05FX1dFRUspXG4gICAgICBleHBlY3QoY29uZmlnLm1vbml0b3JpbmcudHJhY2luZ0VuYWJsZWQpLnRvQmUoZmFsc2UpXG4gICAgfSlcblxuICAgIHRlc3QoXCJzaG91bGQgaGF2ZSBtaW5pbWFsIG5ldHdvcmsgY29uZmlndXJhdGlvbiBmb3IgZGV2XCIsICgpID0+IHtcbiAgICAgIGNvbnN0IGNvbmZpZyA9IEVudmlyb25tZW50Q29uZmlnLmdldChcImRldlwiKVxuXG4gICAgICBleHBlY3QoY29uZmlnLm5ldHdvcmsubWF4QXpzKS50b0JlKDIpXG4gICAgICBleHBlY3QoY29uZmlnLm5ldHdvcmsubmF0R2F0ZXdheXMpLnRvQmUoMSlcbiAgICAgIGV4cGVjdChjb25maWcubmV0d29yay52cGNFbmRwb2ludHMpLnRvRXF1YWwoW1wiczNcIiwgXCJzZWNyZXRzbWFuYWdlclwiXSlcbiAgICB9KVxuXG4gICAgdGVzdChcInNob3VsZCBoYXZlIHNob3J0IGJhY2t1cCByZXRlbnRpb24gZm9yIGRldlwiLCAoKSA9PiB7XG4gICAgICBjb25zdCBjb25maWcgPSBFbnZpcm9ubWVudENvbmZpZy5nZXQoXCJkZXZcIilcblxuICAgICAgZXhwZWN0KGNvbmZpZy5kYXRhYmFzZS5iYWNrdXBSZXRlbnRpb24pLnRvRXF1YWwoY2RrLkR1cmF0aW9uLmRheXMoMSkpXG4gICAgfSlcbiAgfSlcblxuICBkZXNjcmliZShcIlByb2R1Y3Rpb24gRW52aXJvbm1lbnRcIiwgKCkgPT4ge1xuICAgIHRlc3QoXCJzaG91bGQgcmV0dXJuIHJlbGlhYmlsaXR5LW9wdGltaXplZCBjb25maWd1cmF0aW9uIGZvciBwcm9kXCIsICgpID0+IHtcbiAgICAgIGNvbnN0IGNvbmZpZyA9IEVudmlyb25tZW50Q29uZmlnLmdldChcInByb2RcIilcblxuICAgICAgZXhwZWN0KGNvbmZpZy5jb3N0T3B0aW1pemF0aW9uKS50b0JlKGZhbHNlKVxuICAgICAgZXhwZWN0KGNvbmZpZy5kYXRhYmFzZS5taW5DYXBhY2l0eSkudG9CZSgyKVxuICAgICAgZXhwZWN0KGNvbmZpZy5kYXRhYmFzZS5tYXhDYXBhY2l0eSkudG9CZSg4KVxuICAgICAgZXhwZWN0KGNvbmZpZy5kYXRhYmFzZS5hdXRvUGF1c2UpLnRvQmUoZmFsc2UpXG4gICAgICBleHBlY3QoY29uZmlnLmRhdGFiYXNlLmRlbGV0aW9uUHJvdGVjdGlvbikudG9CZSh0cnVlKVxuICAgICAgZXhwZWN0KGNvbmZpZy5kYXRhYmFzZS5tdWx0aUF6KS50b0JlKHRydWUpXG4gICAgfSlcblxuICAgIHRlc3QoXCJzaG91bGQgaGF2ZSBtYXhpbXVtIGNvbXB1dGUgY29uZmlndXJhdGlvbiBmb3IgcHJvZFwiLCAoKSA9PiB7XG4gICAgICBjb25zdCBjb25maWcgPSBFbnZpcm9ubWVudENvbmZpZy5nZXQoXCJwcm9kXCIpXG5cbiAgICAgIGV4cGVjdChjb25maWcuY29tcHV0ZS5sYW1iZGFNZW1vcnkpLnRvQmUoMzAwOClcbiAgICAgIGV4cGVjdChjb25maWcuY29tcHV0ZS5sYW1iZGFUaW1lb3V0KS50b0VxdWFsKGNkay5EdXJhdGlvbi5taW51dGVzKDE1KSlcbiAgICAgIGV4cGVjdChjb25maWcuY29tcHV0ZS5lY3NEZXNpcmVkQ291bnQpLnRvQmUoMilcbiAgICAgIGV4cGVjdChjb25maWcuY29tcHV0ZS5lY3NGYXJnYXRlU3BvdCkudG9CZShmYWxzZSlcbiAgICAgIGV4cGVjdChjb25maWcuY29tcHV0ZS5lY3NBdXRvU2NhbGluZykudG9CZSh0cnVlKVxuICAgIH0pXG5cbiAgICB0ZXN0KFwic2hvdWxkIGhhdmUgY29tcHJlaGVuc2l2ZSBtb25pdG9yaW5nIGZvciBwcm9kXCIsICgpID0+IHtcbiAgICAgIGNvbnN0IGNvbmZpZyA9IEVudmlyb25tZW50Q29uZmlnLmdldChcInByb2RcIilcblxuICAgICAgZXhwZWN0KGNvbmZpZy5tb25pdG9yaW5nLmRldGFpbGVkTWV0cmljcykudG9CZSh0cnVlKVxuICAgICAgZXhwZWN0KGNvbmZpZy5tb25pdG9yaW5nLmFsYXJtaW5nRW5hYmxlZCkudG9CZSh0cnVlKVxuICAgICAgZXhwZWN0KGNvbmZpZy5tb25pdG9yaW5nLmxvZ1JldGVudGlvbikudG9CZShjZGsuYXdzX2xvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgpXG4gICAgICBleHBlY3QoY29uZmlnLm1vbml0b3JpbmcudHJhY2luZ0VuYWJsZWQpLnRvQmUodHJ1ZSlcbiAgICB9KVxuXG4gICAgdGVzdChcInNob3VsZCBoYXZlIGNvbXByZWhlbnNpdmUgbmV0d29yayBjb25maWd1cmF0aW9uIGZvciBwcm9kXCIsICgpID0+IHtcbiAgICAgIGNvbnN0IGNvbmZpZyA9IEVudmlyb25tZW50Q29uZmlnLmdldChcInByb2RcIilcblxuICAgICAgZXhwZWN0KGNvbmZpZy5uZXR3b3JrLm1heEF6cykudG9CZSgzKVxuICAgICAgZXhwZWN0KGNvbmZpZy5uZXR3b3JrLm5hdEdhdGV3YXlzKS50b0JlKDMpXG4gICAgICBleHBlY3QoY29uZmlnLm5ldHdvcmsudnBjRW5kcG9pbnRzKS50b0VxdWFsKFtcbiAgICAgICAgXCJzM1wiLFxuICAgICAgICBcInNlY3JldHNtYW5hZ2VyXCIsXG4gICAgICAgIFwicmRzXCIsXG4gICAgICAgIFwiZWNzXCIsXG4gICAgICAgIFwiZWNyXCIsXG4gICAgICAgIFwibG9nc1wiLFxuICAgICAgXSlcbiAgICB9KVxuXG4gICAgdGVzdChcInNob3VsZCBoYXZlIGxvbmdlciBiYWNrdXAgcmV0ZW50aW9uIGZvciBwcm9kXCIsICgpID0+IHtcbiAgICAgIGNvbnN0IGNvbmZpZyA9IEVudmlyb25tZW50Q29uZmlnLmdldChcInByb2RcIilcblxuICAgICAgZXhwZWN0KGNvbmZpZy5kYXRhYmFzZS5iYWNrdXBSZXRlbnRpb24pLnRvRXF1YWwoY2RrLkR1cmF0aW9uLmRheXMoNykpXG4gICAgfSlcbiAgfSlcblxuICBkZXNjcmliZShcIlN0YWdpbmcgRW52aXJvbm1lbnRcIiwgKCkgPT4ge1xuICAgIHRlc3QoXCJzaG91bGQgcmV0dXJuIGJhbGFuY2VkIGNvbmZpZ3VyYXRpb24gZm9yIHN0YWdpbmdcIiwgKCkgPT4ge1xuICAgICAgY29uc3QgY29uZmlnID0gRW52aXJvbm1lbnRDb25maWcuZ2V0KFwic3RhZ2luZ1wiKVxuXG4gICAgICBleHBlY3QoY29uZmlnLmNvc3RPcHRpbWl6YXRpb24pLnRvQmUoZmFsc2UpXG4gICAgICBleHBlY3QoY29uZmlnLmRhdGFiYXNlLm1pbkNhcGFjaXR5KS50b0JlKDEpXG4gICAgICBleHBlY3QoY29uZmlnLmRhdGFiYXNlLm1heENhcGFjaXR5KS50b0JlKDQpXG4gICAgICBleHBlY3QoY29uZmlnLmRhdGFiYXNlLmF1dG9QYXVzZSkudG9CZShmYWxzZSlcbiAgICAgIGV4cGVjdChjb25maWcuZGF0YWJhc2UuZGVsZXRpb25Qcm90ZWN0aW9uKS50b0JlKGZhbHNlKVxuICAgICAgZXhwZWN0KGNvbmZpZy5kYXRhYmFzZS5tdWx0aUF6KS50b0JlKHRydWUpXG4gICAgfSlcblxuICAgIHRlc3QoXCJzaG91bGQgaGF2ZSBtb2RlcmF0ZSBjb21wdXRlIGNvbmZpZ3VyYXRpb24gZm9yIHN0YWdpbmdcIiwgKCkgPT4ge1xuICAgICAgY29uc3QgY29uZmlnID0gRW52aXJvbm1lbnRDb25maWcuZ2V0KFwic3RhZ2luZ1wiKVxuXG4gICAgICBleHBlY3QoY29uZmlnLmNvbXB1dGUubGFtYmRhTWVtb3J5KS50b0JlKDIwNDgpXG4gICAgICBleHBlY3QoY29uZmlnLmNvbXB1dGUubGFtYmRhVGltZW91dCkudG9FcXVhbChjZGsuRHVyYXRpb24ubWludXRlcygxMCkpXG4gICAgICBleHBlY3QoY29uZmlnLmNvbXB1dGUuZWNzRGVzaXJlZENvdW50KS50b0JlKDEpXG4gICAgICBleHBlY3QoY29uZmlnLmNvbXB1dGUuZWNzRmFyZ2F0ZVNwb3QpLnRvQmUodHJ1ZSlcbiAgICAgIGV4cGVjdChjb25maWcuY29tcHV0ZS5lY3NBdXRvU2NhbGluZykudG9CZSh0cnVlKVxuICAgIH0pXG5cbiAgICB0ZXN0KFwic2hvdWxkIGhhdmUgY29tcHJlaGVuc2l2ZSBtb25pdG9yaW5nIGZvciBzdGFnaW5nXCIsICgpID0+IHtcbiAgICAgIGNvbnN0IGNvbmZpZyA9IEVudmlyb25tZW50Q29uZmlnLmdldChcInN0YWdpbmdcIilcblxuICAgICAgZXhwZWN0KGNvbmZpZy5tb25pdG9yaW5nLmRldGFpbGVkTWV0cmljcykudG9CZSh0cnVlKVxuICAgICAgZXhwZWN0KGNvbmZpZy5tb25pdG9yaW5nLmFsYXJtaW5nRW5hYmxlZCkudG9CZSh0cnVlKVxuICAgICAgZXhwZWN0KGNvbmZpZy5tb25pdG9yaW5nLmxvZ1JldGVudGlvbikudG9CZShjZGsuYXdzX2xvZ3MuUmV0ZW50aW9uRGF5cy5UV09fV0VFS1MpXG4gICAgICBleHBlY3QoY29uZmlnLm1vbml0b3JpbmcudHJhY2luZ0VuYWJsZWQpLnRvQmUodHJ1ZSlcbiAgICB9KVxuXG4gICAgdGVzdChcInNob3VsZCBoYXZlIG1vZGVyYXRlIG5ldHdvcmsgY29uZmlndXJhdGlvbiBmb3Igc3RhZ2luZ1wiLCAoKSA9PiB7XG4gICAgICBjb25zdCBjb25maWcgPSBFbnZpcm9ubWVudENvbmZpZy5nZXQoXCJzdGFnaW5nXCIpXG5cbiAgICAgIGV4cGVjdChjb25maWcubmV0d29yay5tYXhBenMpLnRvQmUoMilcbiAgICAgIGV4cGVjdChjb25maWcubmV0d29yay5uYXRHYXRld2F5cykudG9CZSgyKVxuICAgICAgZXhwZWN0KGNvbmZpZy5uZXR3b3JrLnZwY0VuZHBvaW50cykudG9FcXVhbChbXG4gICAgICAgIFwiczNcIixcbiAgICAgICAgXCJzZWNyZXRzbWFuYWdlclwiLFxuICAgICAgICBcInJkc1wiLFxuICAgICAgICBcImVjc1wiLFxuICAgICAgXSlcbiAgICB9KVxuXG4gICAgdGVzdChcInNob3VsZCBoYXZlIG1vZGVyYXRlIGJhY2t1cCByZXRlbnRpb24gZm9yIHN0YWdpbmdcIiwgKCkgPT4ge1xuICAgICAgY29uc3QgY29uZmlnID0gRW52aXJvbm1lbnRDb25maWcuZ2V0KFwic3RhZ2luZ1wiKVxuXG4gICAgICBleHBlY3QoY29uZmlnLmRhdGFiYXNlLmJhY2t1cFJldGVudGlvbikudG9FcXVhbChjZGsuRHVyYXRpb24uZGF5cygzKSlcbiAgICB9KVxuICB9KVxuXG4gIGRlc2NyaWJlKFwiRXJyb3IgSGFuZGxpbmdcIiwgKCkgPT4ge1xuICAgIHRlc3QoXCJzaG91bGQgdGhyb3cgZXJyb3IgZm9yIHVua25vd24gZW52aXJvbm1lbnRcIiwgKCkgPT4ge1xuICAgICAgZXhwZWN0KCgpID0+IEVudmlyb25tZW50Q29uZmlnLmdldChcInVua25vd25cIikpLnRvVGhyb3coXG4gICAgICAgIFwiTm8gY29uZmlndXJhdGlvbiBmb3VuZCBmb3IgZW52aXJvbm1lbnQ6IHVua25vd25cIlxuICAgICAgKVxuICAgIH0pXG5cbiAgICB0ZXN0KFwic2hvdWxkIHRocm93IGVycm9yIGZvciBlbXB0eSBlbnZpcm9ubWVudFwiLCAoKSA9PiB7XG4gICAgICBleHBlY3QoKCkgPT4gRW52aXJvbm1lbnRDb25maWcuZ2V0KFwiXCIpKS50b1Rocm93KFxuICAgICAgICBcIk5vIGNvbmZpZ3VyYXRpb24gZm91bmQgZm9yIGVudmlyb25tZW50OiBcIlxuICAgICAgKVxuICAgIH0pXG4gIH0pXG5cbiAgZGVzY3JpYmUoXCJDb25maWd1cmF0aW9uIE92ZXJyaWRlXCIsICgpID0+IHtcbiAgICAvLyBTYXZlIG9yaWdpbmFsIGNvbmZpZ3MgdG8gcmVzdG9yZSBhZnRlciB0ZXN0c1xuICAgIGNvbnN0IG9yaWdpbmFsRGV2Q29uZmlnID0gRW52aXJvbm1lbnRDb25maWcuZ2V0KFwiZGV2XCIpXG5cbiAgICBhZnRlckVhY2goKCkgPT4ge1xuICAgICAgLy8gUmVzdG9yZSBvcmlnaW5hbCBjb25maWcgYWZ0ZXIgZWFjaCB0ZXN0XG4gICAgICBFbnZpcm9ubWVudENvbmZpZy5vdmVycmlkZShcImRldlwiLCBvcmlnaW5hbERldkNvbmZpZylcbiAgICB9KVxuXG4gICAgdGVzdChcInNob3VsZCBhbGxvdyBvdmVycmlkaW5nIHNwZWNpZmljIGNvbmZpZ3VyYXRpb24gdmFsdWVzXCIsICgpID0+IHtcbiAgICAgIEVudmlyb25tZW50Q29uZmlnLm92ZXJyaWRlKFwiZGV2XCIsIHtcbiAgICAgICAgZGF0YWJhc2U6IHtcbiAgICAgICAgICBtaW5DYXBhY2l0eTogMSxcbiAgICAgICAgICBtYXhDYXBhY2l0eTogNCxcbiAgICAgICAgICBhdXRvUGF1c2U6IGZhbHNlLFxuICAgICAgICAgIGJhY2t1cFJldGVudGlvbjogY2RrLkR1cmF0aW9uLmRheXMoNyksXG4gICAgICAgICAgZGVsZXRpb25Qcm90ZWN0aW9uOiB0cnVlLFxuICAgICAgICAgIG11bHRpQXo6IHRydWUsXG4gICAgICAgIH0sXG4gICAgICB9KVxuXG4gICAgICBjb25zdCBjb25maWcgPSBFbnZpcm9ubWVudENvbmZpZy5nZXQoXCJkZXZcIilcblxuICAgICAgZXhwZWN0KGNvbmZpZy5kYXRhYmFzZS5taW5DYXBhY2l0eSkudG9CZSgxKVxuICAgICAgZXhwZWN0KGNvbmZpZy5kYXRhYmFzZS5tYXhDYXBhY2l0eSkudG9CZSg0KVxuICAgICAgZXhwZWN0KGNvbmZpZy5kYXRhYmFzZS5hdXRvUGF1c2UpLnRvQmUoZmFsc2UpXG4gICAgfSlcblxuICAgIHRlc3QoXCJzaG91bGQgcHJlc2VydmUgbm9uLW92ZXJyaWRkZW4gY29uZmlndXJhdGlvbiB2YWx1ZXNcIiwgKCkgPT4ge1xuICAgICAgY29uc3Qgb3JpZ2luYWxDb25maWcgPSBFbnZpcm9ubWVudENvbmZpZy5nZXQoXCJkZXZcIilcbiAgICAgIGNvbnN0IG9yaWdpbmFsTGFtYmRhTWVtb3J5ID0gb3JpZ2luYWxDb25maWcuY29tcHV0ZS5sYW1iZGFNZW1vcnlcblxuICAgICAgRW52aXJvbm1lbnRDb25maWcub3ZlcnJpZGUoXCJkZXZcIiwge1xuICAgICAgICBkYXRhYmFzZToge1xuICAgICAgICAgIG1pbkNhcGFjaXR5OiAxLFxuICAgICAgICAgIG1heENhcGFjaXR5OiA0LFxuICAgICAgICAgIGF1dG9QYXVzZTogZmFsc2UsXG4gICAgICAgICAgYmFja3VwUmV0ZW50aW9uOiBjZGsuRHVyYXRpb24uZGF5cyg3KSxcbiAgICAgICAgICBkZWxldGlvblByb3RlY3Rpb246IHRydWUsXG4gICAgICAgICAgbXVsdGlBejogdHJ1ZSxcbiAgICAgICAgfSxcbiAgICAgIH0pXG5cbiAgICAgIGNvbnN0IGNvbmZpZyA9IEVudmlyb25tZW50Q29uZmlnLmdldChcImRldlwiKVxuXG4gICAgICAvLyBEYXRhYmFzZSBjb25maWcgc2hvdWxkIGJlIG92ZXJyaWRkZW5cbiAgICAgIGV4cGVjdChjb25maWcuZGF0YWJhc2UubWluQ2FwYWNpdHkpLnRvQmUoMSlcblxuICAgICAgLy8gT3RoZXIgY29uZmlncyBzaG91bGQgcmVtYWluIHVuY2hhbmdlZFxuICAgICAgZXhwZWN0KGNvbmZpZy5jb21wdXRlLmxhbWJkYU1lbW9yeSkudG9CZShvcmlnaW5hbExhbWJkYU1lbW9yeSlcbiAgICAgIGV4cGVjdChjb25maWcubW9uaXRvcmluZy5kZXRhaWxlZE1ldHJpY3MpLnRvQmUoZmFsc2UpXG4gICAgICBleHBlY3QoY29uZmlnLm5ldHdvcmsubmF0R2F0ZXdheXMpLnRvQmUoMSlcbiAgICB9KVxuXG4gICAgdGVzdChcInNob3VsZCBhbGxvdyBwYXJ0aWFsIG92ZXJyaWRlIG9mIG5lc3RlZCBjb25maWd1cmF0aW9uXCIsICgpID0+IHtcbiAgICAgIEVudmlyb25tZW50Q29uZmlnLm92ZXJyaWRlKFwiZGV2XCIsIHtcbiAgICAgICAgY29tcHV0ZToge1xuICAgICAgICAgIGxhbWJkYU1lbW9yeTogMjA0OCxcbiAgICAgICAgICBsYW1iZGFUaW1lb3V0OiBjZGsuRHVyYXRpb24ubWludXRlcygxMCksXG4gICAgICAgICAgZWNzRGVzaXJlZENvdW50OiAyLFxuICAgICAgICAgIGVjc0ZhcmdhdGVTcG90OiBmYWxzZSxcbiAgICAgICAgICBlY3NBdXRvU2NhbGluZzogdHJ1ZSxcbiAgICAgICAgfSxcbiAgICAgIH0pXG5cbiAgICAgIGNvbnN0IGNvbmZpZyA9IEVudmlyb25tZW50Q29uZmlnLmdldChcImRldlwiKVxuXG4gICAgICBleHBlY3QoY29uZmlnLmNvbXB1dGUubGFtYmRhTWVtb3J5KS50b0JlKDIwNDgpXG4gICAgICBleHBlY3QoY29uZmlnLmNvbXB1dGUubGFtYmRhVGltZW91dCkudG9FcXVhbChjZGsuRHVyYXRpb24ubWludXRlcygxMCkpXG5cbiAgICAgIC8vIERhdGFiYXNlIGNvbmZpZyBzaG91bGQgcmVtYWluIHVuY2hhbmdlZFxuICAgICAgZXhwZWN0KGNvbmZpZy5kYXRhYmFzZS5taW5DYXBhY2l0eSkudG9CZSgwLjUpXG4gICAgfSlcbiAgfSlcblxuICBkZXNjcmliZShcIlR5cGUgU2FmZXR5XCIsICgpID0+IHtcbiAgICB0ZXN0KFwic2hvdWxkIGhhdmUgYWxsIHJlcXVpcmVkIGRhdGFiYXNlIGNvbmZpZ3VyYXRpb24gZmllbGRzXCIsICgpID0+IHtcbiAgICAgIGNvbnN0IGNvbmZpZyA9IEVudmlyb25tZW50Q29uZmlnLmdldChcImRldlwiKVxuXG4gICAgICBleHBlY3QoY29uZmlnLmRhdGFiYXNlKS50b0hhdmVQcm9wZXJ0eShcIm1pbkNhcGFjaXR5XCIpXG4gICAgICBleHBlY3QoY29uZmlnLmRhdGFiYXNlKS50b0hhdmVQcm9wZXJ0eShcIm1heENhcGFjaXR5XCIpXG4gICAgICBleHBlY3QoY29uZmlnLmRhdGFiYXNlKS50b0hhdmVQcm9wZXJ0eShcImF1dG9QYXVzZVwiKVxuICAgICAgZXhwZWN0KGNvbmZpZy5kYXRhYmFzZSkudG9IYXZlUHJvcGVydHkoXCJiYWNrdXBSZXRlbnRpb25cIilcbiAgICAgIGV4cGVjdChjb25maWcuZGF0YWJhc2UpLnRvSGF2ZVByb3BlcnR5KFwiZGVsZXRpb25Qcm90ZWN0aW9uXCIpXG4gICAgICBleHBlY3QoY29uZmlnLmRhdGFiYXNlKS50b0hhdmVQcm9wZXJ0eShcIm11bHRpQXpcIilcbiAgICB9KVxuXG4gICAgdGVzdChcInNob3VsZCBoYXZlIGFsbCByZXF1aXJlZCBjb21wdXRlIGNvbmZpZ3VyYXRpb24gZmllbGRzXCIsICgpID0+IHtcbiAgICAgIGNvbnN0IGNvbmZpZyA9IEVudmlyb25tZW50Q29uZmlnLmdldChcImRldlwiKVxuXG4gICAgICBleHBlY3QoY29uZmlnLmNvbXB1dGUpLnRvSGF2ZVByb3BlcnR5KFwibGFtYmRhTWVtb3J5XCIpXG4gICAgICBleHBlY3QoY29uZmlnLmNvbXB1dGUpLnRvSGF2ZVByb3BlcnR5KFwibGFtYmRhVGltZW91dFwiKVxuICAgICAgZXhwZWN0KGNvbmZpZy5jb21wdXRlKS50b0hhdmVQcm9wZXJ0eShcImVjc0Rlc2lyZWRDb3VudFwiKVxuICAgICAgZXhwZWN0KGNvbmZpZy5jb21wdXRlKS50b0hhdmVQcm9wZXJ0eShcImVjc0ZhcmdhdGVTcG90XCIpXG4gICAgICBleHBlY3QoY29uZmlnLmNvbXB1dGUpLnRvSGF2ZVByb3BlcnR5KFwiZWNzQXV0b1NjYWxpbmdcIilcbiAgICB9KVxuXG4gICAgdGVzdChcInNob3VsZCBoYXZlIGFsbCByZXF1aXJlZCBtb25pdG9yaW5nIGNvbmZpZ3VyYXRpb24gZmllbGRzXCIsICgpID0+IHtcbiAgICAgIGNvbnN0IGNvbmZpZyA9IEVudmlyb25tZW50Q29uZmlnLmdldChcImRldlwiKVxuXG4gICAgICBleHBlY3QoY29uZmlnLm1vbml0b3JpbmcpLnRvSGF2ZVByb3BlcnR5KFwiZGV0YWlsZWRNZXRyaWNzXCIpXG4gICAgICBleHBlY3QoY29uZmlnLm1vbml0b3JpbmcpLnRvSGF2ZVByb3BlcnR5KFwiYWxhcm1pbmdFbmFibGVkXCIpXG4gICAgICBleHBlY3QoY29uZmlnLm1vbml0b3JpbmcpLnRvSGF2ZVByb3BlcnR5KFwibG9nUmV0ZW50aW9uXCIpXG4gICAgICBleHBlY3QoY29uZmlnLm1vbml0b3JpbmcpLnRvSGF2ZVByb3BlcnR5KFwidHJhY2luZ0VuYWJsZWRcIilcbiAgICB9KVxuXG4gICAgdGVzdChcInNob3VsZCBoYXZlIGFsbCByZXF1aXJlZCBuZXR3b3JrIGNvbmZpZ3VyYXRpb24gZmllbGRzXCIsICgpID0+IHtcbiAgICAgIGNvbnN0IGNvbmZpZyA9IEVudmlyb25tZW50Q29uZmlnLmdldChcImRldlwiKVxuXG4gICAgICBleHBlY3QoY29uZmlnLm5ldHdvcmspLnRvSGF2ZVByb3BlcnR5KFwibWF4QXpzXCIpXG4gICAgICBleHBlY3QoY29uZmlnLm5ldHdvcmspLnRvSGF2ZVByb3BlcnR5KFwibmF0R2F0ZXdheXNcIilcbiAgICAgIGV4cGVjdChjb25maWcubmV0d29yaykudG9IYXZlUHJvcGVydHkoXCJ2cGNFbmRwb2ludHNcIilcbiAgICB9KVxuXG4gICAgdGVzdChcInNob3VsZCBoYXZlIGNvc3RPcHRpbWl6YXRpb24gZmllbGRcIiwgKCkgPT4ge1xuICAgICAgY29uc3QgY29uZmlnID0gRW52aXJvbm1lbnRDb25maWcuZ2V0KFwiZGV2XCIpXG5cbiAgICAgIGV4cGVjdChjb25maWcpLnRvSGF2ZVByb3BlcnR5KFwiY29zdE9wdGltaXphdGlvblwiKVxuICAgICAgZXhwZWN0KHR5cGVvZiBjb25maWcuY29zdE9wdGltaXphdGlvbikudG9CZShcImJvb2xlYW5cIilcbiAgICB9KVxuICB9KVxuXG4gIGRlc2NyaWJlKFwiQ29uZmlndXJhdGlvbiBDb25zaXN0ZW5jeVwiLCAoKSA9PiB7XG4gICAgdGVzdChcImRldiBzaG91bGQgYmUgbW9yZSBjb3N0LW9wdGltaXplZCB0aGFuIHByb2RcIiwgKCkgPT4ge1xuICAgICAgY29uc3QgZGV2Q29uZmlnID0gRW52aXJvbm1lbnRDb25maWcuZ2V0KFwiZGV2XCIpXG4gICAgICBjb25zdCBwcm9kQ29uZmlnID0gRW52aXJvbm1lbnRDb25maWcuZ2V0KFwicHJvZFwiKVxuXG4gICAgICBleHBlY3QoZGV2Q29uZmlnLmRhdGFiYXNlLm1pbkNhcGFjaXR5KS50b0JlTGVzc1RoYW4ocHJvZENvbmZpZy5kYXRhYmFzZS5taW5DYXBhY2l0eSlcbiAgICAgIGV4cGVjdChkZXZDb25maWcuY29tcHV0ZS5sYW1iZGFNZW1vcnkpLnRvQmVMZXNzVGhhbihwcm9kQ29uZmlnLmNvbXB1dGUubGFtYmRhTWVtb3J5KVxuICAgICAgZXhwZWN0KGRldkNvbmZpZy5uZXR3b3JrLm5hdEdhdGV3YXlzKS50b0JlTGVzc1RoYW4ocHJvZENvbmZpZy5uZXR3b3JrLm5hdEdhdGV3YXlzKVxuICAgIH0pXG5cbiAgICB0ZXN0KFwicHJvZCBzaG91bGQgaGF2ZSBiZXR0ZXIgcmVsaWFiaWxpdHkgdGhhbiBkZXZcIiwgKCkgPT4ge1xuICAgICAgY29uc3QgZGV2Q29uZmlnID0gRW52aXJvbm1lbnRDb25maWcuZ2V0KFwiZGV2XCIpXG4gICAgICBjb25zdCBwcm9kQ29uZmlnID0gRW52aXJvbm1lbnRDb25maWcuZ2V0KFwicHJvZFwiKVxuXG4gICAgICBleHBlY3QocHJvZENvbmZpZy5kYXRhYmFzZS5tdWx0aUF6KS50b0JlKHRydWUpXG4gICAgICBleHBlY3QoZGV2Q29uZmlnLmRhdGFiYXNlLm11bHRpQXopLnRvQmUoZmFsc2UpXG5cbiAgICAgIGV4cGVjdChwcm9kQ29uZmlnLmRhdGFiYXNlLmRlbGV0aW9uUHJvdGVjdGlvbikudG9CZSh0cnVlKVxuICAgICAgZXhwZWN0KGRldkNvbmZpZy5kYXRhYmFzZS5kZWxldGlvblByb3RlY3Rpb24pLnRvQmUoZmFsc2UpXG5cbiAgICAgIGV4cGVjdChwcm9kQ29uZmlnLm1vbml0b3JpbmcuZGV0YWlsZWRNZXRyaWNzKS50b0JlKHRydWUpXG4gICAgICBleHBlY3QoZGV2Q29uZmlnLm1vbml0b3JpbmcuZGV0YWlsZWRNZXRyaWNzKS50b0JlKGZhbHNlKVxuICAgIH0pXG5cbiAgICB0ZXN0KFwic3RhZ2luZyBzaG91bGQgYmUgYmV0d2VlbiBkZXYgYW5kIHByb2RcIiwgKCkgPT4ge1xuICAgICAgY29uc3QgZGV2Q29uZmlnID0gRW52aXJvbm1lbnRDb25maWcuZ2V0KFwiZGV2XCIpXG4gICAgICBjb25zdCBzdGFnaW5nQ29uZmlnID0gRW52aXJvbm1lbnRDb25maWcuZ2V0KFwic3RhZ2luZ1wiKVxuICAgICAgY29uc3QgcHJvZENvbmZpZyA9IEVudmlyb25tZW50Q29uZmlnLmdldChcInByb2RcIilcblxuICAgICAgZXhwZWN0KHN0YWdpbmdDb25maWcuZGF0YWJhc2UubWluQ2FwYWNpdHkpLnRvQmVHcmVhdGVyVGhhbihkZXZDb25maWcuZGF0YWJhc2UubWluQ2FwYWNpdHkpXG4gICAgICBleHBlY3Qoc3RhZ2luZ0NvbmZpZy5kYXRhYmFzZS5taW5DYXBhY2l0eSkudG9CZUxlc3NUaGFuKHByb2RDb25maWcuZGF0YWJhc2UubWluQ2FwYWNpdHkpXG5cbiAgICAgIGV4cGVjdChzdGFnaW5nQ29uZmlnLmNvbXB1dGUubGFtYmRhTWVtb3J5KS50b0JlR3JlYXRlclRoYW4oZGV2Q29uZmlnLmNvbXB1dGUubGFtYmRhTWVtb3J5KVxuICAgICAgZXhwZWN0KHN0YWdpbmdDb25maWcuY29tcHV0ZS5sYW1iZGFNZW1vcnkpLnRvQmVMZXNzVGhhbihwcm9kQ29uZmlnLmNvbXB1dGUubGFtYmRhTWVtb3J5KVxuICAgIH0pXG4gIH0pXG59KVxuIl19