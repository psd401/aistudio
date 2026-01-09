import * as cdk from "aws-cdk-lib"
import { Template, Match } from "aws-cdk-lib/assertions"
import {
  SharedVPC,
  EnvironmentConfig,
} from "../../lib/constructs"

describe("SharedVPC Construct", () => {
  let app: cdk.App
  let stack: cdk.Stack

  beforeEach(() => {
    app = new cdk.App()
    stack = new cdk.Stack(app, "TestStack", {
      env: { account: "123456789012", region: "us-east-1" },
    })
  })

  describe("Development Environment", () => {
    test("creates VPC with correct subnet configuration", () => {
      // Arrange
      const config = EnvironmentConfig.get("dev")

      // Act
      new SharedVPC(stack, "TestVPC", {
        environment: "dev",
        config,
      })

      // Assert
      const template = Template.fromStack(stack)

      // Verify VPC creation
      template.hasResourceProperties("AWS::EC2::VPC", {
        EnableDnsHostnames: true,
        EnableDnsSupport: true,
      })

      // Verify multiple subnets exist (public, private app, private data, isolated)
      const subnets = template.findResources("AWS::EC2::Subnet")
      expect(Object.keys(subnets).length).toBeGreaterThan(4)
    })

    test("uses NAT gateways for all environments", () => {
      // Arrange
      const config = EnvironmentConfig.get("dev")

      // Act
      new SharedVPC(stack, "TestVPC", {
        environment: "dev",
        config,
      })

      // Assert
      const template = Template.fromStack(stack)

      // All environments now use NAT gateways (Issue #617 removed NAT instances)
      template.hasResourceProperties("AWS::EC2::NatGateway", {
        AllocationId: Match.anyValue(),
      })
    })

    test("creates only gateway endpoints by default (cost optimization)", () => {
      // Arrange
      const config = EnvironmentConfig.get("dev")

      // Act
      new SharedVPC(stack, "TestVPC", {
        environment: "dev",
        config,
      })

      // Assert
      const template = Template.fromStack(stack)

      // Gateway endpoints (S3, DynamoDB) - FREE
      template.hasResourceProperties("AWS::EC2::VPCEndpoint", {
        ServiceName: Match.objectLike({
          "Fn::Join": Match.arrayWith([
            Match.arrayWith([Match.stringLikeRegexp(".*s3.*")]),
          ]),
        }),
      })

      // Only gateway endpoints should exist (S3 + DynamoDB = 2)
      // Interface endpoints are disabled by default for cost optimization (Issue #617)
      const vpcEndpoints = template.findResources("AWS::EC2::VPCEndpoint")
      expect(Object.keys(vpcEndpoints).length).toBe(2)
    })

    test("enables VPC flow logs to S3", () => {
      // Arrange
      const config = EnvironmentConfig.get("dev")

      // Act
      new SharedVPC(stack, "TestVPC", {
        environment: "dev",
        config,
        enableFlowLogs: true,
      })

      // Assert
      const template = Template.fromStack(stack)

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
      })

      // Flow log resource
      template.hasResourceProperties("AWS::EC2::FlowLog", {
        ResourceType: "VPC",
        TrafficType: "ALL",
        MaxAggregationInterval: 600, // 10 minutes
      })
    })
  })

  describe("Production Environment", () => {
    test("uses NAT gateways for reliability", () => {
      // Arrange
      const config = EnvironmentConfig.get("prod")

      // Act
      new SharedVPC(stack, "TestVPC", {
        environment: "prod",
        config,
      })

      // Assert
      const template = Template.fromStack(stack)

      // Prod should use NAT Gateways (more reliable)
      template.hasResourceProperties("AWS::EC2::NatGateway", {
        AllocationId: Match.anyValue(),
      })
    })

    test("creates only gateway endpoints by default (cost optimization)", () => {
      // Arrange
      const config = EnvironmentConfig.get("prod")

      // Act
      new SharedVPC(stack, "TestVPC", {
        environment: "prod",
        config,
      })

      // Assert
      const template = Template.fromStack(stack)

      // Only gateway endpoints by default (Issue #617 - interface endpoints disabled)
      const vpcEndpoints = template.findResources("AWS::EC2::VPCEndpoint")
      expect(Object.keys(vpcEndpoints).length).toBe(2) // S3 + DynamoDB
    })

    test("enables CloudWatch Logs for rejected traffic", () => {
      // Arrange
      const config = EnvironmentConfig.get("prod")

      // Act
      new SharedVPC(stack, "TestVPC", {
        environment: "prod",
        config,
        enableFlowLogs: true,
      })

      // Assert
      const template = Template.fromStack(stack)

      // Log group for flow logs
      template.hasResourceProperties("AWS::Logs::LogGroup", {
        LogGroupName: "/aws/vpc/flowlogs/prod",
        RetentionInDays: 7,
      })

      // Should have both S3 and CloudWatch flow logs
      const flowLogs = template.findResources("AWS::EC2::FlowLog")
      expect(Object.keys(flowLogs).length).toBe(2)
    })

    test("configures proper lifecycle for flow log storage", () => {
      // Arrange
      const config = EnvironmentConfig.get("prod")

      // Act
      new SharedVPC(stack, "TestVPC", {
        environment: "prod",
        config,
        enableFlowLogs: true,
      })

      // Assert
      const template = Template.fromStack(stack)

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
      })
    })
  })

  describe("VPC Endpoints Configuration", () => {
    test("disables all endpoints when enableGatewayEndpoints is false", () => {
      // Arrange
      const config = EnvironmentConfig.get("dev")

      // Act
      new SharedVPC(stack, "TestVPC", {
        environment: "dev",
        config,
        enableGatewayEndpoints: false,
      })

      // Assert
      const template = Template.fromStack(stack)

      // Should have no VPC endpoints
      const vpcEndpoints = template.findResources("AWS::EC2::VPCEndpoint")
      expect(Object.keys(vpcEndpoints).length).toBe(0)
    })

    test("creates interface endpoints when explicitly enabled", () => {
      // Arrange
      const config = EnvironmentConfig.get("dev")

      // Act
      new SharedVPC(stack, "TestVPC", {
        environment: "dev",
        config,
        enableInterfaceEndpoints: true,
      })

      // Assert
      const template = Template.fromStack(stack)

      // Should have gateway + interface endpoints
      const vpcEndpoints = template.findResources("AWS::EC2::VPCEndpoint")
      expect(Object.keys(vpcEndpoints).length).toBeGreaterThan(10)

      // Security group for interface endpoints
      template.hasResourceProperties("AWS::EC2::SecurityGroup", {
        GroupDescription: "Security group for VPC endpoints",
        SecurityGroupIngress: [
          {
            CidrIp: Match.anyValue(),
            IpProtocol: "tcp",
            FromPort: 443,
            ToPort: 443,
          },
        ],
      })
    })

    test("production gets additional interface endpoints when enabled", () => {
      // Arrange
      const devConfig = EnvironmentConfig.get("dev")
      const prodConfig = EnvironmentConfig.get("prod")

      // Act
      const devStack = new cdk.Stack(app, "DevStack", {
        env: { account: "123456789012", region: "us-east-1" },
      })
      const prodStack = new cdk.Stack(app, "ProdStack", {
        env: { account: "123456789012", region: "us-east-1" },
      })

      new SharedVPC(devStack, "DevVPC", {
        environment: "dev",
        config: devConfig,
        enableInterfaceEndpoints: true,
      })

      new SharedVPC(prodStack, "ProdVPC", {
        environment: "prod",
        config: prodConfig,
        enableInterfaceEndpoints: true,
      })

      // Assert
      const devTemplate = Template.fromStack(devStack)
      const prodTemplate = Template.fromStack(prodStack)

      const devEndpoints = devTemplate.findResources("AWS::EC2::VPCEndpoint")
      const prodEndpoints = prodTemplate.findResources("AWS::EC2::VPCEndpoint")

      // Prod should have more endpoints (includes Textract, Comprehend)
      expect(Object.keys(prodEndpoints).length).toBeGreaterThan(
        Object.keys(devEndpoints).length
      )
    })

    test("backwards compatibility: enableVpcEndpoints false disables all", () => {
      // Arrange
      const config = EnvironmentConfig.get("dev")

      // Act
      new SharedVPC(stack, "TestVPC", {
        environment: "dev",
        config,
        enableVpcEndpoints: false,
      })

      // Assert
      const template = Template.fromStack(stack)

      // Should have no VPC endpoints
      const vpcEndpoints = template.findResources("AWS::EC2::VPCEndpoint")
      expect(Object.keys(vpcEndpoints).length).toBe(0)
    })
  })

  describe("Subnet Configuration", () => {
    test("provides helper method for workload-specific subnets", () => {
      // Arrange
      const config = EnvironmentConfig.get("dev")

      // Act
      const vpc = new SharedVPC(stack, "TestVPC", {
        environment: "dev",
        config,
      })

      // Assert
      expect(vpc.getSubnetsForWorkload("web")).toEqual({
        subnetType: cdk.aws_ec2.SubnetType.PUBLIC,
      })
      expect(vpc.getSubnetsForWorkload("app")).toEqual({
        subnetGroupName: "Private-Application",
      })
      expect(vpc.getSubnetsForWorkload("data")).toEqual({
        subnetGroupName: "Private-Data",
      })
      expect(vpc.getSubnetsForWorkload("secure")).toEqual({
        subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED,
      })
    })

    test("creates subnets with proper CIDR masks", () => {
      // Arrange
      const config = EnvironmentConfig.get("dev")

      // Act
      new SharedVPC(stack, "TestVPC", {
        environment: "dev",
        config,
      })

      // Assert
      const template = Template.fromStack(stack)

      // Verify subnets with different CIDR masks
      template.hasResourceProperties("AWS::EC2::Subnet", {
        CidrBlock: Match.stringLikeRegexp(".*\\.0/24"), // /24 subnets
      })

      // Should have larger subnet for applications (/22)
      template.hasResourceProperties("AWS::EC2::Subnet", {
        CidrBlock: Match.stringLikeRegexp(".*\\.0/22"),
      })
    })
  })

  describe("Flow Logs", () => {
    test("can disable flow logs", () => {
      // Arrange
      const config = EnvironmentConfig.get("dev")

      // Act
      new SharedVPC(stack, "TestVPC", {
        environment: "dev",
        config,
        enableFlowLogs: false,
      })

      // Assert
      const template = Template.fromStack(stack)

      // Should not create flow logs
      template.resourceCountIs("AWS::EC2::FlowLog", 0)
      template.resourceCountIs(
        "AWS::S3::Bucket",
        0 // No flow log bucket
      )
    })
  })

  describe("Tags", () => {
    test("tags subnets appropriately", () => {
      // Arrange
      const config = EnvironmentConfig.get("dev")

      // Act
      new SharedVPC(stack, "TestVPC", {
        environment: "dev",
        config,
      })

      // Assert
      const template = Template.fromStack(stack)

      // Public subnets should have ELB tag
      template.hasResource("AWS::EC2::Subnet", {
        Properties: Match.objectLike({
          Tags: Match.arrayWith([
            {
              Key: "kubernetes.io/role/elb",
              Value: "1",
            },
          ]),
        }),
      })
    })
  })

  describe("Cost Optimization (Issue #617)", () => {
    test("interface endpoints disabled by default saves ~$428/month", () => {
      // Arrange
      const devConfig = EnvironmentConfig.get("dev")
      const prodConfig = EnvironmentConfig.get("prod")

      // Act - Create VPCs with default settings
      const devStack = new cdk.Stack(app, "CostDevStack", {
        env: { account: "123456789012", region: "us-east-1" },
      })
      const prodStack = new cdk.Stack(app, "CostProdStack", {
        env: { account: "123456789012", region: "us-east-1" },
      })

      new SharedVPC(devStack, "DevVPC", {
        environment: "dev",
        config: devConfig,
      })

      new SharedVPC(prodStack, "ProdVPC", {
        environment: "prod",
        config: prodConfig,
      })

      // Assert
      const devTemplate = Template.fromStack(devStack)
      const prodTemplate = Template.fromStack(prodStack)

      // Both should only have 2 gateway endpoints (S3, DynamoDB)
      const devEndpoints = devTemplate.findResources("AWS::EC2::VPCEndpoint")
      const prodEndpoints = prodTemplate.findResources("AWS::EC2::VPCEndpoint")

      expect(Object.keys(devEndpoints).length).toBe(2)
      expect(Object.keys(prodEndpoints).length).toBe(2)

      // No security groups for interface endpoints
      const devSGs = devTemplate.findResources("AWS::EC2::SecurityGroup")
      const sgCount = Object.values(devSGs).filter((sg: Record<string, unknown>) => {
        const desc = (sg as { Properties?: { GroupDescription?: string } })?.Properties?.GroupDescription
        return desc === "Security group for VPC endpoints"
      }).length
      expect(sgCount).toBe(0)
    })
  })
})
