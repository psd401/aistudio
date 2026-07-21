import * as cdk from "aws-cdk-lib"
import { Template } from "aws-cdk-lib/assertions"
import * as rds from "aws-cdk-lib/aws-rds"
import { AuroraCostDashboard } from "../../lib/constructs/database/aurora-cost-dashboard"

describe("AuroraCostDashboard", () => {
  let app: cdk.App
  let stack: cdk.Stack
  let mockCluster: rds.IDatabaseCluster

  beforeEach(() => {
    app = new cdk.App()
    stack = new cdk.Stack(app, "TestStack", {
      env: { region: "us-east-1" },
    })

    mockCluster = rds.DatabaseCluster.fromDatabaseClusterAttributes(
      stack,
      "MockCluster",
      {
        clusterIdentifier: "test-cluster",
      }
    )
  })

  describe("Metrics Export", () => {
    test("exports Aurora metrics for consolidated dashboards", () => {
      const dashboard = new AuroraCostDashboard(stack, "Dashboard", {
        cluster: mockCluster,
        environment: "dev",
      })

      // Verify metrics interface is exported
      expect(dashboard.metrics).toBeDefined()
      expect(dashboard.metrics.capacity).toBeDefined()
      expect(dashboard.metrics.acuUtilization).toBeDefined()
      expect(dashboard.metrics.connections).toBeDefined()
      expect(dashboard.metrics.cpuUtilization).toBeDefined()
      expect(dashboard.estimatedMonthlyCost).toBeDefined()
    })

    test("does not create CloudWatch dashboard (metrics only)", () => {
      new AuroraCostDashboard(stack, "Dashboard", {
        cluster: mockCluster,
        environment: "dev",
      })

      const template = Template.fromStack(stack)

      // Dashboard creation removed - construct only exports metrics
      template.resourceCountIs("AWS::CloudWatch::Dashboard", 0)
    })

    test("exports metrics for all environments", () => {
      const environments: Array<"dev" | "staging" | "prod"> = [
        "dev",
        "staging",
        "prod",
      ]

      environments.forEach((env) => {
        const envStack = new cdk.Stack(app, `${env}Stack`, {
          env: { region: "us-east-1" },
        })
        const envCluster = rds.DatabaseCluster.fromDatabaseClusterAttributes(
          envStack,
          "Cluster",
          { clusterIdentifier: `${env}-cluster` }
        )

        const dashboard = new AuroraCostDashboard(envStack, "Dashboard", {
          cluster: envCluster,
          environment: env,
        })

        // Verify metrics are available for each environment
        expect(dashboard.metrics).toBeDefined()
        expect(dashboard.estimatedMonthlyCost).toBeDefined()
      })
    })
  })

  describe("Metric Properties", () => {
    test("capacity metric is defined and available", () => {
      const dashboard = new AuroraCostDashboard(stack, "Dashboard", {
        cluster: mockCluster,
        environment: "dev",
      })

      const metric = dashboard.metrics.capacity
      expect(metric).toBeDefined()
      expect(metric.toMetricConfig().metricStat?.metricName).toBe(
        "ServerlessDatabaseCapacity"
      )
    })

    test("estimated cost metric is defined", () => {
      const dashboard = new AuroraCostDashboard(stack, "Dashboard", {
        cluster: mockCluster,
        environment: "dev",
      })

      const costMetric = dashboard.estimatedMonthlyCost
      expect(costMetric).toBeDefined()
      // Cost metric is a MathExpression (implements IMetric)
      // We can't access expression directly via IMetric interface, but we can verify it exists
      expect(costMetric.toString()).toBeDefined()
    })
  })

  describe("No Dashboard Creation", () => {
    test("does not export dashboard URL (dashboard removed)", () => {
      new AuroraCostDashboard(stack, "Dashboard", {
        cluster: mockCluster,
        environment: "dev",
      })

      const template = Template.fromStack(stack)

      // Should have no CloudFormation outputs for dashboard URL
      const outputs = template.toJSON().Outputs || {}
      const dashboardUrlOutputs = Object.keys(outputs).filter((key) =>
        key.includes("DashboardUrl")
      )

      expect(dashboardUrlOutputs.length).toBe(0)
    })
  })
})
