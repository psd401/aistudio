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
        test("uses NAT gateways for all environments", () => {
            // Arrange
            const config = constructs_1.EnvironmentConfig.get("dev");
            // Act
            new constructs_1.SharedVPC(stack, "TestVPC", {
                environment: "dev",
                config,
            });
            // Assert
            const template = assertions_1.Template.fromStack(stack);
            // All environments now use NAT gateways (Issue #617 removed NAT instances)
            template.hasResourceProperties("AWS::EC2::NatGateway", {
                AllocationId: assertions_1.Match.anyValue(),
            });
        });
        test("creates only gateway endpoints by default (cost optimization)", () => {
            // Arrange
            const config = constructs_1.EnvironmentConfig.get("dev");
            // Act
            new constructs_1.SharedVPC(stack, "TestVPC", {
                environment: "dev",
                config,
            });
            // Assert
            const template = assertions_1.Template.fromStack(stack);
            // Gateway endpoints (S3, DynamoDB) - FREE
            template.hasResourceProperties("AWS::EC2::VPCEndpoint", {
                ServiceName: assertions_1.Match.objectLike({
                    "Fn::Join": assertions_1.Match.arrayWith([
                        assertions_1.Match.arrayWith([assertions_1.Match.stringLikeRegexp(".*s3.*")]),
                    ]),
                }),
            });
            // Only gateway endpoints should exist (S3 + DynamoDB = 2)
            // Interface endpoints are disabled by default for cost optimization (Issue #617)
            const vpcEndpoints = template.findResources("AWS::EC2::VPCEndpoint");
            expect(Object.keys(vpcEndpoints).length).toBe(2);
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
        test("creates only gateway endpoints by default (cost optimization)", () => {
            // Arrange
            const config = constructs_1.EnvironmentConfig.get("prod");
            // Act
            new constructs_1.SharedVPC(stack, "TestVPC", {
                environment: "prod",
                config,
            });
            // Assert
            const template = assertions_1.Template.fromStack(stack);
            // Only gateway endpoints by default (Issue #617 - interface endpoints disabled)
            const vpcEndpoints = template.findResources("AWS::EC2::VPCEndpoint");
            expect(Object.keys(vpcEndpoints).length).toBe(2); // S3 + DynamoDB
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
        test("disables all endpoints when enableGatewayEndpoints is false", () => {
            // Arrange
            const config = constructs_1.EnvironmentConfig.get("dev");
            // Act
            new constructs_1.SharedVPC(stack, "TestVPC", {
                environment: "dev",
                config,
                enableGatewayEndpoints: false,
            });
            // Assert
            const template = assertions_1.Template.fromStack(stack);
            // Should have no VPC endpoints
            const vpcEndpoints = template.findResources("AWS::EC2::VPCEndpoint");
            expect(Object.keys(vpcEndpoints).length).toBe(0);
        });
        test("creates interface endpoints when explicitly enabled", () => {
            // Arrange
            const config = constructs_1.EnvironmentConfig.get("dev");
            // Act
            new constructs_1.SharedVPC(stack, "TestVPC", {
                environment: "dev",
                config,
                enableInterfaceEndpoints: true,
            });
            // Assert
            const template = assertions_1.Template.fromStack(stack);
            // Should have gateway + interface endpoints
            const vpcEndpoints = template.findResources("AWS::EC2::VPCEndpoint");
            expect(Object.keys(vpcEndpoints).length).toBeGreaterThan(10);
            // Security group for interface endpoints
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
        test("production gets additional interface endpoints when enabled", () => {
            // Arrange
            const devConfig = constructs_1.EnvironmentConfig.get("dev");
            const prodConfig = constructs_1.EnvironmentConfig.get("prod");
            // Act
            const devStack = new cdk.Stack(app, "DevStack", {
                env: { account: "123456789012", region: "us-east-1" },
            });
            const prodStack = new cdk.Stack(app, "ProdStack", {
                env: { account: "123456789012", region: "us-east-1" },
            });
            new constructs_1.SharedVPC(devStack, "DevVPC", {
                environment: "dev",
                config: devConfig,
                enableInterfaceEndpoints: true,
            });
            new constructs_1.SharedVPC(prodStack, "ProdVPC", {
                environment: "prod",
                config: prodConfig,
                enableInterfaceEndpoints: true,
            });
            // Assert
            const devTemplate = assertions_1.Template.fromStack(devStack);
            const prodTemplate = assertions_1.Template.fromStack(prodStack);
            const devEndpoints = devTemplate.findResources("AWS::EC2::VPCEndpoint");
            const prodEndpoints = prodTemplate.findResources("AWS::EC2::VPCEndpoint");
            // Prod should have more endpoints (includes Textract, Comprehend)
            expect(Object.keys(prodEndpoints).length).toBeGreaterThan(Object.keys(devEndpoints).length);
        });
        test("backwards compatibility: enableVpcEndpoints false disables all", () => {
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
            // Should have no VPC endpoints
            const vpcEndpoints = template.findResources("AWS::EC2::VPCEndpoint");
            expect(Object.keys(vpcEndpoints).length).toBe(0);
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
    describe("Cost Optimization (Issue #617)", () => {
        test("interface endpoints disabled by default saves ~$428/month", () => {
            // Arrange
            const devConfig = constructs_1.EnvironmentConfig.get("dev");
            const prodConfig = constructs_1.EnvironmentConfig.get("prod");
            // Act - Create VPCs with default settings
            const devStack = new cdk.Stack(app, "CostDevStack", {
                env: { account: "123456789012", region: "us-east-1" },
            });
            const prodStack = new cdk.Stack(app, "CostProdStack", {
                env: { account: "123456789012", region: "us-east-1" },
            });
            new constructs_1.SharedVPC(devStack, "DevVPC", {
                environment: "dev",
                config: devConfig,
            });
            new constructs_1.SharedVPC(prodStack, "ProdVPC", {
                environment: "prod",
                config: prodConfig,
            });
            // Assert
            const devTemplate = assertions_1.Template.fromStack(devStack);
            const prodTemplate = assertions_1.Template.fromStack(prodStack);
            // Both should only have 2 gateway endpoints (S3, DynamoDB)
            const devEndpoints = devTemplate.findResources("AWS::EC2::VPCEndpoint");
            const prodEndpoints = prodTemplate.findResources("AWS::EC2::VPCEndpoint");
            expect(Object.keys(devEndpoints).length).toBe(2);
            expect(Object.keys(prodEndpoints).length).toBe(2);
            // No security groups for interface endpoints
            const devSGs = devTemplate.findResources("AWS::EC2::SecurityGroup");
            const sgCount = Object.values(devSGs).filter((sg) => {
                const desc = sg?.Properties?.GroupDescription;
                return desc === "Security group for VPC endpoints";
            }).length;
            expect(sgCount).toBe(0);
        });
    });
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2hhcmVkLXZwYy50ZXN0LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsic2hhcmVkLXZwYy50ZXN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQWtDO0FBQ2xDLHVEQUF3RDtBQUN4RCxxREFHNkI7QUFFN0IsUUFBUSxDQUFDLHFCQUFxQixFQUFFLEdBQUcsRUFBRTtJQUNuQyxJQUFJLEdBQVksQ0FBQTtJQUNoQixJQUFJLEtBQWdCLENBQUE7SUFFcEIsVUFBVSxDQUFDLEdBQUcsRUFBRTtRQUNkLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQTtRQUNuQixLQUFLLEdBQUcsSUFBSSxHQUFHLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRSxXQUFXLEVBQUU7WUFDdEMsR0FBRyxFQUFFLEVBQUUsT0FBTyxFQUFFLGNBQWMsRUFBRSxNQUFNLEVBQUUsV0FBVyxFQUFFO1NBQ3RELENBQUMsQ0FBQTtJQUNKLENBQUMsQ0FBQyxDQUFBO0lBRUYsUUFBUSxDQUFDLHlCQUF5QixFQUFFLEdBQUcsRUFBRTtRQUN2QyxJQUFJLENBQUMsK0NBQStDLEVBQUUsR0FBRyxFQUFFO1lBQ3pELFVBQVU7WUFDVixNQUFNLE1BQU0sR0FBRyw4QkFBaUIsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLENBQUE7WUFFM0MsTUFBTTtZQUNOLElBQUksc0JBQVMsQ0FBQyxLQUFLLEVBQUUsU0FBUyxFQUFFO2dCQUM5QixXQUFXLEVBQUUsS0FBSztnQkFDbEIsTUFBTTthQUNQLENBQUMsQ0FBQTtZQUVGLFNBQVM7WUFDVCxNQUFNLFFBQVEsR0FBRyxxQkFBUSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQTtZQUUxQyxzQkFBc0I7WUFDdEIsUUFBUSxDQUFDLHFCQUFxQixDQUFDLGVBQWUsRUFBRTtnQkFDOUMsa0JBQWtCLEVBQUUsSUFBSTtnQkFDeEIsZ0JBQWdCLEVBQUUs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QyxDQUFDLE1BQU0sQ0FBQTtZQUNULE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUE7UUFDekIsQ0FBQyxDQUFDLENBQUE7SUFDSixDQUFDLENBQUMsQ0FBQTtBQUNKLENBQUMsQ0FBQyxDQUFBIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gXCJhd3MtY2RrLWxpYlwiXG5pbXBvcnQgeyBUZW1wbGF0ZSwgTWF0Y2ggfSBmcm9tIFwiYXdzLWNkay1saWIvYXNzZXJ0aW9uc1wiXG5pbXBvcnQge1xuICBTaGFyZWRWUEMsXG4gIEVudmlyb25tZW50Q29uZmlnLFxufSBmcm9tIFwiLi4vLi4vbGliL2NvbnN0cnVjdHNcIlxuXG5kZXNjcmliZShcIlNoYXJlZFZQQyBDb25zdHJ1Y3RcIiwgKCkgPT4ge1xuICBsZXQgYXBwOiBjZGsuQXBwXG4gIGxldCBzdGFjazogY2RrLlN0YWNrXG5cbiAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgYXBwID0gbmV3IGNkay5BcHAoKVxuICAgIHN0YWNrID0gbmV3IGNkay5TdGFjayhhcHAsIFwiVGVzdFN0YWNrXCIsIHtcbiAgICAgIGVudjogeyBhY2NvdW50OiBcIjEyMzQ1Njc4OTAxMlwiLCByZWdpb246IFwidXMtZWFzdC0xXCIgfSxcbiAgICB9KVxuICB9KVxuXG4gIGRlc2NyaWJlKFwiRGV2ZWxvcG1lbnQgRW52aXJvbm1lbnRcIiwgKCkgPT4ge1xuICAgIHRlc3QoXCJjcmVhdGVzIFZQQyB3aXRoIGNvcnJlY3Qgc3VibmV0IGNvbmZpZ3VyYXRpb25cIiwgKCkgPT4ge1xuICAgICAgLy8gQXJyYW5nZVxuICAgICAgY29uc3QgY29uZmlnID0gRW52aXJvbm1lbnRDb25maWcuZ2V0KFwiZGV2XCIpXG5cbiAgICAgIC8vIEFjdFxuICAgICAgbmV3IFNoYXJlZFZQQyhzdGFjaywgXCJUZXN0VlBDXCIsIHtcbiAgICAgICAgZW52aXJvbm1lbnQ6IFwiZGV2XCIsXG4gICAgICAgIGNvbmZpZyxcbiAgICAgIH0pXG5cbiAgICAgIC8vIEFzc2VydFxuICAgICAgY29uc3QgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spXG5cbiAgICAgIC8vIFZlcmlmeSBWUEMgY3JlYXRpb25cbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcyhcIkFXUzo6RUMyOjpWUENcIiwge1xuICAgICAgICBFbmFibGVEbnNIb3N0bmFtZXM6IHRydWUsXG4gICAgICAgIEVuYWJsZURuc1N1cHBvcnQ6IHRydWUsXG4gICAgICB9KVxuXG4gICAgICAvLyBWZXJpZnkgbXVsdGlwbGUgc3VibmV0cyBleGlzdCAocHVibGljLCBwcml2YXRlIGFwcCwgcHJpdmF0ZSBkYXRhLCBpc29sYXRlZClcbiAgICAgIGNvbnN0IHN1Ym5ldHMgPSB0ZW1wbGF0ZS5maW5kUmVzb3VyY2VzKFwiQVdTOjpFQzI6OlN1Ym5ldFwiKVxuICAgICAgZXhwZWN0KE9iamVjdC5rZXlzKHN1Ym5ldHMpLmxlbmd0aCkudG9CZUdyZWF0ZXJUaGFuKDQpXG4gICAgfSlcblxuICAgIHRlc3QoXCJ1c2VzIE5BVCBnYXRld2F5cyBmb3IgYWxsIGVudmlyb25tZW50c1wiLCAoKSA9PiB7XG4gICAgICAvLyBBcnJhbmdlXG4gICAgICBjb25zdCBjb25maWcgPSBFbnZpcm9ubWVudENvbmZpZy5nZXQoXCJkZXZcIilcblxuICAgICAgLy8gQWN0XG4gICAgICBuZXcgU2hhcmVkVlBDKHN0YWNrLCBcIlRlc3RWUENcIiwge1xuICAgICAgICBlbnZpcm9ubWVudDogXCJkZXZcIixcbiAgICAgICAgY29uZmlnLFxuICAgICAgfSlcblxuICAgICAgLy8gQXNzZXJ0XG4gICAgICBjb25zdCB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjaylcblxuICAgICAgLy8gQWxsIGVudmlyb25tZW50cyBub3cgdXNlIE5BVCBnYXRld2F5cyAoSXNzdWUgIzYxNyByZW1vdmVkIE5BVCBpbnN0YW5jZXMpXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoXCJBV1M6OkVDMjo6TmF0R2F0ZXdheVwiLCB7XG4gICAgICAgIEFsbG9jYXRpb25JZDogTWF0Y2guYW55VmFsdWUoKSxcbiAgICAgIH0pXG4gICAgfSlcblxuICAgIHRlc3QoXCJjcmVhdGVzIG9ubHkgZ2F0ZXdheSBlbmRwb2ludHMgYnkgZGVmYXVsdCAoY29zdCBvcHRpbWl6YXRpb24pXCIsICgpID0+IHtcbiAgICAgIC8vIEFycmFuZ2VcbiAgICAgIGNvbnN0IGNvbmZpZyA9IEVudmlyb25tZW50Q29uZmlnLmdldChcImRldlwiKVxuXG4gICAgICAvLyBBY3RcbiAgICAgIG5ldyBTaGFyZWRWUEMoc3RhY2ssIFwiVGVzdFZQQ1wiLCB7XG4gICAgICAgIGVudmlyb25tZW50OiBcImRldlwiLFxuICAgICAgICBjb25maWcsXG4gICAgICB9KVxuXG4gICAgICAvLyBBc3NlcnRcbiAgICAgIGNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKVxuXG4gICAgICAvLyBHYXRld2F5IGVuZHBvaW50cyAoUzMsIER5bmFtb0RCKSAtIEZSRUVcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcyhcIkFXUzo6RUMyOjpWUENFbmRwb2ludFwiLCB7XG4gICAgICAgIFNlcnZpY2VOYW1lOiBNYXRjaC5vYmplY3RMaWtlKHtcbiAgICAgICAgICBcIkZuOjpKb2luXCI6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgICAgICBNYXRjaC5hcnJheVdpdGgoW01hdGNoLnN0cmluZ0xpa2VSZWdleHAoXCIuKnMzLipcIildKSxcbiAgICAgICAgICBdKSxcbiAgICAgICAgfSksXG4gICAgICB9KVxuXG4gICAgICAvLyBPbmx5IGdhdGV3YXkgZW5kcG9pbnRzIHNob3VsZCBleGlzdCAoUzMgKyBEeW5hbW9EQiA9IDIpXG4gICAgICAvLyBJbnRlcmZhY2UgZW5kcG9pbnRzIGFyZSBkaXNhYmxlZCBieSBkZWZhdWx0IGZvciBjb3N0IG9wdGltaXphdGlvbiAoSXNzdWUgIzYxNylcbiAgICAgIGNvbnN0IHZwY0VuZHBvaW50cyA9IHRlbXBsYXRlLmZpbmRSZXNvdXJjZXMoXCJBV1M6OkVDMjo6VlBDRW5kcG9pbnRcIilcbiAgICAgIGV4cGVjdChPYmplY3Qua2V5cyh2cGNFbmRwb2ludHMpLmxlbmd0aCkudG9CZSgyKVxuICAgIH0pXG5cbiAgICB0ZXN0KFwiZW5hYmxlcyBWUEMgZmxvdyBsb2dzIHRvIFMzXCIsICgpID0+IHtcbiAgICAgIC8vIEFycmFuZ2VcbiAgICAgIGNvbnN0IGNvbmZpZyA9IEVudmlyb25tZW50Q29uZmlnLmdldChcImRldlwiKVxuXG4gICAgICAvLyBBY3RcbiAgICAgIG5ldyBTaGFyZWRWUEMoc3RhY2ssIFwiVGVzdFZQQ1wiLCB7XG4gICAgICAgIGVudmlyb25tZW50OiBcImRldlwiLFxuICAgICAgICBjb25maWcsXG4gICAgICAgIGVuYWJsZUZsb3dMb2dzOiB0cnVlLFxuICAgICAgfSlcblxuICAgICAgLy8gQXNzZXJ0XG4gICAgICBjb25zdCB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjaylcblxuICAgICAgLy8gUzMgYnVja2V0IGZvciBmbG93IGxvZ3NcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcyhcIkFXUzo6UzM6OkJ1Y2tldFwiLCB7XG4gICAgICAgIEJ1Y2tldEVuY3J5cHRpb246IHtcbiAgICAgICAgICBTZXJ2ZXJTaWRlRW5jcnlwdGlvbkNvbmZpZ3VyYXRpb246IFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgU2VydmVyU2lkZUVuY3J5cHRpb25CeURlZmF1bHQ6IHtcbiAgICAgICAgICAgICAgICBTU0VBbGdvcml0aG06IFwiQUVTMjU2XCIsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICAgIExpZmVjeWNsZUNvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBSdWxlczogW1xuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBTdGF0dXM6IFwiRW5hYmxlZFwiLFxuICAgICAgICAgICAgICBFeHBpcmF0aW9uSW5EYXlzOiAzMCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgIH0pXG5cbiAgICAgIC8vIEZsb3cgbG9nIHJlc291cmNlXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoXCJBV1M6OkVDMjo6Rmxvd0xvZ1wiLCB7XG4gICAgICAgIFJlc291cmNlVHlwZTogXCJWUENcIixcbiAgICAgICAgVHJhZmZpY1R5cGU6IFwiQUxMXCIsXG4gICAgICAgIE1heEFnZ3JlZ2F0aW9uSW50ZXJ2YWw6IDYwMCwgLy8gMTAgbWludXRlc1xuICAgICAgfSlcbiAgICB9KVxuICB9KVxuXG4gIGRlc2NyaWJlKFwiUHJvZHVjdGlvbiBFbnZpcm9ubWVudFwiLCAoKSA9PiB7XG4gICAgdGVzdChcInVzZXMgTkFUIGdhdGV3YXlzIGZvciByZWxpYWJpbGl0eVwiLCAoKSA9PiB7XG4gICAgICAvLyBBcnJhbmdlXG4gICAgICBjb25zdCBjb25maWcgPSBFbnZpcm9ubWVudENvbmZpZy5nZXQoXCJwcm9kXCIpXG5cbiAgICAgIC8vIEFjdFxuICAgICAgbmV3IFNoYXJlZFZQQyhzdGFjaywgXCJUZXN0VlBDXCIsIHtcbiAgICAgICAgZW52aXJvbm1lbnQ6IFwicHJvZFwiLFxuICAgICAgICBjb25maWcsXG4gICAgICB9KVxuXG4gICAgICAvLyBBc3NlcnRcbiAgICAgIGNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKVxuXG4gICAgICAvLyBQcm9kIHNob3VsZCB1c2UgTkFUIEdhdGV3YXlzIChtb3JlIHJlbGlhYmxlKVxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKFwiQVdTOjpFQzI6Ok5hdEdhdGV3YXlcIiwge1xuICAgICAgICBBbGxvY2F0aW9uSWQ6IE1hdGNoLmFueVZhbHVlKCksXG4gICAgICB9KVxuICAgIH0pXG5cbiAgICB0ZXN0KFwiY3JlYXRlcyBvbmx5IGdhdGV3YXkgZW5kcG9pbnRzIGJ5IGRlZmF1bHQgKGNvc3Qgb3B0aW1pemF0aW9uKVwiLCAoKSA9PiB7XG4gICAgICAvLyBBcnJhbmdlXG4gICAgICBjb25zdCBjb25maWcgPSBFbnZpcm9ubWVudENvbmZpZy5nZXQoXCJwcm9kXCIpXG5cbiAgICAgIC8vIEFjdFxuICAgICAgbmV3IFNoYXJlZFZQQyhzdGFjaywgXCJUZXN0VlBDXCIsIHtcbiAgICAgICAgZW52aXJvbm1lbnQ6IFwicHJvZFwiLFxuICAgICAgICBjb25maWcsXG4gICAgICB9KVxuXG4gICAgICAvLyBBc3NlcnRcbiAgICAgIGNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKVxuXG4gICAgICAvLyBPbmx5IGdhdGV3YXkgZW5kcG9pbnRzIGJ5IGRlZmF1bHQgKElzc3VlICM2MTcgLSBpbnRlcmZhY2UgZW5kcG9pbnRzIGRpc2FibGVkKVxuICAgICAgY29uc3QgdnBjRW5kcG9pbnRzID0gdGVtcGxhdGUuZmluZFJlc291cmNlcyhcIkFXUzo6RUMyOjpWUENFbmRwb2ludFwiKVxuICAgICAgZXhwZWN0KE9iamVjdC5rZXlzKHZwY0VuZHBvaW50cykubGVuZ3RoKS50b0JlKDIpIC8vIFMzICsgRHluYW1vREJcbiAgICB9KVxuXG4gICAgdGVzdChcImVuYWJsZXMgQ2xvdWRXYXRjaCBMb2dzIGZvciByZWplY3RlZCB0cmFmZmljXCIsICgpID0+IHtcbiAgICAgIC8vIEFycmFuZ2VcbiAgICAgIGNvbnN0IGNvbmZpZyA9IEVudmlyb25tZW50Q29uZmlnLmdldChcInByb2RcIilcblxuICAgICAgLy8gQWN0XG4gICAgICBuZXcgU2hhcmVkVlBDKHN0YWNrLCBcIlRlc3RWUENcIiwge1xuICAgICAgICBlbnZpcm9ubWVudDogXCJwcm9kXCIsXG4gICAgICAgIGNvbmZpZyxcbiAgICAgICAgZW5hYmxlRmxvd0xvZ3M6IHRydWUsXG4gICAgICB9KVxuXG4gICAgICAvLyBBc3NlcnRcbiAgICAgIGNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKVxuXG4gICAgICAvLyBMb2cgZ3JvdXAgZm9yIGZsb3cgbG9nc1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKFwiQVdTOjpMb2dzOjpMb2dHcm91cFwiLCB7XG4gICAgICAgIExvZ0dyb3VwTmFtZTogXCIvYXdzL3ZwYy9mbG93bG9ncy9wcm9kXCIsXG4gICAgICAgIFJldGVudGlvbkluRGF5czogNyxcbiAgICAgIH0pXG5cbiAgICAgIC8vIFNob3VsZCBoYXZlIGJvdGggUzMgYW5kIENsb3VkV2F0Y2ggZmxvdyBsb2dzXG4gICAgICBjb25zdCBmbG93TG9ncyA9IHRlbXBsYXRlLmZpbmRSZXNvdXJjZXMoXCJBV1M6OkVDMjo6Rmxvd0xvZ1wiKVxuICAgICAgZXhwZWN0KE9iamVjdC5rZXlzKGZsb3dMb2dzKS5sZW5ndGgpLnRvQmUoMilcbiAgICB9KVxuXG4gICAgdGVzdChcImNvbmZpZ3VyZXMgcHJvcGVyIGxpZmVjeWNsZSBmb3IgZmxvdyBsb2cgc3RvcmFnZVwiLCAoKSA9PiB7XG4gICAgICAvLyBBcnJhbmdlXG4gICAgICBjb25zdCBjb25maWcgPSBFbnZpcm9ubWVudENvbmZpZy5nZXQoXCJwcm9kXCIpXG5cbiAgICAgIC8vIEFjdFxuICAgICAgbmV3IFNoYXJlZFZQQyhzdGFjaywgXCJUZXN0VlBDXCIsIHtcbiAgICAgICAgZW52aXJvbm1lbnQ6IFwicHJvZFwiLFxuICAgICAgICBjb25maWcsXG4gICAgICAgIGVuYWJsZUZsb3dMb2dzOiB0cnVlLFxuICAgICAgfSlcblxuICAgICAgLy8gQXNzZXJ0XG4gICAgICBjb25zdCB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjaylcblxuICAgICAgLy8gUzMgYnVja2V0IHdpdGggcHJvZHVjdGlvbiBsaWZlY3ljbGVcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcyhcIkFXUzo6UzM6OkJ1Y2tldFwiLCB7XG4gICAgICAgIExpZmVjeWNsZUNvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBSdWxlczogW1xuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBTdGF0dXM6IFwiRW5hYmxlZFwiLFxuICAgICAgICAgICAgICBFeHBpcmF0aW9uSW5EYXlzOiA5MCxcbiAgICAgICAgICAgICAgVHJhbnNpdGlvbnM6IFtcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICBTdG9yYWdlQ2xhc3M6IFwiU1RBTkRBUkRfSUFcIixcbiAgICAgICAgICAgICAgICAgIFRyYW5zaXRpb25JbkRheXM6IDMwLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICB9KVxuICAgIH0pXG4gIH0pXG5cbiAgZGVzY3JpYmUoXCJWUEMgRW5kcG9pbnRzIENvbmZpZ3VyYXRpb25cIiwgKCkgPT4ge1xuICAgIHRlc3QoXCJkaXNhYmxlcyBhbGwgZW5kcG9pbnRzIHdoZW4gZW5hYmxlR2F0ZXdheUVuZHBvaW50cyBpcyBmYWxzZVwiLCAoKSA9PiB7XG4gICAgICAvLyBBcnJhbmdlXG4gICAgICBjb25zdCBjb25maWcgPSBFbnZpcm9ubWVudENvbmZpZy5nZXQoXCJkZXZcIilcblxuICAgICAgLy8gQWN0XG4gICAgICBuZXcgU2hhcmVkVlBDKHN0YWNrLCBcIlRlc3RWUENcIiwge1xuICAgICAgICBlbnZpcm9ubWVudDogXCJkZXZcIixcbiAgICAgICAgY29uZmlnLFxuICAgICAgICBlbmFibGVHYXRld2F5RW5kcG9pbnRzOiBmYWxzZSxcbiAgICAgIH0pXG5cbiAgICAgIC8vIEFzc2VydFxuICAgICAgY29uc3QgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spXG5cbiAgICAgIC8vIFNob3VsZCBoYXZlIG5vIFZQQyBlbmRwb2ludHNcbiAgICAgIGNvbnN0IHZwY0VuZHBvaW50cyA9IHRlbXBsYXRlLmZpbmRSZXNvdXJjZXMoXCJBV1M6OkVDMjo6VlBDRW5kcG9pbnRcIilcbiAgICAgIGV4cGVjdChPYmplY3Qua2V5cyh2cGNFbmRwb2ludHMpLmxlbmd0aCkudG9CZSgwKVxuICAgIH0pXG5cbiAgICB0ZXN0KFwiY3JlYXRlcyBpbnRlcmZhY2UgZW5kcG9pbnRzIHdoZW4gZXhwbGljaXRseSBlbmFibGVkXCIsICgpID0+IHtcbiAgICAgIC8vIEFycmFuZ2VcbiAgICAgIGNvbnN0IGNvbmZpZyA9IEVudmlyb25tZW50Q29uZmlnLmdldChcImRldlwiKVxuXG4gICAgICAvLyBBY3RcbiAgICAgIG5ldyBTaGFyZWRWUEMoc3RhY2ssIFwiVGVzdFZQQ1wiLCB7XG4gICAgICAgIGVudmlyb25tZW50OiBcImRldlwiLFxuICAgICAgICBjb25maWcsXG4gICAgICAgIGVuYWJsZUludGVyZmFjZUVuZHBvaW50czogdHJ1ZSxcbiAgICAgIH0pXG5cbiAgICAgIC8vIEFzc2VydFxuICAgICAgY29uc3QgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spXG5cbiAgICAgIC8vIFNob3VsZCBoYXZlIGdhdGV3YXkgKyBpbnRlcmZhY2UgZW5kcG9pbnRzXG4gICAgICBjb25zdCB2cGNFbmRwb2ludHMgPSB0ZW1wbGF0ZS5maW5kUmVzb3VyY2VzKFwiQVdTOjpFQzI6OlZQQ0VuZHBvaW50XCIpXG4gICAgICBleHBlY3QoT2JqZWN0LmtleXModnBjRW5kcG9pbnRzKS5sZW5ndGgpLnRvQmVHcmVhdGVyVGhhbigxMClcblxuICAgICAgLy8gU2VjdXJpdHkgZ3JvdXAgZm9yIGludGVyZmFjZSBlbmRwb2ludHNcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcyhcIkFXUzo6RUMyOjpTZWN1cml0eUdyb3VwXCIsIHtcbiAgICAgICAgR3JvdXBEZXNjcmlwdGlvbjogXCJTZWN1cml0eSBncm91cCBmb3IgVlBDIGVuZHBvaW50c1wiLFxuICAgICAgICBTZWN1cml0eUdyb3VwSW5ncmVzczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIENpZHJJcDogTWF0Y2guYW55VmFsdWUoKSxcbiAgICAgICAgICAgIElwUHJvdG9jb2w6IFwidGNwXCIsXG4gICAgICAgICAgICBGcm9tUG9ydDogNDQzLFxuICAgICAgICAgICAgVG9Qb3J0OiA0NDMsXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0pXG4gICAgfSlcblxuICAgIHRlc3QoXCJwcm9kdWN0aW9uIGdldHMgYWRkaXRpb25hbCBpbnRlcmZhY2UgZW5kcG9pbnRzIHdoZW4gZW5hYmxlZFwiLCAoKSA9PiB7XG4gICAgICAvLyBBcnJhbmdlXG4gICAgICBjb25zdCBkZXZDb25maWcgPSBFbnZpcm9ubWVudENvbmZpZy5nZXQoXCJkZXZcIilcbiAgICAgIGNvbnN0IHByb2RDb25maWcgPSBFbnZpcm9ubWVudENvbmZpZy5nZXQoXCJwcm9kXCIpXG5cbiAgICAgIC8vIEFjdFxuICAgICAgY29uc3QgZGV2U3RhY2sgPSBuZXcgY2RrLlN0YWNrKGFwcCwgXCJEZXZTdGFja1wiLCB7XG4gICAgICAgIGVudjogeyBhY2NvdW50OiBcIjEyMzQ1Njc4OTAxMlwiLCByZWdpb246IFwidXMtZWFzdC0xXCIgfSxcbiAgICAgIH0pXG4gICAgICBjb25zdCBwcm9kU3RhY2sgPSBuZXcgY2RrLlN0YWNrKGFwcCwgXCJQcm9kU3RhY2tcIiwge1xuICAgICAgICBlbnY6IHsgYWNjb3VudDogXCIxMjM0NTY3ODkwMTJcIiwgcmVnaW9uOiBcInVzLWVhc3QtMVwiIH0sXG4gICAgICB9KVxuXG4gICAgICBuZXcgU2hhcmVkVlBDKGRldlN0YWNrLCBcIkRldlZQQ1wiLCB7XG4gICAgICAgIGVudmlyb25tZW50OiBcImRldlwiLFxuICAgICAgICBjb25maWc6IGRldkNvbmZpZyxcbiAgICAgICAgZW5hYmxlSW50ZXJmYWNlRW5kcG9pbnRzOiB0cnVlLFxuICAgICAgfSlcblxuICAgICAgbmV3IFNoYXJlZFZQQyhwcm9kU3RhY2ssIFwiUHJvZFZQQ1wiLCB7XG4gICAgICAgIGVudmlyb25tZW50OiBcInByb2RcIixcbiAgICAgICAgY29uZmlnOiBwcm9kQ29uZmlnLFxuICAgICAgICBlbmFibGVJbnRlcmZhY2VFbmRwb2ludHM6IHRydWUsXG4gICAgICB9KVxuXG4gICAgICAvLyBBc3NlcnRcbiAgICAgIGNvbnN0IGRldlRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKGRldlN0YWNrKVxuICAgICAgY29uc3QgcHJvZFRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHByb2RTdGFjaylcblxuICAgICAgY29uc3QgZGV2RW5kcG9pbnRzID0gZGV2VGVtcGxhdGUuZmluZFJlc291cmNlcyhcIkFXUzo6RUMyOjpWUENFbmRwb2ludFwiKVxuICAgICAgY29uc3QgcHJvZEVuZHBvaW50cyA9IHByb2RUZW1wbGF0ZS5maW5kUmVzb3VyY2VzKFwiQVdTOjpFQzI6OlZQQ0VuZHBvaW50XCIpXG5cbiAgICAgIC8vIFByb2Qgc2hvdWxkIGhhdmUgbW9yZSBlbmRwb2ludHMgKGluY2x1ZGVzIFRleHRyYWN0LCBDb21wcmVoZW5kKVxuICAgICAgZXhwZWN0KE9iamVjdC5rZXlzKHByb2RFbmRwb2ludHMpLmxlbmd0aCkudG9CZUdyZWF0ZXJUaGFuKFxuICAgICAgICBPYmplY3Qua2V5cyhkZXZFbmRwb2ludHMpLmxlbmd0aFxuICAgICAgKVxuICAgIH0pXG5cbiAgICB0ZXN0KFwiYmFja3dhcmRzIGNvbXBhdGliaWxpdHk6IGVuYWJsZVZwY0VuZHBvaW50cyBmYWxzZSBkaXNhYmxlcyBhbGxcIiwgKCkgPT4ge1xuICAgICAgLy8gQXJyYW5nZVxuICAgICAgY29uc3QgY29uZmlnID0gRW52aXJvbm1lbnRDb25maWcuZ2V0KFwiZGV2XCIpXG5cbiAgICAgIC8vIEFjdFxuICAgICAgbmV3IFNoYXJlZFZQQyhzdGFjaywgXCJUZXN0VlBDXCIsIHtcbiAgICAgICAgZW52aXJvbm1lbnQ6IFwiZGV2XCIsXG4gICAgICAgIGNvbmZpZyxcbiAgICAgICAgZW5hYmxlVnBjRW5kcG9pbnRzOiBmYWxzZSxcbiAgICAgIH0pXG5cbiAgICAgIC8vIEFzc2VydFxuICAgICAgY29uc3QgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spXG5cbiAgICAgIC8vIFNob3VsZCBoYXZlIG5vIFZQQyBlbmRwb2ludHNcbiAgICAgIGNvbnN0IHZwY0VuZHBvaW50cyA9IHRlbXBsYXRlLmZpbmRSZXNvdXJjZXMoXCJBV1M6OkVDMjo6VlBDRW5kcG9pbnRcIilcbiAgICAgIGV4cGVjdChPYmplY3Qua2V5cyh2cGNFbmRwb2ludHMpLmxlbmd0aCkudG9CZSgwKVxuICAgIH0pXG4gIH0pXG5cbiAgZGVzY3JpYmUoXCJTdWJuZXQgQ29uZmlndXJhdGlvblwiLCAoKSA9PiB7XG4gICAgdGVzdChcInByb3ZpZGVzIGhlbHBlciBtZXRob2QgZm9yIHdvcmtsb2FkLXNwZWNpZmljIHN1Ym5ldHNcIiwgKCkgPT4ge1xuICAgICAgLy8gQXJyYW5nZVxuICAgICAgY29uc3QgY29uZmlnID0gRW52aXJvbm1lbnRDb25maWcuZ2V0KFwiZGV2XCIpXG5cbiAgICAgIC8vIEFjdFxuICAgICAgY29uc3QgdnBjID0gbmV3IFNoYXJlZFZQQyhzdGFjaywgXCJUZXN0VlBDXCIsIHtcbiAgICAgICAgZW52aXJvbm1lbnQ6IFwiZGV2XCIsXG4gICAgICAgIGNvbmZpZyxcbiAgICAgIH0pXG5cbiAgICAgIC8vIEFzc2VydFxuICAgICAgZXhwZWN0KHZwYy5nZXRTdWJuZXRzRm9yV29ya2xvYWQoXCJ3ZWJcIikpLnRvRXF1YWwoe1xuICAgICAgICBzdWJuZXRUeXBlOiBjZGsuYXdzX2VjMi5TdWJuZXRUeXBlLlBVQkxJQyxcbiAgICAgIH0pXG4gICAgICBleHBlY3QodnBjLmdldFN1Ym5ldHNGb3JXb3JrbG9hZChcImFwcFwiKSkudG9FcXVhbCh7XG4gICAgICAgIHN1Ym5ldEdyb3VwTmFtZTogXCJQcml2YXRlLUFwcGxpY2F0aW9uXCIsXG4gICAgICB9KVxuICAgICAgZXhwZWN0KHZwYy5nZXRTdWJuZXRzRm9yV29ya2xvYWQoXCJkYXRhXCIpKS50b0VxdWFsKHtcbiAgICAgICAgc3VibmV0R3JvdXBOYW1lOiBcIlByaXZhdGUtRGF0YVwiLFxuICAgICAgfSlcbiAgICAgIGV4cGVjdCh2cGMuZ2V0U3VibmV0c0Zvcldvcmtsb2FkKFwic2VjdXJlXCIpKS50b0VxdWFsKHtcbiAgICAgICAgc3VibmV0VHlwZTogY2RrLmF3c19lYzIuU3VibmV0VHlwZS5QUklWQVRFX0lTT0xBVEVELFxuICAgICAgfSlcbiAgICB9KVxuXG4gICAgdGVzdChcImNyZWF0ZXMgc3VibmV0cyB3aXRoIHByb3BlciBDSURSIG1hc2tzXCIsICgpID0+IHtcbiAgICAgIC8vIEFycmFuZ2VcbiAgICAgIGNvbnN0IGNvbmZpZyA9IEVudmlyb25tZW50Q29uZmlnLmdldChcImRldlwiKVxuXG4gICAgICAvLyBBY3RcbiAgICAgIG5ldyBTaGFyZWRWUEMoc3RhY2ssIFwiVGVzdFZQQ1wiLCB7XG4gICAgICAgIGVudmlyb25tZW50OiBcImRldlwiLFxuICAgICAgICBjb25maWcsXG4gICAgICB9KVxuXG4gICAgICAvLyBBc3NlcnRcbiAgICAgIGNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKVxuXG4gICAgICAvLyBWZXJpZnkgc3VibmV0cyB3aXRoIGRpZmZlcmVudCBDSURSIG1hc2tzXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoXCJBV1M6OkVDMjo6U3VibmV0XCIsIHtcbiAgICAgICAgQ2lkckJsb2NrOiBNYXRjaC5zdHJpbmdMaWtlUmVnZXhwKFwiLipcXFxcLjAvMjRcIiksIC8vIC8yNCBzdWJuZXRzXG4gICAgICB9KVxuXG4gICAgICAvLyBTaG91bGQgaGF2ZSBsYXJnZXIgc3VibmV0IGZvciBhcHBsaWNhdGlvbnMgKC8yMilcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcyhcIkFXUzo6RUMyOjpTdWJuZXRcIiwge1xuICAgICAgICBDaWRyQmxvY2s6IE1hdGNoLnN0cmluZ0xpa2VSZWdleHAoXCIuKlxcXFwuMC8yMlwiKSxcbiAgICAgIH0pXG4gICAgfSlcbiAgfSlcblxuICBkZXNjcmliZShcIkZsb3cgTG9nc1wiLCAoKSA9PiB7XG4gICAgdGVzdChcImNhbiBkaXNhYmxlIGZsb3cgbG9nc1wiLCAoKSA9PiB7XG4gICAgICAvLyBBcnJhbmdlXG4gICAgICBjb25zdCBjb25maWcgPSBFbnZpcm9ubWVudENvbmZpZy5nZXQoXCJkZXZcIilcblxuICAgICAgLy8gQWN0XG4gICAgICBuZXcgU2hhcmVkVlBDKHN0YWNrLCBcIlRlc3RWUENcIiwge1xuICAgICAgICBlbnZpcm9ubWVudDogXCJkZXZcIixcbiAgICAgICAgY29uZmlnLFxuICAgICAgICBlbmFibGVGbG93TG9nczogZmFsc2UsXG4gICAgICB9KVxuXG4gICAgICAvLyBBc3NlcnRcbiAgICAgIGNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKVxuXG4gICAgICAvLyBTaG91bGQgbm90IGNyZWF0ZSBmbG93IGxvZ3NcbiAgICAgIHRlbXBsYXRlLnJlc291cmNlQ291bnRJcyhcIkFXUzo6RUMyOjpGbG93TG9nXCIsIDApXG4gICAgICB0ZW1wbGF0ZS5yZXNvdXJjZUNvdW50SXMoXG4gICAgICAgIFwiQVdTOjpTMzo6QnVja2V0XCIsXG4gICAgICAgIDAgLy8gTm8gZmxvdyBsb2cgYnVja2V0XG4gICAgICApXG4gICAgfSlcbiAgfSlcblxuICBkZXNjcmliZShcIlRhZ3NcIiwgKCkgPT4ge1xuICAgIHRlc3QoXCJ0YWdzIHN1Ym5ldHMgYXBwcm9wcmlhdGVseVwiLCAoKSA9PiB7XG4gICAgICAvLyBBcnJhbmdlXG4gICAgICBjb25zdCBjb25maWcgPSBFbnZpcm9ubWVudENvbmZpZy5nZXQoXCJkZXZcIilcblxuICAgICAgLy8gQWN0XG4gICAgICBuZXcgU2hhcmVkVlBDKHN0YWNrLCBcIlRlc3RWUENcIiwge1xuICAgICAgICBlbnZpcm9ubWVudDogXCJkZXZcIixcbiAgICAgICAgY29uZmlnLFxuICAgICAgfSlcblxuICAgICAgLy8gQXNzZXJ0XG4gICAgICBjb25zdCB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjaylcblxuICAgICAgLy8gUHVibGljIHN1Ym5ldHMgc2hvdWxkIGhhdmUgRUxCIHRhZ1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2UoXCJBV1M6OkVDMjo6U3VibmV0XCIsIHtcbiAgICAgICAgUHJvcGVydGllczogTWF0Y2gub2JqZWN0TGlrZSh7XG4gICAgICAgICAgVGFnczogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgS2V5OiBcImt1YmVybmV0ZXMuaW8vcm9sZS9lbGJcIixcbiAgICAgICAgICAgICAgVmFsdWU6IFwiMVwiLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICBdKSxcbiAgICAgICAgfSksXG4gICAgICB9KVxuICAgIH0pXG4gIH0pXG5cbiAgZGVzY3JpYmUoXCJDb3N0IE9wdGltaXphdGlvbiAoSXNzdWUgIzYxNylcIiwgKCkgPT4ge1xuICAgIHRlc3QoXCJpbnRlcmZhY2UgZW5kcG9pbnRzIGRpc2FibGVkIGJ5IGRlZmF1bHQgc2F2ZXMgfiQ0MjgvbW9udGhcIiwgKCkgPT4ge1xuICAgICAgLy8gQXJyYW5nZVxuICAgICAgY29uc3QgZGV2Q29uZmlnID0gRW52aXJvbm1lbnRDb25maWcuZ2V0KFwiZGV2XCIpXG4gICAgICBjb25zdCBwcm9kQ29uZmlnID0gRW52aXJvbm1lbnRDb25maWcuZ2V0KFwicHJvZFwiKVxuXG4gICAgICAvLyBBY3QgLSBDcmVhdGUgVlBDcyB3aXRoIGRlZmF1bHQgc2V0dGluZ3NcbiAgICAgIGNvbnN0IGRldlN0YWNrID0gbmV3IGNkay5TdGFjayhhcHAsIFwiQ29zdERldlN0YWNrXCIsIHtcbiAgICAgICAgZW52OiB7IGFjY291bnQ6IFwiMTIzNDU2Nzg5MDEyXCIsIHJlZ2lvbjogXCJ1cy1lYXN0LTFcIiB9LFxuICAgICAgfSlcbiAgICAgIGNvbnN0IHByb2RTdGFjayA9IG5ldyBjZGsuU3RhY2soYXBwLCBcIkNvc3RQcm9kU3RhY2tcIiwge1xuICAgICAgICBlbnY6IHsgYWNjb3VudDogXCIxMjM0NTY3ODkwMTJcIiwgcmVnaW9uOiBcInVzLWVhc3QtMVwiIH0sXG4gICAgICB9KVxuXG4gICAgICBuZXcgU2hhcmVkVlBDKGRldlN0YWNrLCBcIkRldlZQQ1wiLCB7XG4gICAgICAgIGVudmlyb25tZW50OiBcImRldlwiLFxuICAgICAgICBjb25maWc6IGRldkNvbmZpZyxcbiAgICAgIH0pXG5cbiAgICAgIG5ldyBTaGFyZWRWUEMocHJvZFN0YWNrLCBcIlByb2RWUENcIiwge1xuICAgICAgICBlbnZpcm9ubWVudDogXCJwcm9kXCIsXG4gICAgICAgIGNvbmZpZzogcHJvZENvbmZpZyxcbiAgICAgIH0pXG5cbiAgICAgIC8vIEFzc2VydFxuICAgICAgY29uc3QgZGV2VGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soZGV2U3RhY2spXG4gICAgICBjb25zdCBwcm9kVGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2socHJvZFN0YWNrKVxuXG4gICAgICAvLyBCb3RoIHNob3VsZCBvbmx5IGhhdmUgMiBnYXRld2F5IGVuZHBvaW50cyAoUzMsIER5bmFtb0RCKVxuICAgICAgY29uc3QgZGV2RW5kcG9pbnRzID0gZGV2VGVtcGxhdGUuZmluZFJlc291cmNlcyhcIkFXUzo6RUMyOjpWUENFbmRwb2ludFwiKVxuICAgICAgY29uc3QgcHJvZEVuZHBvaW50cyA9IHByb2RUZW1wbGF0ZS5maW5kUmVzb3VyY2VzKFwiQVdTOjpFQzI6OlZQQ0VuZHBvaW50XCIpXG5cbiAgICAgIGV4cGVjdChPYmplY3Qua2V5cyhkZXZFbmRwb2ludHMpLmxlbmd0aCkudG9CZSgyKVxuICAgICAgZXhwZWN0KE9iamVjdC5rZXlzKHByb2RFbmRwb2ludHMpLmxlbmd0aCkudG9CZSgyKVxuXG4gICAgICAvLyBObyBzZWN1cml0eSBncm91cHMgZm9yIGludGVyZmFjZSBlbmRwb2ludHNcbiAgICAgIGNvbnN0IGRldlNHcyA9IGRldlRlbXBsYXRlLmZpbmRSZXNvdXJjZXMoXCJBV1M6OkVDMjo6U2VjdXJpdHlHcm91cFwiKVxuICAgICAgY29uc3Qgc2dDb3VudCA9IE9iamVjdC52YWx1ZXMoZGV2U0dzKS5maWx0ZXIoKHNnOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4ge1xuICAgICAgICBjb25zdCBkZXNjID0gKHNnIGFzIHsgUHJvcGVydGllcz86IHsgR3JvdXBEZXNjcmlwdGlvbj86IHN0cmluZyB9IH0pPy5Qcm9wZXJ0aWVzPy5Hcm91cERlc2NyaXB0aW9uXG4gICAgICAgIHJldHVybiBkZXNjID09PSBcIlNlY3VyaXR5IGdyb3VwIGZvciBWUEMgZW5kcG9pbnRzXCJcbiAgICAgIH0pLmxlbmd0aFxuICAgICAgZXhwZWN0KHNnQ291bnQpLnRvQmUoMClcbiAgICB9KVxuICB9KVxufSlcbiJdfQ==