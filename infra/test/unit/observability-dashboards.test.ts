import * as cdk from "aws-cdk-lib"
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch"
import { Template } from "aws-cdk-lib/assertions"
import {
  ObservabilityDashboards,
} from "../../lib/constructs/observability/observability-dashboards"
import type {
  ConsolidatedMetrics,
} from "../../lib/constructs/observability/metrics-types"

function metric(metricName: string): cloudwatch.Metric {
  return new cloudwatch.Metric({
    namespace: "AIStudio/Test",
    metricName,
  })
}

function createConsolidatedMetrics(): ConsolidatedMetrics {
  return {
    lambda: {
      Processor: {
        invocations: metric("LambdaInvocations"),
        errors: metric("LambdaErrors"),
        duration: metric("LambdaDuration"),
        throttles: metric("LambdaThrottles"),
        concurrentExecutions: metric("LambdaConcurrency"),
      },
    },
    ecs: {
      Frontend: {
        cpuUtilization: metric("EcsCpu"),
        memoryUtilization: metric("EcsMemory"),
        runningTasks: metric("EcsTasks"),
        requestCount: metric("EcsRequests"),
      },
    },
    aurora: {
      capacity: metric("AuroraCapacity"),
      acuUtilization: metric("AuroraAcuUtilization"),
      connections: metric("AuroraConnections"),
      cpuUtilization: metric("AuroraCpu"),
    },
    storage: {
      Documents: {
        bucketSize: metric("BucketSize"),
        objectCount: metric("ObjectCount"),
      },
    },
    api: {
      requestCount: metric("ApiRequests"),
      errorCount: metric("ApiErrors"),
      latencyP99: metric("ApiLatencyP99"),
      availability: metric("ApiAvailability"),
    },
    cost: {
      lambdaCost: metric("LambdaCost"),
      auroraCost: metric("AuroraCost"),
      totalEstimatedCost: metric("TotalCost"),
    },
  }
}

describe("ObservabilityDashboards", () => {
  test("synthesizes each dashboard and preserves ALB search widgets", () => {
    const stack = new cdk.Stack(new cdk.App(), "DashboardStack")
    new ObservabilityDashboards(stack, "Dashboards", {
      environment: "dev",
      consolidatedMetrics: createConsolidatedMetrics(),
    })

    const template = Template.fromStack(stack)
    template.resourceCountIs("AWS::CloudWatch::Dashboard", 3)
    const dashboards = JSON.stringify(
      template.findResources("AWS::CloudWatch::Dashboard")
    )

    expect(dashboards).toContain("AIStudio-dev-Service")
    expect(dashboards).toContain("AIStudio-dev-Executive")
    expect(dashboards).toContain("AIStudio-dev-Cost")
    expect(dashboards).toContain("HTTPCode_Target_2XX_Count")
    expect(dashboards).toContain("HealthyHostCount")
    expect(dashboards).toContain("ClientTLSNegotiationErrorCount")
    expect(dashboards).toContain("TargetGroup")
    expect(dashboards).toContain("*aistudio*")
  })

  test("omits the cost dashboard when cost metrics are unavailable", () => {
    const stack = new cdk.Stack(new cdk.App(), "DashboardStack")
    new ObservabilityDashboards(stack, "Dashboards", {
      environment: "prod",
      consolidatedMetrics: {
        api: {
          requestCount: metric("ApiRequests"),
          errorCount: metric("ApiErrors"),
        },
      },
    })

    Template.fromStack(stack).resourceCountIs(
      "AWS::CloudWatch::Dashboard",
      2
    )
  })
})
