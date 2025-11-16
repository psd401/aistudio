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

    test("uses NAT instances for cost optimization", () => {
      // Arrange
      const config = EnvironmentConfig.get("dev")

      // Act
      new SharedVPC(stack, "TestVPC", {
        environment: "dev",
        config,
      })

      // Assert
      const template = Template.fromStack(stack)

      // Dev should use EC2 instances for NAT (cheaper)
      template.hasResourceProperties("AWS::EC2::Instance", {
        InstanceType: "t3.nano",
      })
    })

    test("creates essential VPC endpoints", () => {
      // Arrange
      const config = EnvironmentConfig.get("dev")

      // Act
      new SharedVPC(stack, "TestVPC", {
        environment: "dev",
        config,
      })

      // Assert
      const template = Template.fromStack(stack)

      // Gateway endpoints (S3, DynamoDB) - no cost
      template.hasResourceProperties("AWS::EC2::VPCEndpoint", {
        ServiceName: Match.objectLike({
          "Fn::Join": Match.arrayWith([
            Match.arrayWith([Match.stringLikeRegexp(".*s3.*")]),
          ]),
        }),
      })

      // Interface endpoints should exist
      const vpcEndpoints = template.findResources("AWS::EC2::VPCEndpoint")
      expect(Object.keys(vpcEndpoints).length).toBeGreaterThan(5)
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

    test("creates CloudWatch dashboard", () => {
      // Arrange
      const config = EnvironmentConfig.get("dev")

      // Act
      new SharedVPC(stack, "TestVPC", {
        environment: "dev",
        config,
      })

      // Assert
      const template = Template.fromStack(stack)

      // CloudWatch dashboard
      template.hasResourceProperties("AWS::CloudWatch::Dashboard", {
        DashboardName: "dev-vpc-metrics",
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

    test("creates additional VPC endpoints for production", () => {
      // Arrange
      const config = EnvironmentConfig.get("prod")

      // Act
      new SharedVPC(stack, "TestVPC", {
        environment: "prod",
        config,
      })

      // Assert
      const template = Template.fromStack(stack)

      // Should have more VPC endpoints than dev (including Textract, Comprehend)
      const vpcEndpoints = template.findResources("AWS::EC2::VPCEndpoint")
      expect(Object.keys(vpcEndpoints).length).toBeGreaterThan(10)
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
    test("can disable VPC endpoints", () => {
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

      // Should only have gateway endpoints (S3, DynamoDB)
      const vpcEndpoints = template.findResources("AWS::EC2::VPCEndpoint")
      expect(Object.keys(vpcEndpoints).length).toBeLessThan(5)
    })

    test("creates security group for VPC endpoints", () => {
      // Arrange
      const config = EnvironmentConfig.get("dev")

      // Act
      new SharedVPC(stack, "TestVPC", {
        environment: "dev",
        config,
      })

      // Assert
      const template = Template.fromStack(stack)

      // Security group for endpoints
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
})
