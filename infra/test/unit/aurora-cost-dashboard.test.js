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
const assertions_1 = require("aws-cdk-lib/assertions");
const rds = __importStar(require("aws-cdk-lib/aws-rds"));
const aurora_cost_dashboard_1 = require("../../lib/constructs/database/aurora-cost-dashboard");
describe("AuroraCostDashboard", () => {
    let app;
    let stack;
    let mockCluster;
    beforeEach(() => {
        app = new cdk.App();
        stack = new cdk.Stack(app, "TestStack", {
            env: { region: "us-east-1" },
        });
        mockCluster = rds.DatabaseCluster.fromDatabaseClusterAttributes(stack, "MockCluster", {
            clusterIdentifier: "test-cluster",
        });
    });
    describe("Metrics Export", () => {
        test("exports Aurora metrics for consolidated dashboards", () => {
            const dashboard = new aurora_cost_dashboard_1.AuroraCostDashboard(stack, "Dashboard", {
                cluster: mockCluster,
                environment: "dev",
            });
            // Verify metrics interface is exported
            expect(dashboard.metrics).toBeDefined();
            expect(dashboard.metrics.capacity).toBeDefined();
            expect(dashboard.metrics.acuUtilization).toBeDefined();
            expect(dashboard.metrics.connections).toBeDefined();
            expect(dashboard.metrics.cpuUtilization).toBeDefined();
            expect(dashboard.estimatedMonthlyCost).toBeDefined();
        });
        test("does not create CloudWatch dashboard (metrics only)", () => {
            new aurora_cost_dashboard_1.AuroraCostDashboard(stack, "Dashboard", {
                cluster: mockCluster,
                environment: "dev",
            });
            const template = assertions_1.Template.fromStack(stack);
            // Dashboard creation removed - construct only exports metrics
            template.resourceCountIs("AWS::CloudWatch::Dashboard", 0);
        });
        test("exports metrics for all environments", () => {
            const environments = [
                "dev",
                "staging",
                "prod",
            ];
            environments.forEach((env) => {
                const envStack = new cdk.Stack(app, `${env}Stack`, {
                    env: { region: "us-east-1" },
                });
                const envCluster = rds.DatabaseCluster.fromDatabaseClusterAttributes(envStack, "Cluster", { clusterIdentifier: `${env}-cluster` });
                const dashboard = new aurora_cost_dashboard_1.AuroraCostDashboard(envStack, "Dashboard", {
                    cluster: envCluster,
                    environment: env,
                });
                // Verify metrics are available for each environment
                expect(dashboard.metrics).toBeDefined();
                expect(dashboard.estimatedMonthlyCost).toBeDefined();
            });
        });
    });
    describe("Metric Properties", () => {
        test("capacity metric is defined and available", () => {
            const dashboard = new aurora_cost_dashboard_1.AuroraCostDashboard(stack, "Dashboard", {
                cluster: mockCluster,
                environment: "dev",
            });
            const metric = dashboard.metrics.capacity;
            expect(metric).toBeDefined();
            expect(metric.toMetricConfig().metricStat?.metricName).toBe("ServerlessDatabaseCapacity");
        });
        test("estimated cost metric is defined", () => {
            const dashboard = new aurora_cost_dashboard_1.AuroraCostDashboard(stack, "Dashboard", {
                cluster: mockCluster,
                environment: "dev",
            });
            const costMetric = dashboard.estimatedMonthlyCost;
            expect(costMetric).toBeDefined();
            // Cost metric is a MathExpression (implements IMetric)
            // We can't access expression directly via IMetric interface, but we can verify it exists
            expect(costMetric.toString()).toBeDefined();
        });
    });
    describe("No Dashboard Creation", () => {
        test("does not export dashboard URL (dashboard removed)", () => {
            new aurora_cost_dashboard_1.AuroraCostDashboard(stack, "Dashboard", {
                cluster: mockCluster,
                environment: "dev",
            });
            const template = assertions_1.Template.fromStack(stack);
            // Should have no CloudFormation outputs for dashboard URL
            const outputs = template.toJSON().Outputs || {};
            const dashboardUrlOutputs = Object.keys(outputs).filter((key) => key.includes("DashboardUrl"));
            expect(dashboardUrlOutputs.length).toBe(0);
        });
    });
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXVyb3JhLWNvc3QtZGFzaGJvYXJkLnRlc3QuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJhdXJvcmEtY29zdC1kYXNoYm9hcmQudGVzdC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLGlEQUFrQztBQUNsQyx1REFBaUQ7QUFDakQseURBQTBDO0FBQzFDLCtGQUF5RjtBQUV6RixRQUFRLENBQUMscUJBQXFCLEVBQUUsR0FBRyxFQUFFO0lBQ25DLElBQUksR0FBWSxDQUFBO0lBQ2hCLElBQUksS0FBZ0IsQ0FBQTtJQUNwQixJQUFJLFdBQWlDLENBQUE7SUFFckMsVUFBVSxDQUFDLEdBQUcsRUFBRTtRQUNkLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQTtRQUNuQixLQUFLLEdBQUcsSUFBSSxHQUFHLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRSxXQUFXLEVBQUU7WUFDdEMsR0FBRyxFQUFFLEVBQUUsTUFBTSxFQUFFLFdBQVcsRUFBRTtTQUM3QixDQUFDLENBQUE7UUFFRixXQUFXLEdBQUcsR0FBRyxDQUFDLGVBQWUsQ0FBQyw2QkFBNkIsQ0FDN0QsS0FBSyxFQUNMLGFBQWEsRUFDYjtZQUNFLGlCQUFpQixFQUFFLGNBQWM7U0FDbEMsQ0FDRixDQUFBO0lBQ0gsQ0FBQyxDQUFDLENBQUE7SUFFRixRQUFRLENBQUMsZ0JBQWdCLEVBQUUsR0FBRyxFQUFFO1FBQzlCLElBQUksQ0FBQyxvREFBb0QsRUFBRSxHQUFHLEVBQUU7WUFDOUQsTUFBTSxTQUFTLEdBQUcsSUFBSSwyQ0FBbUIsQ0FBQyxLQUFLLEVBQUUsV0FBVyxFQUFFO2dCQUM1RCxPQUFPLEVBQUUsV0FBVztnQkFDcEIsV0FBVyxFQUFFLEtBQUs7YUFDbkIsQ0FBQyxDQUFBO1lBRUYsdUNBQXVDO1lBQ3ZDLE1BQU0sQ0FBQyxTQUFTLENBQUMsT0FBTyxDQUFDLENBQUMsV0FBVyxFQUFFLENBQUE7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c0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gXCJhd3MtY2RrLWxpYlwiXG5pbXBvcnQgeyBUZW1wbGF0ZSB9IGZyb20gXCJhd3MtY2RrLWxpYi9hc3NlcnRpb25zXCJcbmltcG9ydCAqIGFzIHJkcyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJkc1wiXG5pbXBvcnQgeyBBdXJvcmFDb3N0RGFzaGJvYXJkIH0gZnJvbSBcIi4uLy4uL2xpYi9jb25zdHJ1Y3RzL2RhdGFiYXNlL2F1cm9yYS1jb3N0LWRhc2hib2FyZFwiXG5cbmRlc2NyaWJlKFwiQXVyb3JhQ29zdERhc2hib2FyZFwiLCAoKSA9PiB7XG4gIGxldCBhcHA6IGNkay5BcHBcbiAgbGV0IHN0YWNrOiBjZGsuU3RhY2tcbiAgbGV0IG1vY2tDbHVzdGVyOiByZHMuSURhdGFiYXNlQ2x1c3RlclxuXG4gIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgIGFwcCA9IG5ldyBjZGsuQXBwKClcbiAgICBzdGFjayA9IG5ldyBjZGsuU3RhY2soYXBwLCBcIlRlc3RTdGFja1wiLCB7XG4gICAgICBlbnY6IHsgcmVnaW9uOiBcInVzLWVhc3QtMVwiIH0sXG4gICAgfSlcblxuICAgIG1vY2tDbHVzdGVyID0gcmRzLkRhdGFiYXNlQ2x1c3Rlci5mcm9tRGF0YWJhc2VDbHVzdGVyQXR0cmlidXRlcyhcbiAgICAgIHN0YWNrLFxuICAgICAgXCJNb2NrQ2x1c3RlclwiLFxuICAgICAge1xuICAgICAgICBjbHVzdGVySWRlbnRpZmllcjogXCJ0ZXN0LWNsdXN0ZXJcIixcbiAgICAgIH1cbiAgICApXG4gIH0pXG5cbiAgZGVzY3JpYmUoXCJNZXRyaWNzIEV4cG9ydFwiLCAoKSA9PiB7XG4gICAgdGVzdChcImV4cG9ydHMgQXVyb3JhIG1ldHJpY3MgZm9yIGNvbnNvbGlkYXRlZCBkYXNoYm9hcmRzXCIsICgpID0+IHtcbiAgICAgIGNvbnN0IGRhc2hib2FyZCA9IG5ldyBBdXJvcmFDb3N0RGFzaGJvYXJkKHN0YWNrLCBcIkRhc2hib2FyZFwiLCB7XG4gICAgICAgIGNsdXN0ZXI6IG1vY2tDbHVzdGVyLFxuICAgICAgICBlbnZpcm9ubWVudDogXCJkZXZcIixcbiAgICAgIH0pXG5cbiAgICAgIC8vIFZlcmlmeSBtZXRyaWNzIGludGVyZmFjZSBpcyBleHBvcnRlZFxuICAgICAgZXhwZWN0KGRhc2hib2FyZC5tZXRyaWNzKS50b0JlRGVmaW5lZCgpXG4gICAgICBleHBlY3QoZGFzaGJvYXJkLm1ldHJpY3MuY2FwYWNpdHkpLnRvQmVEZWZpbmVkKClcbiAgICAgIGV4cGVjdChkYXNoYm9hcmQubWV0cmljcy5hY3VVdGlsaXphdGlvbikudG9CZURlZmluZWQoKVxuICAgICAgZXhwZWN0KGRhc2hib2FyZC5tZXRyaWNzLmNvbm5lY3Rpb25zKS50b0JlRGVmaW5lZCgpXG4gICAgICBleHBlY3QoZGFzaGJvYXJkLm1ldHJpY3MuY3B1VXRpbGl6YXRpb24pLnRvQmVEZWZpbmVkKClcbiAgICAgIGV4cGVjdChkYXNoYm9hcmQuZXN0aW1hdGVkTW9udGhseUNvc3QpLnRvQmVEZWZpbmVkKClcbiAgICB9KVxuXG4gICAgdGVzdChcImRvZXMgbm90IGNyZWF0ZSBDbG91ZFdhdGNoIGRhc2hib2FyZCAobWV0cmljcyBvbmx5KVwiLCAoKSA9PiB7XG4gICAgICBuZXcgQXVyb3JhQ29zdERhc2hib2FyZChzdGFjaywgXCJEYXNoYm9hcmRcIiwge1xuICAgICAgICBjbHVzdGVyOiBtb2NrQ2x1c3RlcixcbiAgICAgICAgZW52aXJvbm1lbnQ6IFwiZGV2XCIsXG4gICAgICB9KVxuXG4gICAgICBjb25zdCB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjaylcblxuICAgICAgLy8gRGFzaGJvYXJkIGNyZWF0aW9uIHJlbW92ZWQgLSBjb25zdHJ1Y3Qgb25seSBleHBvcnRzIG1ldHJpY3NcbiAgICAgIHRlbXBsYXRlLnJlc291cmNlQ291bnRJcyhcIkFXUzo6Q2xvdWRXYXRjaDo6RGFzaGJvYXJkXCIsIDApXG4gICAgfSlcblxuICAgIHRlc3QoXCJleHBvcnRzIG1ldHJpY3MgZm9yIGFsbCBlbnZpcm9ubWVudHNcIiwgKCkgPT4ge1xuICAgICAgY29uc3QgZW52aXJvbm1lbnRzOiBBcnJheTxcImRldlwiIHwgXCJzdGFnaW5nXCIgfCBcInByb2RcIj4gPSBbXG4gICAgICAgIFwiZGV2XCIsXG4gICAgICAgIFwic3RhZ2luZ1wiLFxuICAgICAgICBcInByb2RcIixcbiAgICAgIF1cblxuICAgICAgZW52aXJvbm1lbnRzLmZvckVhY2goKGVudikgPT4ge1xuICAgICAgICBjb25zdCBlbnZTdGFjayA9IG5ldyBjZGsuU3RhY2soYXBwLCBgJHtlbnZ9U3RhY2tgLCB7XG4gICAgICAgICAgZW52OiB7IHJlZ2lvbjogXCJ1cy1lYXN0LTFcIiB9LFxuICAgICAgICB9KVxuICAgICAgICBjb25zdCBlbnZDbHVzdGVyID0gcmRzLkRhdGFiYXNlQ2x1c3Rlci5mcm9tRGF0YWJhc2VDbHVzdGVyQXR0cmlidXRlcyhcbiAgICAgICAgICBlbnZTdGFjayxcbiAgICAgICAgICBcIkNsdXN0ZXJcIixcbiAgICAgICAgICB7IGNsdXN0ZXJJZGVudGlmaWVyOiBgJHtlbnZ9LWNsdXN0ZXJgIH1cbiAgICAgICAgKVxuXG4gICAgICAgIGNvbnN0IGRhc2hib2FyZCA9IG5ldyBBdXJvcmFDb3N0RGFzaGJvYXJkKGVudlN0YWNrLCBcIkRhc2hib2FyZFwiLCB7XG4gICAgICAgICAgY2x1c3RlcjogZW52Q2x1c3RlcixcbiAgICAgICAgICBlbnZpcm9ubWVudDogZW52LFxuICAgICAgICB9KVxuXG4gICAgICAgIC8vIFZlcmlmeSBtZXRyaWNzIGFyZSBhdmFpbGFibGUgZm9yIGVhY2ggZW52aXJvbm1lbnRcbiAgICAgICAgZXhwZWN0KGRhc2hib2FyZC5tZXRyaWNzKS50b0JlRGVmaW5lZCgpXG4gICAgICAgIGV4cGVjdChkYXNoYm9hcmQuZXN0aW1hdGVkTW9udGhseUNvc3QpLnRvQmVEZWZpbmVkKClcbiAgICAgIH0pXG4gICAgfSlcbiAgfSlcblxuICBkZXNjcmliZShcIk1ldHJpYyBQcm9wZXJ0aWVzXCIsICgpID0+IHtcbiAgICB0ZXN0KFwiY2FwYWNpdHkgbWV0cmljIGlzIGRlZmluZWQgYW5kIGF2YWlsYWJsZVwiLCAoKSA9PiB7XG4gICAgICBjb25zdCBkYXNoYm9hcmQgPSBuZXcgQXVyb3JhQ29zdERhc2hib2FyZChzdGFjaywgXCJEYXNoYm9hcmRcIiwge1xuICAgICAgICBjbHVzdGVyOiBtb2NrQ2x1c3RlcixcbiAgICAgICAgZW52aXJvbm1lbnQ6IFwiZGV2XCIsXG4gICAgICB9KVxuXG4gICAgICBjb25zdCBtZXRyaWMgPSBkYXNoYm9hcmQubWV0cmljcy5jYXBhY2l0eVxuICAgICAgZXhwZWN0KG1ldHJpYykudG9CZURlZmluZWQoKVxuICAgICAgZXhwZWN0KG1ldHJpYy50b01ldHJpY0NvbmZpZygpLm1ldHJpY1N0YXQ/Lm1ldHJpY05hbWUpLnRvQmUoXG4gICAgICAgIFwiU2VydmVybGVzc0RhdGFiYXNlQ2FwYWNpdHlcIlxuICAgICAgKVxuICAgIH0pXG5cbiAgICB0ZXN0KFwiZXN0aW1hdGVkIGNvc3QgbWV0cmljIGlzIGRlZmluZWRcIiwgKCkgPT4ge1xuICAgICAgY29uc3QgZGFzaGJvYXJkID0gbmV3IEF1cm9yYUNvc3REYXNoYm9hcmQoc3RhY2ssIFwiRGFzaGJvYXJkXCIsIHtcbiAgICAgICAgY2x1c3RlcjogbW9ja0NsdXN0ZXIsXG4gICAgICAgIGVudmlyb25tZW50OiBcImRldlwiLFxuICAgICAgfSlcblxuICAgICAgY29uc3QgY29zdE1ldHJpYyA9IGRhc2hib2FyZC5lc3RpbWF0ZWRNb250aGx5Q29zdFxuICAgICAgZXhwZWN0KGNvc3RNZXRyaWMpLnRvQmVEZWZpbmVkKClcbiAgICAgIC8vIENvc3QgbWV0cmljIGlzIGEgTWF0aEV4cHJlc3Npb24gKGltcGxlbWVudHMgSU1ldHJpYylcbiAgICAgIC8vIFdlIGNhbid0IGFjY2VzcyBleHByZXNzaW9uIGRpcmVjdGx5IHZpYSBJTWV0cmljIGludGVyZmFjZSwgYnV0IHdlIGNhbiB2ZXJpZnkgaXQgZXhpc3RzXG4gICAgICBleHBlY3QoY29zdE1ldHJpYy50b1N0cmluZygpKS50b0JlRGVmaW5lZCgpXG4gICAgfSlcbiAgfSlcblxuICBkZXNjcmliZShcIk5vIERhc2hib2FyZCBDcmVhdGlvblwiLCAoKSA9PiB7XG4gICAgdGVzdChcImRvZXMgbm90IGV4cG9ydCBkYXNoYm9hcmQgVVJMIChkYXNoYm9hcmQgcmVtb3ZlZClcIiwgKCkgPT4ge1xuICAgICAgbmV3IEF1cm9yYUNvc3REYXNoYm9hcmQoc3RhY2ssIFwiRGFzaGJvYXJkXCIsIHtcbiAgICAgICAgY2x1c3RlcjogbW9ja0NsdXN0ZXIsXG4gICAgICAgIGVudmlyb25tZW50OiBcImRldlwiLFxuICAgICAgfSlcblxuICAgICAgY29uc3QgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spXG5cbiAgICAgIC8vIFNob3VsZCBoYXZlIG5vIENsb3VkRm9ybWF0aW9uIG91dHB1dHMgZm9yIGRhc2hib2FyZCBVUkxcbiAgICAgIGNvbnN0IG91dHB1dHMgPSB0ZW1wbGF0ZS50b0pTT04oKS5PdXRwdXRzIHx8IHt9XG4gICAgICBjb25zdCBkYXNoYm9hcmRVcmxPdXRwdXRzID0gT2JqZWN0LmtleXMob3V0cHV0cykuZmlsdGVyKChrZXkpID0+XG4gICAgICAgIGtleS5pbmNsdWRlcyhcIkRhc2hib2FyZFVybFwiKVxuICAgICAgKVxuXG4gICAgICBleHBlY3QoZGFzaGJvYXJkVXJsT3V0cHV0cy5sZW5ndGgpLnRvQmUoMClcbiAgICB9KVxuICB9KVxufSlcbiJdfQ==