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
const constructs_1 = require("../../lib/constructs");
describe("SharedVPC Construct", () => {
    let app;
    let stack;
    beforeEach(() => {
        app = new cdk.App();
        stack = new cdk.Stack(app, "TestStack", {
            env: { account: "123456789012", region: "us-east-1" },
        });
    });
    describe("Development Environment", () => {
        test("creates VPC with correct subnet configuration", () => {
            // Arrange
            const config = constructs_1.EnvironmentConfig.get("dev");
            // Act
            new constructs_1.SharedVPC(stack, "TestVPC", {
                environment: "dev",
                config,
            });
            // Assert
            const template = assertions_1.Template.fromStack(stack);
            // Verify VPC creation
            template.hasResourceProperties("AWS::EC2::VPC", {
                EnableDnsHostnames: true,
                EnableDnsSupport: true,
            });
            // Verify multiple subnets exist (public, private app, private data, isolated)
            const subnets = template.findResources("AWS::EC2::Subnet");
            expect(Object.keys(subnets).length).toBeGreaterThan(4);
        });
        test("uses NAT instances for cost optimization", () => {
            // Arrange
            const config = constructs_1.EnvironmentConfig.get("dev");
            // Act
            new constructs_1.SharedVPC(stack, "TestVPC", {
                environment: "dev",
                config,
            });
            // Assert
            const template = assertions_1.Template.fromStack(stack);
            // Dev should use EC2 instances for NAT (cheaper)
            template.hasResourceProperties("AWS::EC2::Instance", {
                InstanceType: "t3.nano",
            });
        });
        test("creates essential VPC endpoints", () => {
            // Arrange
            const config = constructs_1.EnvironmentConfig.get("dev");
            // Act
            new constructs_1.SharedVPC(stack, "TestVPC", {
                environment: "dev",
                config,
            });
            // Assert
            const template = assertions_1.Template.fromStack(stack);
            // Gateway endpoints (S3, DynamoDB) - no cost
            template.hasResourceProperties("AWS::EC2::VPCEndpoint", {
                ServiceName: assertions_1.Match.objectLike({
                    "Fn::Join": assertions_1.Match.arrayWith([
                        assertions_1.Match.arrayWith([assertions_1.Match.stringLikeRegexp(".*s3.*")]),
                    ]),
                }),
            });
            // Interface endpoints should exist
            const vpcEndpoints = template.findResources("AWS::EC2::VPCEndpoint");
            expect(Object.keys(vpcEndpoints).length).toBeGreaterThan(5);
        });
        test("enables VPC flow logs to S3", () => {
            // Arrange
            const config = constructs_1.EnvironmentConfig.get("dev");
            // Act
            new constructs_1.SharedVPC(stack, "TestVPC", {
                environment: "dev",
                config,
                enableFlowLogs: true,
            });
            // Assert
            const template = assertions_1.Template.fromStack(stack);
            // S3 bucket for flow logs
            template.hasResourceProperties("AWS::S3::Bucket", {
                BucketEncryption: {
                    ServerSideEncryptionConfiguration: [
                        {
                            ServerSideEncryptionByDefault: {
                                SSEAlgorithm: "AES256",
                            },
                        },
                    ],
                },
                LifecycleConfiguration: {
                    Rules: [
                        {
                            Status: "Enabled",
                            ExpirationInDays: 30,
                        },
                    ],
                },
            });
            // Flow log resource
            template.hasResourceProperties("AWS::EC2::FlowLog", {
                ResourceType: "VPC",
                TrafficType: "ALL",
                MaxAggregationInterval: 600, // 10 minutes
            });
        });
        test("creates CloudWatch dashboard", () => {
            // Arrange
            const config = constructs_1.EnvironmentConfig.get("dev");
            // Act
            new constructs_1.SharedVPC(stack, "TestVPC", {
                environment: "dev",
                config,
            });
            // Assert
            const template = assertions_1.Template.fromStack(stack);
            // CloudWatch dashboard
            template.hasResourceProperties("AWS::CloudWatch::Dashboard", {
                DashboardName: "dev-vpc-metrics",
            });
        });
    });
    describe("Production Environment", () => {
        test("uses NAT gateways for reliability", () => {
            // Arrange
            const config = constructs_1.EnvironmentConfig.get("prod");
            // Act
            new constructs_1.SharedVPC(stack, "TestVPC", {
                environment: "prod",
                config,
            });
            // Assert
            const template = assertions_1.Template.fromStack(stack);
            // Prod should use NAT Gateways (more reliable)
            template.hasResourceProperties("AWS::EC2::NatGateway", {
                AllocationId: assertions_1.Match.anyValue(),
            });
        });
        test("creates additional VPC endpoints for production", () => {
            // Arrange
            const config = constructs_1.EnvironmentConfig.get("prod");
            // Act
            new constructs_1.SharedVPC(stack, "TestVPC", {
                environment: "prod",
                config,
            });
            // Assert
            const template = assertions_1.Template.fromStack(stack);
            // Should have more VPC endpoints than dev (including Textract, Comprehend)
            const vpcEndpoints = template.findResources("AWS::EC2::VPCEndpoint");
            expect(Object.keys(vpcEndpoints).length).toBeGreaterThan(10);
        });
        test("enables CloudWatch Logs for rejected traffic", () => {
            // Arrange
            const config = constructs_1.EnvironmentConfig.get("prod");
            // Act
            new constructs_1.SharedVPC(stack, "TestVPC", {
                environment: "prod",
                config,
                enableFlowLogs: true,
            });
            // Assert
            const template = assertions_1.Template.fromStack(stack);
            // Log group for flow logs
            template.hasResourceProperties("AWS::Logs::LogGroup", {
                LogGroupName: "/aws/vpc/flowlogs/prod",
                RetentionInDays: 7,
            });
            // Should have both S3 and CloudWatch flow logs
            const flowLogs = template.findResources("AWS::EC2::FlowLog");
            expect(Object.keys(flowLogs).length).toBe(2);
        });
        test("configures proper lifecycle for flow log storage", () => {
            // Arrange
            const config = constructs_1.EnvironmentConfig.get("prod");
            // Act
            new constructs_1.SharedVPC(stack, "TestVPC", {
                environment: "prod",
                config,
                enableFlowLogs: true,
            });
            // Assert
            const template = assertions_1.Template.fromStack(stack);
            // S3 bucket with production lifecycle
            template.hasResourceProperties("AWS::S3::Bucket", {
                LifecycleConfiguration: {
                    Rules: [
                        {
                            Status: "Enabled",
                            ExpirationInDays: 90,
                            Transitions: [
                                {
                                    StorageClass: "STANDARD_IA",
                                    TransitionInDays: 30,
                                },
                            ],
                        },
                    ],
                },
            });
        });
    });
    describe("VPC Endpoints Configuration", () => {
        test("can disable VPC endpoints", () => {
            // Arrange
            const config = constructs_1.EnvironmentConfig.get("dev");
            // Act
            new constructs_1.SharedVPC(stack, "TestVPC", {
                environment: "dev",
                config,
                enableVpcEndpoints: false,
            });
            // Assert
            const template = assertions_1.Template.fromStack(stack);
            // Should only have gateway endpoints (S3, DynamoDB)
            const vpcEndpoints = template.findResources("AWS::EC2::VPCEndpoint");
            expect(Object.keys(vpcEndpoints).length).toBeLessThan(5);
        });
        test("creates security group for VPC endpoints", () => {
            // Arrange
            const config = constructs_1.EnvironmentConfig.get("dev");
            // Act
            new constructs_1.SharedVPC(stack, "TestVPC", {
                environment: "dev",
                config,
            });
            // Assert
            const template = assertions_1.Template.fromStack(stack);
            // Security group for endpoints
            template.hasResourceProperties("AWS::EC2::SecurityGroup", {
                GroupDescription: "Security group for VPC endpoints",
                SecurityGroupIngress: [
                    {
                        CidrIp: assertions_1.Match.anyValue(),
                        IpProtocol: "tcp",
                        FromPort: 443,
                        ToPort: 443,
                    },
                ],
            });
        });
    });
    describe("Subnet Configuration", () => {
        test("provides helper method for workload-specific subnets", () => {
            // Arrange
            const config = constructs_1.EnvironmentConfig.get("dev");
            // Act
            const vpc = new constructs_1.SharedVPC(stack, "TestVPC", {
                environment: "dev",
                config,
            });
            // Assert
            expect(vpc.getSubnetsForWorkload("web")).toEqual({
                subnetType: cdk.aws_ec2.SubnetType.PUBLIC,
            });
            expect(vpc.getSubnetsForWorkload("app")).toEqual({
                subnetGroupName: "Private-Application",
            });
            expect(vpc.getSubnetsForWorkload("data")).toEqual({
                subnetGroupName: "Private-Data",
            });
            expect(vpc.getSubnetsForWorkload("secure")).toEqual({
                subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED,
            });
        });
        test("creates subnets with proper CIDR masks", () => {
            // Arrange
            const config = constructs_1.EnvironmentConfig.get("dev");
            // Act
            new constructs_1.SharedVPC(stack, "TestVPC", {
                environment: "dev",
                config,
            });
            // Assert
            const template = assertions_1.Template.fromStack(stack);
            // Verify subnets with different CIDR masks
            template.hasResourceProperties("AWS::EC2::Subnet", {
                CidrBlock: assertions_1.Match.stringLikeRegexp(".*\\.0/24"), // /24 subnets
            });
            // Should have larger subnet for applications (/22)
            template.hasResourceProperties("AWS::EC2::Subnet", {
                CidrBlock: assertions_1.Match.stringLikeRegexp(".*\\.0/22"),
            });
        });
    });
    describe("Flow Logs", () => {
        test("can disable flow logs", () => {
            // Arrange
            const config = constructs_1.EnvironmentConfig.get("dev");
            // Act
            new constructs_1.SharedVPC(stack, "TestVPC", {
                environment: "dev",
                config,
                enableFlowLogs: false,
            });
            // Assert
            const template = assertions_1.Template.fromStack(stack);
            // Should not create flow logs
            template.resourceCountIs("AWS::EC2::FlowLog", 0);
            template.resourceCountIs("AWS::S3::Bucket", 0 // No flow log bucket
            );
        });
    });
    describe("Tags", () => {
        test("tags subnets appropriately", () => {
            // Arrange
            const config = constructs_1.EnvironmentConfig.get("dev");
            // Act
            new constructs_1.SharedVPC(stack, "TestVPC", {
                environment: "dev",
                config,
            });
            // Assert
            const template = assertions_1.Template.fromStack(stack);
            // Public subnets should have ELB tag
            template.hasResource("AWS::EC2::Subnet", {
                Properties: assertions_1.Match.objectLike({
                    Tags: assertions_1.Match.arrayWith([
                        {
                            Key: "kubernetes.io/role/elb",
                            Value: "1",
                        },
                    ]),
                }),
            });
        });
    });
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2hhcmVkLXZwYy50ZXN0LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsic2hhcmVkLXZwYy50ZXN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQWtDO0FBQ2xDLHVEQUF3RDtBQUN4RCxxREFHNkI7QUFFN0IsUUFBUSxDQUFDLHFCQUFxQixFQUFFLEdBQUcsRUFBRTtJQUNuQyxJQUFJLEdBQVksQ0FBQTtJQUNoQixJQUFJLEtBQWdCLENBQUE7SUFFcEIsVUFBVSxDQUFDLEdBQUcsRUFBRTtRQUNkLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQTtRQUNuQixLQUFLLEdBQUcsSUFBSSxHQUFHLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRSxXQUFXLEVBQUU7WUFDdEMsR0FBRyxFQUFFLEVBQUUsT0FBTyxFQUFFLGNBQWMsRUFBRSxNQUFNLEVBQUUsV0FBVyxFQUFFO1NBQ3RELENBQUMsQ0FBQTtJQUNKLENBQUMsQ0FBQyxDQUFBO0lBRUYsUUFBUSxDQUFDLHlCQUF5QixFQUFFLEdBQUcsRUFBRTtRQUN2QyxJQUFJLENBQUMsK0NBQStDLEVBQUUsR0FBRyxFQUFFO1lBQ3pELFVBQVU7WUFDVixNQUFNLE1BQU0sR0FBRyw4QkFBaUIsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLENBQUE7WUFFM0MsTUFBTTtZQUNOLElBQUksc0JBQVMsQ0FBQyxLQUFLLEVBQUUsU0FBUyxFQUFFO2dCQUM5QixXQUFXLEVBQUUsS0FBSztnQkFDbEIsTUFBTTthQUNQLENBQUMsQ0FBQTtZQUVGLFNBQVM7WUFDVCxNQUFNLFFBQVEsR0FBRyxxQkFBUSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQTtZQUUxQyxzQkFBc0I7WUFDdEIsUUFBUSxDQUFDLHFCQUFxQixDQUFDLGVBQWUsRUFBRTtnQkFDOUMsa0JBQWtCLEVBQUUsSUFBSTtnQkFDeEIsZ0JBQWdCLEVBQUUs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QyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUE7WUFFMUMsOEJBQThCO1lBQzlCLFFBQVEsQ0FBQyxlQUFlLENBQUMsbUJBQW1CLEVBQUUsQ0FBQyxDQUFDLENBQUE7WUFDaEQsUUFBUSxDQUFDLGVBQWUsQ0FDdEIsaUJBQWlCLEVBQ2pCLENBQUMsQ0FBQyxxQkFBcUI7YUFDeEIsQ0FBQTtRQUNILENBQUMsQ0FBQyxDQUFBO0lBQ0osQ0FBQyxDQUFDLENBQUE7SUFFRixRQUFRLENBQUMsTUFBTSxFQUFFLEdBQUcsRUFBRTtRQUNwQixJQUFJLENBQUMsNEJBQTRCLEVBQUUsR0FBRyxFQUFFO1lBQ3RDLFVBQVU7WUFDVixNQUFNLE1BQU0sR0FBRyw4QkFBaUIsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLENBQUE7WUFFM0MsTUFBTTtZQUNOLElBQUksc0JBQVMsQ0FBQyxLQUFLLEVBQUUsU0FBUyxFQUFFO2dCQUM5QixXQUFXLEVBQUUsS0FBSztnQkFDbEIsTUFBTTthQUNQLENBQUMsQ0FBQTtZQUVGLFNBQVM7WUFDVCxNQUFNLFFBQVEsR0FBRyxxQkFBUSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQTtZQUUxQyxxQ0FBcUM7WUFDckMsUUFBUSxDQUFDLFdBQVcsQ0FBQyxrQkFBa0IsRUFBRTtnQkFDdkMsVUFBVSxFQUFFLGtCQUFLLENBQUMsVUFBVSxDQUFDO29CQUMzQixJQUFJLEVBQUUsa0JBQUssQ0FBQyxTQUFTLENBQUM7d0JBQ3BCOzRCQUNFLEdBQUcsRUFBRSx3QkFBd0I7NEJBQzdCLEtBQUssRUFBRSxHQUFHO3lCQUNYO3FCQUNGLENBQUM7aUJBQ0gsQ0FBQzthQUNILENBQUMsQ0FBQTtRQUNKLENBQUMsQ0FBQyxDQUFBO0lBQ0osQ0FBQyxDQUFDLENBQUE7QUFDSixDQUFDLENBQUMsQ0FBQSIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tIFwiYXdzLWNkay1saWJcIlxuaW1wb3J0IHsgVGVtcGxhdGUsIE1hdGNoIH0gZnJvbSBcImF3cy1jZGstbGliL2Fzc2VydGlvbnNcIlxuaW1wb3J0IHtcbiAgU2hhcmVkVlBDLFxuICBFbnZpcm9ubWVudENvbmZpZyxcbn0gZnJvbSBcIi4uLy4uL2xpYi9jb25zdHJ1Y3RzXCJcblxuZGVzY3JpYmUoXCJTaGFyZWRWUEMgQ29uc3RydWN0XCIsICgpID0+IHtcbiAgbGV0IGFwcDogY2RrLkFwcFxuICBsZXQgc3RhY2s6IGNkay5TdGFja1xuXG4gIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgIGFwcCA9IG5ldyBjZGsuQXBwKClcbiAgICBzdGFjayA9IG5ldyBjZGsuU3RhY2soYXBwLCBcIlRlc3RTdGFja1wiLCB7XG4gICAgICBlbnY6IHsgYWNjb3VudDogXCIxMjM0NTY3ODkwMTJcIiwgcmVnaW9uOiBcInVzLWVhc3QtMVwiIH0sXG4gICAgfSlcbiAgfSlcblxuICBkZXNjcmliZShcIkRldmVsb3BtZW50IEVudmlyb25tZW50XCIsICgpID0+IHtcbiAgICB0ZXN0KFwiY3JlYXRlcyBWUEMgd2l0aCBjb3JyZWN0IHN1Ym5ldCBjb25maWd1cmF0aW9uXCIsICgpID0+IHtcbiAgICAgIC8vIEFycmFuZ2VcbiAgICAgIGNvbnN0IGNvbmZpZyA9IEVudmlyb25tZW50Q29uZmlnLmdldChcImRldlwiKVxuXG4gICAgICAvLyBBY3RcbiAgICAgIG5ldyBTaGFyZWRWUEMoc3RhY2ssIFwiVGVzdFZQQ1wiLCB7XG4gICAgICAgIGVudmlyb25tZW50OiBcImRldlwiLFxuICAgICAgICBjb25maWcsXG4gICAgICB9KVxuXG4gICAgICAvLyBBc3NlcnRcbiAgICAgIGNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKVxuXG4gICAgICAvLyBWZXJpZnkgVlBDIGNyZWF0aW9uXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoXCJBV1M6OkVDMjo6VlBDXCIsIHtcbiAgICAgICAgRW5hYmxlRG5zSG9zdG5hbWVzOiB0cnVlLFxuICAgICAgICBFbmFibGVEbnNTdXBwb3J0OiB0cnVlLFxuICAgICAgfSlcblxuICAgICAgLy8gVmVyaWZ5IG11bHRpcGxlIHN1Ym5ldHMgZXhpc3QgKHB1YmxpYywgcHJpdmF0ZSBhcHAsIHByaXZhdGUgZGF0YSwgaXNvbGF0ZWQpXG4gICAgICBjb25zdCBzdWJuZXRzID0gdGVtcGxhdGUuZmluZFJlc291cmNlcyhcIkFXUzo6RUMyOjpTdWJuZXRcIilcbiAgICAgIGV4cGVjdChPYmplY3Qua2V5cyhzdWJuZXRzKS5sZW5ndGgpLnRvQmVHcmVhdGVyVGhhbig0KVxuICAgIH0pXG5cbiAgICB0ZXN0KFwidXNlcyBOQVQgaW5zdGFuY2VzIGZvciBjb3N0IG9wdGltaXphdGlvblwiLCAoKSA9PiB7XG4gICAgICAvLyBBcnJhbmdlXG4gICAgICBjb25zdCBjb25maWcgPSBFbnZpcm9ubWVudENvbmZpZy5nZXQoXCJkZXZcIilcblxuICAgICAgLy8gQWN0XG4gICAgICBuZXcgU2hhcmVkVlBDKHN0YWNrLCBcIlRlc3RWUENcIiwge1xuICAgICAgICBlbnZpcm9ubWVudDogXCJkZXZcIixcbiAgICAgICAgY29uZmlnLFxuICAgICAgfSlcblxuICAgICAgLy8gQXNzZXJ0XG4gICAgICBjb25zdCB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjaylcblxuICAgICAgLy8gRGV2IHNob3VsZCB1c2UgRUMyIGluc3RhbmNlcyBmb3IgTkFUIChjaGVhcGVyKVxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKFwiQVdTOjpFQzI6Okluc3RhbmNlXCIsIHtcbiAgICAgICAgSW5zdGFuY2VUeXBlOiBcInQzLm5hbm9cIixcbiAgICAgIH0pXG4gICAgfSlcblxuICAgIHRlc3QoXCJjcmVhdGVzIGVzc2VudGlhbCBWUEMgZW5kcG9pbnRzXCIsICgpID0+IHtcbiAgICAgIC8vIEFycmFuZ2VcbiAgICAgIGNvbnN0IGNvbmZpZyA9IEVudmlyb25tZW50Q29uZmlnLmdldChcImRldlwiKVxuXG4gICAgICAvLyBBY3RcbiAgICAgIG5ldyBTaGFyZWRWUEMoc3RhY2ssIFwiVGVzdFZQQ1wiLCB7XG4gICAgICAgIGVudmlyb25tZW50OiBcImRldlwiLFxuICAgICAgICBjb25maWcsXG4gICAgICB9KVxuXG4gICAgICAvLyBBc3NlcnRcbiAgICAgIGNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKVxuXG4gICAgICAvLyBHYXRld2F5IGVuZHBvaW50cyAoUzMsIER5bmFtb0RCKSAtIG5vIGNvc3RcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcyhcIkFXUzo6RUMyOjpWUENFbmRwb2ludFwiLCB7XG4gICAgICAgIFNlcnZpY2VOYW1lOiBNYXRjaC5vYmplY3RMaWtlKHtcbiAgICAgICAgICBcIkZuOjpKb2luXCI6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgICAgICBNYXRjaC5hcnJheVdpdGgoW01hdGNoLnN0cmluZ0xpa2VSZWdleHAoXCIuKnMzLipcIildKSxcbiAgICAgICAgICBdKSxcbiAgICAgICAgfSksXG4gICAgICB9KVxuXG4gICAgICAvLyBJbnRlcmZhY2UgZW5kcG9pbnRzIHNob3VsZCBleGlzdFxuICAgICAgY29uc3QgdnBjRW5kcG9pbnRzID0gdGVtcGxhdGUuZmluZFJlc291cmNlcyhcIkFXUzo6RUMyOjpWUENFbmRwb2ludFwiKVxuICAgICAgZXhwZWN0KE9iamVjdC5rZXlzKHZwY0VuZHBvaW50cykubGVuZ3RoKS50b0JlR3JlYXRlclRoYW4oNSlcbiAgICB9KVxuXG4gICAgdGVzdChcImVuYWJsZXMgVlBDIGZsb3cgbG9ncyB0byBTM1wiLCAoKSA9PiB7XG4gICAgICAvLyBBcnJhbmdlXG4gICAgICBjb25zdCBjb25maWcgPSBFbnZpcm9ubWVudENvbmZpZy5nZXQoXCJkZXZcIilcblxuICAgICAgLy8gQWN0XG4gICAgICBuZXcgU2hhcmVkVlBDKHN0YWNrLCBcIlRlc3RWUENcIiwge1xuICAgICAgICBlbnZpcm9ubWVudDogXCJkZXZcIixcbiAgICAgICAgY29uZmlnLFxuICAgICAgICBlbmFibGVGbG93TG9nczogdHJ1ZSxcbiAgICAgIH0pXG5cbiAgICAgIC8vIEFzc2VydFxuICAgICAgY29uc3QgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spXG5cbiAgICAgIC8vIFMzIGJ1Y2tldCBmb3IgZmxvdyBsb2dzXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoXCJBV1M6OlMzOjpCdWNrZXRcIiwge1xuICAgICAgICBCdWNrZXRFbmNyeXB0aW9uOiB7XG4gICAgICAgICAgU2VydmVyU2lkZUVuY3J5cHRpb25Db25maWd1cmF0aW9uOiBbXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIFNlcnZlclNpZGVFbmNyeXB0aW9uQnlEZWZhdWx0OiB7XG4gICAgICAgICAgICAgICAgU1NFQWxnb3JpdGhtOiBcIkFFUzI1NlwiLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICBdLFxuICAgICAgICB9LFxuICAgICAgICBMaWZlY3ljbGVDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgUnVsZXM6IFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgU3RhdHVzOiBcIkVuYWJsZWRcIixcbiAgICAgICAgICAgICAgRXhwaXJhdGlvbkluRGF5czogMzAsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICB9KVxuXG4gICAgICAvLyBGbG93IGxvZyByZXNvdXJjZVxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKFwiQVdTOjpFQzI6OkZsb3dMb2dcIiwge1xuICAgICAgICBSZXNvdXJjZVR5cGU6IFwiVlBDXCIsXG4gICAgICAgIFRyYWZmaWNUeXBlOiBcIkFMTFwiLFxuICAgICAgICBNYXhBZ2dyZWdhdGlvbkludGVydmFsOiA2MDAsIC8vIDEwIG1pbnV0ZXNcbiAgICAgIH0pXG4gICAgfSlcblxuICAgIHRlc3QoXCJjcmVhdGVzIENsb3VkV2F0Y2ggZGFzaGJvYXJkXCIsICgpID0+IHtcbiAgICAgIC8vIEFycmFuZ2VcbiAgICAgIGNvbnN0IGNvbmZpZyA9IEVudmlyb25tZW50Q29uZmlnLmdldChcImRldlwiKVxuXG4gICAgICAvLyBBY3RcbiAgICAgIG5ldyBTaGFyZWRWUEMoc3RhY2ssIFwiVGVzdFZQQ1wiLCB7XG4gICAgICAgIGVudmlyb25tZW50OiBcImRldlwiLFxuICAgICAgICBjb25maWcsXG4gICAgICB9KVxuXG4gICAgICAvLyBBc3NlcnRcbiAgICAgIGNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKVxuXG4gICAgICAvLyBDbG91ZFdhdGNoIGRhc2hib2FyZFxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKFwiQVdTOjpDbG91ZFdhdGNoOjpEYXNoYm9hcmRcIiwge1xuICAgICAgICBEYXNoYm9hcmROYW1lOiBcImRldi12cGMtbWV0cmljc1wiLFxuICAgICAgfSlcbiAgICB9KVxuICB9KVxuXG4gIGRlc2NyaWJlKFwiUHJvZHVjdGlvbiBFbnZpcm9ubWVudFwiLCAoKSA9PiB7XG4gICAgdGVzdChcInVzZXMgTkFUIGdhdGV3YXlzIGZvciByZWxpYWJpbGl0eVwiLCAoKSA9PiB7XG4gICAgICAvLyBBcnJhbmdlXG4gICAgICBjb25zdCBjb25maWcgPSBFbnZpcm9ubWVudENvbmZpZy5nZXQoXCJwcm9kXCIpXG5cbiAgICAgIC8vIEFjdFxuICAgICAgbmV3IFNoYXJlZFZQQyhzdGFjaywgXCJUZXN0VlBDXCIsIHtcbiAgICAgICAgZW52aXJvbm1lbnQ6IFwicHJvZFwiLFxuICAgICAgICBjb25maWcsXG4gICAgICB9KVxuXG4gICAgICAvLyBBc3NlcnRcbiAgICAgIGNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKVxuXG4gICAgICAvLyBQcm9kIHNob3VsZCB1c2UgTkFUIEdhdGV3YXlzIChtb3JlIHJlbGlhYmxlKVxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKFwiQVdTOjpFQzI6Ok5hdEdhdGV3YXlcIiwge1xuICAgICAgICBBbGxvY2F0aW9uSWQ6IE1hdGNoLmFueVZhbHVlKCksXG4gICAgICB9KVxuICAgIH0pXG5cbiAgICB0ZXN0KFwiY3JlYXRlcyBhZGRpdGlvbmFsIFZQQyBlbmRwb2ludHMgZm9yIHByb2R1Y3Rpb25cIiwgKCkgPT4ge1xuICAgICAgLy8gQXJyYW5nZVxuICAgICAgY29uc3QgY29uZmlnID0gRW52aXJvbm1lbnRDb25maWcuZ2V0KFwicHJvZFwiKVxuXG4gICAgICAvLyBBY3RcbiAgICAgIG5ldyBTaGFyZWRWUEMoc3RhY2ssIFwiVGVzdFZQQ1wiLCB7XG4gICAgICAgIGVudmlyb25tZW50OiBcInByb2RcIixcbiAgICAgICAgY29uZmlnLFxuICAgICAgfSlcblxuICAgICAgLy8gQXNzZXJ0XG4gICAgICBjb25zdCB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjaylcblxuICAgICAgLy8gU2hvdWxkIGhhdmUgbW9yZSBWUEMgZW5kcG9pbnRzIHRoYW4gZGV2IChpbmNsdWRpbmcgVGV4dHJhY3QsIENvbXByZWhlbmQpXG4gICAgICBjb25zdCB2cGNFbmRwb2ludHMgPSB0ZW1wbGF0ZS5maW5kUmVzb3VyY2VzKFwiQVdTOjpFQzI6OlZQQ0VuZHBvaW50XCIpXG4gICAgICBleHBlY3QoT2JqZWN0LmtleXModnBjRW5kcG9pbnRzKS5sZW5ndGgpLnRvQmVHcmVhdGVyVGhhbigxMClcbiAgICB9KVxuXG4gICAgdGVzdChcImVuYWJsZXMgQ2xvdWRXYXRjaCBMb2dzIGZvciByZWplY3RlZCB0cmFmZmljXCIsICgpID0+IHtcbiAgICAgIC8vIEFycmFuZ2VcbiAgICAgIGNvbnN0IGNvbmZpZyA9IEVudmlyb25tZW50Q29uZmlnLmdldChcInByb2RcIilcblxuICAgICAgLy8gQWN0XG4gICAgICBuZXcgU2hhcmVkVlBDKHN0YWNrLCBcIlRlc3RWUENcIiwge1xuICAgICAgICBlbnZpcm9ubWVudDogXCJwcm9kXCIsXG4gICAgICAgIGNvbmZpZyxcbiAgICAgICAgZW5hYmxlRmxvd0xvZ3M6IHRydWUsXG4gICAgICB9KVxuXG4gICAgICAvLyBBc3NlcnRcbiAgICAgIGNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKVxuXG4gICAgICAvLyBMb2cgZ3JvdXAgZm9yIGZsb3cgbG9nc1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKFwiQVdTOjpMb2dzOjpMb2dHcm91cFwiLCB7XG4gICAgICAgIExvZ0dyb3VwTmFtZTogXCIvYXdzL3ZwYy9mbG93bG9ncy9wcm9kXCIsXG4gICAgICAgIFJldGVudGlvbkluRGF5czogNyxcbiAgICAgIH0pXG5cbiAgICAgIC8vIFNob3VsZCBoYXZlIGJvdGggUzMgYW5kIENsb3VkV2F0Y2ggZmxvdyBsb2dzXG4gICAgICBjb25zdCBmbG93TG9ncyA9IHRlbXBsYXRlLmZpbmRSZXNvdXJjZXMoXCJBV1M6OkVDMjo6Rmxvd0xvZ1wiKVxuICAgICAgZXhwZWN0KE9iamVjdC5rZXlzKGZsb3dMb2dzKS5sZW5ndGgpLnRvQmUoMilcbiAgICB9KVxuXG4gICAgdGVzdChcImNvbmZpZ3VyZXMgcHJvcGVyIGxpZmVjeWNsZSBmb3IgZmxvdyBsb2cgc3RvcmFnZVwiLCAoKSA9PiB7XG4gICAgICAvLyBBcnJhbmdlXG4gICAgICBjb25zdCBjb25maWcgPSBFbnZpcm9ubWVudENvbmZpZy5nZXQoXCJwcm9kXCIpXG5cbiAgICAgIC8vIEFjdFxuICAgICAgbmV3IFNoYXJlZFZQQyhzdGFjaywgXCJUZXN0VlBDXCIsIHtcbiAgICAgICAgZW52aXJvbm1lbnQ6IFwicHJvZFwiLFxuICAgICAgICBjb25maWcsXG4gICAgICAgIGVuYWJsZUZsb3dMb2dzOiB0cnVlLFxuICAgICAgfSlcblxuICAgICAgLy8gQXNzZXJ0XG4gICAgICBjb25zdCB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjaylcblxuICAgICAgLy8gUzMgYnVja2V0IHdpdGggcHJvZHVjdGlvbiBsaWZlY3ljbGVcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcyhcIkFXUzo6UzM6OkJ1Y2tldFwiLCB7XG4gICAgICAgIExpZmVjeWNsZUNvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBSdWxlczogW1xuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBTdGF0dXM6IFwiRW5hYmxlZFwiLFxuICAgICAgICAgICAgICBFeHBpcmF0aW9uSW5EYXlzOiA5MCxcbiAgICAgICAgICAgICAgVHJhbnNpdGlvbnM6IFtcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICBTdG9yYWdlQ2xhc3M6IFwiU1RBTkRBUkRfSUFcIixcbiAgICAgICAgICAgICAgICAgIFRyYW5zaXRpb25JbkRheXM6IDMwLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICB9KVxuICAgIH0pXG4gIH0pXG5cbiAgZGVzY3JpYmUoXCJWUEMgRW5kcG9pbnRzIENvbmZpZ3VyYXRpb25cIiwgKCkgPT4ge1xuICAgIHRlc3QoXCJjYW4gZGlzYWJsZSBWUEMgZW5kcG9pbnRzXCIsICgpID0+IHtcbiAgICAgIC8vIEFycmFuZ2VcbiAgICAgIGNvbnN0IGNvbmZpZyA9IEVudmlyb25tZW50Q29uZmlnLmdldChcImRldlwiKVxuXG4gICAgICAvLyBBY3RcbiAgICAgIG5ldyBTaGFyZWRWUEMoc3RhY2ssIFwiVGVzdFZQQ1wiLCB7XG4gICAgICAgIGVudmlyb25tZW50OiBcImRldlwiLFxuICAgICAgICBjb25maWcsXG4gICAgICAgIGVuYWJsZVZwY0VuZHBvaW50czogZmFsc2UsXG4gICAgICB9KVxuXG4gICAgICAvLyBBc3NlcnRcbiAgICAgIGNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKVxuXG4gICAgICAvLyBTaG91bGQgb25seSBoYXZlIGdhdGV3YXkgZW5kcG9pbnRzIChTMywgRHluYW1vREIpXG4gICAgICBjb25zdCB2cGNFbmRwb2ludHMgPSB0ZW1wbGF0ZS5maW5kUmVzb3VyY2VzKFwiQVdTOjpFQzI6OlZQQ0VuZHBvaW50XCIpXG4gICAgICBleHBlY3QoT2JqZWN0LmtleXModnBjRW5kcG9pbnRzKS5sZW5ndGgpLnRvQmVMZXNzVGhhbig1KVxuICAgIH0pXG5cbiAgICB0ZXN0KFwiY3JlYXRlcyBzZWN1cml0eSBncm91cCBmb3IgVlBDIGVuZHBvaW50c1wiLCAoKSA9PiB7XG4gICAgICAvLyBBcnJhbmdlXG4gICAgICBjb25zdCBjb25maWcgPSBFbnZpcm9ubWVudENvbmZpZy5nZXQoXCJkZXZcIilcblxuICAgICAgLy8gQWN0XG4gICAgICBuZXcgU2hhcmVkVlBDKHN0YWNrLCBcIlRlc3RWUENcIiwge1xuICAgICAgICBlbnZpcm9ubWVudDogXCJkZXZcIixcbiAgICAgICAgY29uZmlnLFxuICAgICAgfSlcblxuICAgICAgLy8gQXNzZXJ0XG4gICAgICBjb25zdCB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjaylcblxuICAgICAgLy8gU2VjdXJpdHkgZ3JvdXAgZm9yIGVuZHBvaW50c1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKFwiQVdTOjpFQzI6OlNlY3VyaXR5R3JvdXBcIiwge1xuICAgICAgICBHcm91cERlc2NyaXB0aW9uOiBcIlNlY3VyaXR5IGdyb3VwIGZvciBWUEMgZW5kcG9pbnRzXCIsXG4gICAgICAgIFNlY3VyaXR5R3JvdXBJbmdyZXNzOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgQ2lkcklwOiBNYXRjaC5hbnlWYWx1ZSgpLFxuICAgICAgICAgICAgSXBQcm90b2NvbDogXCJ0Y3BcIixcbiAgICAgICAgICAgIEZyb21Qb3J0OiA0NDMsXG4gICAgICAgICAgICBUb1BvcnQ6IDQ0MyxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSlcbiAgICB9KVxuICB9KVxuXG4gIGRlc2NyaWJlKFwiU3VibmV0IENvbmZpZ3VyYXRpb25cIiwgKCkgPT4ge1xuICAgIHRlc3QoXCJwcm92aWRlcyBoZWxwZXIgbWV0aG9kIGZvciB3b3JrbG9hZC1zcGVjaWZpYyBzdWJuZXRzXCIsICgpID0+IHtcbiAgICAgIC8vIEFycmFuZ2VcbiAgICAgIGNvbnN0IGNvbmZpZyA9IEVudmlyb25tZW50Q29uZmlnLmdldChcImRldlwiKVxuXG4gICAgICAvLyBBY3RcbiAgICAgIGNvbnN0IHZwYyA9IG5ldyBTaGFyZWRWUEMoc3RhY2ssIFwiVGVzdFZQQ1wiLCB7XG4gICAgICAgIGVudmlyb25tZW50OiBcImRldlwiLFxuICAgICAgICBjb25maWcsXG4gICAgICB9KVxuXG4gICAgICAvLyBBc3NlcnRcbiAgICAgIGV4cGVjdCh2cGMuZ2V0U3VibmV0c0Zvcldvcmtsb2FkKFwid2ViXCIpKS50b0VxdWFsKHtcbiAgICAgICAgc3VibmV0VHlwZTogY2RrLmF3c19lYzIuU3VibmV0VHlwZS5QVUJMSUMsXG4gICAgICB9KVxuICAgICAgZXhwZWN0KHZwYy5nZXRTdWJuZXRzRm9yV29ya2xvYWQoXCJhcHBcIikpLnRvRXF1YWwoe1xuICAgICAgICBzdWJuZXRHcm91cE5hbWU6IFwiUHJpdmF0ZS1BcHBsaWNhdGlvblwiLFxuICAgICAgfSlcbiAgICAgIGV4cGVjdCh2cGMuZ2V0U3VibmV0c0Zvcldvcmtsb2FkKFwiZGF0YVwiKSkudG9FcXVhbCh7XG4gICAgICAgIHN1Ym5ldEdyb3VwTmFtZTogXCJQcml2YXRlLURhdGFcIixcbiAgICAgIH0pXG4gICAgICBleHBlY3QodnBjLmdldFN1Ym5ldHNGb3JXb3JrbG9hZChcInNlY3VyZVwiKSkudG9FcXVhbCh7XG4gICAgICAgIHN1Ym5ldFR5cGU6IGNkay5hd3NfZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9JU09MQVRFRCxcbiAgICAgIH0pXG4gICAgfSlcblxuICAgIHRlc3QoXCJjcmVhdGVzIHN1Ym5ldHMgd2l0aCBwcm9wZXIgQ0lEUiBtYXNrc1wiLCAoKSA9PiB7XG4gICAgICAvLyBBcnJhbmdlXG4gICAgICBjb25zdCBjb25maWcgPSBFbnZpcm9ubWVudENvbmZpZy5nZXQoXCJkZXZcIilcblxuICAgICAgLy8gQWN0XG4gICAgICBuZXcgU2hhcmVkVlBDKHN0YWNrLCBcIlRlc3RWUENcIiwge1xuICAgICAgICBlbnZpcm9ubWVudDogXCJkZXZcIixcbiAgICAgICAgY29uZmlnLFxuICAgICAgfSlcblxuICAgICAgLy8gQXNzZXJ0XG4gICAgICBjb25zdCB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjaylcblxuICAgICAgLy8gVmVyaWZ5IHN1Ym5ldHMgd2l0aCBkaWZmZXJlbnQgQ0lEUiBtYXNrc1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKFwiQVdTOjpFQzI6OlN1Ym5ldFwiLCB7XG4gICAgICAgIENpZHJCbG9jazogTWF0Y2guc3RyaW5nTGlrZVJlZ2V4cChcIi4qXFxcXC4wLzI0XCIpLCAvLyAvMjQgc3VibmV0c1xuICAgICAgfSlcblxuICAgICAgLy8gU2hvdWxkIGhhdmUgbGFyZ2VyIHN1Ym5ldCBmb3IgYXBwbGljYXRpb25zICgvMjIpXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoXCJBV1M6OkVDMjo6U3VibmV0XCIsIHtcbiAgICAgICAgQ2lkckJsb2NrOiBNYXRjaC5zdHJpbmdMaWtlUmVnZXhwKFwiLipcXFxcLjAvMjJcIiksXG4gICAgICB9KVxuICAgIH0pXG4gIH0pXG5cbiAgZGVzY3JpYmUoXCJGbG93IExvZ3NcIiwgKCkgPT4ge1xuICAgIHRlc3QoXCJjYW4gZGlzYWJsZSBmbG93IGxvZ3NcIiwgKCkgPT4ge1xuICAgICAgLy8gQXJyYW5nZVxuICAgICAgY29uc3QgY29uZmlnID0gRW52aXJvbm1lbnRDb25maWcuZ2V0KFwiZGV2XCIpXG5cbiAgICAgIC8vIEFjdFxuICAgICAgbmV3IFNoYXJlZFZQQyhzdGFjaywgXCJUZXN0VlBDXCIsIHtcbiAgICAgICAgZW52aXJvbm1lbnQ6IFwiZGV2XCIsXG4gICAgICAgIGNvbmZpZyxcbiAgICAgICAgZW5hYmxlRmxvd0xvZ3M6IGZhbHNlLFxuICAgICAgfSlcblxuICAgICAgLy8gQXNzZXJ0XG4gICAgICBjb25zdCB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjaylcblxuICAgICAgLy8gU2hvdWxkIG5vdCBjcmVhdGUgZmxvdyBsb2dzXG4gICAgICB0ZW1wbGF0ZS5yZXNvdXJjZUNvdW50SXMoXCJBV1M6OkVDMjo6Rmxvd0xvZ1wiLCAwKVxuICAgICAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKFxuICAgICAgICBcIkFXUzo6UzM6OkJ1Y2tldFwiLFxuICAgICAgICAwIC8vIE5vIGZsb3cgbG9nIGJ1Y2tldFxuICAgICAgKVxuICAgIH0pXG4gIH0pXG5cbiAgZGVzY3JpYmUoXCJUYWdzXCIsICgpID0+IHtcbiAgICB0ZXN0KFwidGFncyBzdWJuZXRzIGFwcHJvcHJpYXRlbHlcIiwgKCkgPT4ge1xuICAgICAgLy8gQXJyYW5nZVxuICAgICAgY29uc3QgY29uZmlnID0gRW52aXJvbm1lbnRDb25maWcuZ2V0KFwiZGV2XCIpXG5cbiAgICAgIC8vIEFjdFxuICAgICAgbmV3IFNoYXJlZFZQQyhzdGFjaywgXCJUZXN0VlBDXCIsIHtcbiAgICAgICAgZW52aXJvbm1lbnQ6IFwiZGV2XCIsXG4gICAgICAgIGNvbmZpZyxcbiAgICAgIH0pXG5cbiAgICAgIC8vIEFzc2VydFxuICAgICAgY29uc3QgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spXG5cbiAgICAgIC8vIFB1YmxpYyBzdWJuZXRzIHNob3VsZCBoYXZlIEVMQiB0YWdcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlKFwiQVdTOjpFQzI6OlN1Ym5ldFwiLCB7XG4gICAgICAgIFByb3BlcnRpZXM6IE1hdGNoLm9iamVjdExpa2Uoe1xuICAgICAgICAgIFRhZ3M6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIEtleTogXCJrdWJlcm5ldGVzLmlvL3JvbGUvZWxiXCIsXG4gICAgICAgICAgICAgIFZhbHVlOiBcIjFcIixcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgXSksXG4gICAgICAgIH0pLFxuICAgICAgfSlcbiAgICB9KVxuICB9KVxufSlcbiJdfQ==