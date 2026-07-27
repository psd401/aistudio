import * as cdk from "aws-cdk-lib"
import { Template, Match } from "aws-cdk-lib/assertions"
import { TaggingAspect, TaggingConfig } from "../../lib/constructs/base/tagging-aspect"

interface SynthesizedTag {
  Key: string
  Value: string
}

interface TaggedResource {
  Properties: { Tags: SynthesizedTag[] }
}

describe("TaggingAspect", () => {
  let app: cdk.App
  let stack: cdk.Stack

  beforeEach(() => {
    app = new cdk.App()
    stack = new cdk.Stack(app, "TestStack")
  })


    test("should apply all core tags to taggable resources", () => {
      const config: TaggingConfig = {
        environment: "dev",
        projectName: "AIStudio",
        owner: "TSD Engineering",
        stackName: "TestStack",
      }

      const aspect = new TaggingAspect(config)
      cdk.Aspects.of(stack).add(aspect)

      // Create a taggable resource
      new cdk.aws_s3.Bucket(stack, "TestBucket")

      const template = Template.fromStack(stack)

      template.hasResourceProperties("AWS::S3::Bucket", {
        Tags: Match.arrayWith([
          { Key: "BusinessUnit", Value: "Technology" },
          { Key: "Compliance", Value: "None" },
          { Key: "CostCenter", Value: "DEV-001" },
          { Key: "DataClassification", Value: "Public" },
          { Key: "Environment", Value: "Dev" },
          { Key: "ManagedBy", Value: "CDK" },
          { Key: "Owner", Value: "TSD Engineering" },
          { Key: "Project", Value: "AIStudio" },
          { Key: "Stack", Value: "TestStack" },
        ]),
      })

      // Also verify DeployedAt exists (value is dynamic)
      const resources = template.findResources("AWS::S3::Bucket")
      const bucket = Object.values(resources)[0] as TaggedResource
      const deployedAtTag = bucket.Properties.Tags.find(
        (tag) => tag.Key === "DeployedAt"
      )
      expect(deployedAtTag).toBeDefined()
      expect(deployedAtTag?.Value).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    test("should capitalize environment name", () => {
      const config: TaggingConfig = {
        environment: "prod",
        projectName: "AIStudio",
        owner: "TSD Engineering",
        stackName: "TestStack",
      }

      const aspect = new TaggingAspect(config)
      cdk.Aspects.of(stack).add(aspect)

      new cdk.aws_s3.Bucket(stack, "TestBucket")

      const template = Template.fromStack(stack)

      template.hasResourceProperties("AWS::S3::Bucket", {
        Tags: Match.arrayWith([
          { Key: "Environment", Value: "Prod" },
        ]),
      })
    })

    test("should handle staging environment", () => {
      const config: TaggingConfig = {
        environment: "staging",
        projectName: "AIStudio",
        owner: "TSD Engineering",
        stackName: "TestStack",
      }

      const aspect = new TaggingAspect(config)
      cdk.Aspects.of(stack).add(aspect)

      new cdk.aws_s3.Bucket(stack, "TestBucket")

      const template = Template.fromStack(stack)

      template.hasResourceProperties("AWS::S3::Bucket", {
        Tags: Match.arrayWith([
          { Key: "Environment", Value: "Staging" },
        ]),
      })
    })



    test("should set cost center to PROD-001 for production", () => {
      const config: TaggingConfig = {
        environment: "prod",
        projectName: "AIStudio",
        owner: "TSD Engineering",
        stackName: "TestStack",
      }

      const aspect = new TaggingAspect(config)
      cdk.Aspects.of(stack).add(aspect)

      new cdk.aws_s3.Bucket(stack, "TestBucket")

      const template = Template.fromStack(stack)

      template.hasResourceProperties("AWS::S3::Bucket", {
        Tags: Match.arrayWith([
          { Key: "CostCenter", Value: "PROD-001" },
        ]),
      })
    })

    test("should set cost center to DEV-001 for non-production", () => {
      const config: TaggingConfig = {
        environment: "dev",
        projectName: "AIStudio",
        owner: "TSD Engineering",
        stackName: "TestStack",
      }

      const aspect = new TaggingAspect(config)
      cdk.Aspects.of(stack).add(aspect)

      new cdk.aws_s3.Bucket(stack, "TestBucket")

      const template = Template.fromStack(stack)

      template.hasResourceProperties("AWS::S3::Bucket", {
        Tags: Match.arrayWith([
          { Key: "CostCenter", Value: "DEV-001" },
        ]),
      })
    })

    test("should always set BusinessUnit to Technology", () => {
      const config: TaggingConfig = {
        environment: "prod",
        projectName: "AIStudio",
        owner: "TSD Engineering",
        stackName: "TestStack",
      }

      const aspect = new TaggingAspect(config)
      cdk.Aspects.of(stack).add(aspect)

      new cdk.aws_s3.Bucket(stack, "TestBucket")

      const template = Template.fromStack(stack)

      template.hasResourceProperties("AWS::S3::Bucket", {
        Tags: Match.arrayWith([
          { Key: "BusinessUnit", Value: "Technology" },
        ]),
      })
    })



    test("should set compliance to Required for production", () => {
      const config: TaggingConfig = {
        environment: "prod",
        projectName: "AIStudio",
        owner: "TSD Engineering",
        stackName: "TestStack",
      }

      const aspect = new TaggingAspect(config)
      cdk.Aspects.of(stack).add(aspect)

      new cdk.aws_s3.Bucket(stack, "TestBucket")

      const template = Template.fromStack(stack)

      template.hasResourceProperties("AWS::S3::Bucket", {
        Tags: Match.arrayWith([
          { Key: "Compliance", Value: "Required" },
        ]),
      })
    })

    test("should set compliance to None for non-production", () => {
      const config: TaggingConfig = {
        environment: "dev",
        projectName: "AIStudio",
        owner: "TSD Engineering",
        stackName: "TestStack",
      }

      const aspect = new TaggingAspect(config)
      cdk.Aspects.of(stack).add(aspect)

      new cdk.aws_s3.Bucket(stack, "TestBucket")

      const template = Template.fromStack(stack)

      template.hasResourceProperties("AWS::S3::Bucket", {
        Tags: Match.arrayWith([
          { Key: "Compliance", Value: "None" },
        ]),
      })
    })



    test("should classify database resources as Sensitive", () => {
      const config: TaggingConfig = {
        environment: "prod",
        projectName: "AIStudio",
        owner: "TSD Engineering",
        stackName: "TestStack",
      }

      const aspect = new TaggingAspect(config)
      cdk.Aspects.of(stack).add(aspect)

      // Create a database cluster (has "Database" in constructor name)
      new cdk.aws_rds.DatabaseCluster(stack, "TestDatabase", {
        engine: cdk.aws_rds.DatabaseClusterEngine.auroraPostgres({
          version: cdk.aws_rds.AuroraPostgresEngineVersion.VER_16_8,
        }),
        writer: cdk.aws_rds.ClusterInstance.serverlessV2("writer"),
        vpc: new cdk.aws_ec2.Vpc(stack, "TestVpc"),
      })

      const template = Template.fromStack(stack)

      template.hasResourceProperties("AWS::RDS::DBCluster", {
        Tags: Match.arrayWith([
          { Key: "DataClassification", Value: "Sensitive" },
        ]),
      })
    })

    test("should classify secrets as Sensitive", () => {
      const config: TaggingConfig = {
        environment: "prod",
        projectName: "AIStudio",
        owner: "TSD Engineering",
        stackName: "TestStack",
      }

      const aspect = new TaggingAspect(config)
      cdk.Aspects.of(stack).add(aspect)

      new cdk.aws_secretsmanager.Secret(stack, "TestSecret")

      const template = Template.fromStack(stack)

      template.hasResourceProperties("AWS::SecretsManager::Secret", {
        Tags: Match.arrayWith([
          { Key: "DataClassification", Value: "Sensitive" },
        ]),
      })
    })

    test("should classify log groups as Internal", () => {
      const config: TaggingConfig = {
        environment: "prod",
        projectName: "AIStudio",
        owner: "TSD Engineering",
        stackName: "TestStack",
      }

      const aspect = new TaggingAspect(config)
      cdk.Aspects.of(stack).add(aspect)

      new cdk.aws_logs.LogGroup(stack, "TestLogGroup")

      const template = Template.fromStack(stack)

      template.hasResourceProperties("AWS::Logs::LogGroup", {
        Tags: Match.arrayWith([
          { Key: "DataClassification", Value: "Internal" },
        ]),
      })
    })

    test("should classify S3 buckets as Public by default", () => {
      const config: TaggingConfig = {
        environment: "prod",
        projectName: "AIStudio",
        owner: "TSD Engineering",
        stackName: "TestStack",
      }

      const aspect = new TaggingAspect(config)
      cdk.Aspects.of(stack).add(aspect)

      new cdk.aws_s3.Bucket(stack, "TestBucket")

      const template = Template.fromStack(stack)

      template.hasResourceProperties("AWS::S3::Bucket", {
        Tags: Match.arrayWith([
          { Key: "DataClassification", Value: "Public" },
        ]),
      })
    })



    test("should apply additional custom tags", () => {
      const config: TaggingConfig = {
        environment: "prod",
        projectName: "AIStudio",
        owner: "TSD Engineering",
        stackName: "TestStack",
        additionalTags: {
          Team: "Platform",
          Application: "WebApp",
        },
      }

      const aspect = new TaggingAspect(config)
      cdk.Aspects.of(stack).add(aspect)

      new cdk.aws_s3.Bucket(stack, "TestBucket")

      const template = Template.fromStack(stack)

      template.hasResourceProperties("AWS::S3::Bucket", {
        Tags: Match.arrayWith([{ Key: "Team", Value: "Platform" }]),
      })
      template.hasResourceProperties("AWS::S3::Bucket", {
        Tags: Match.arrayWith([{ Key: "Application", Value: "WebApp" }]),
      })
    })

    test("should work without additional tags", () => {
      const config: TaggingConfig = {
        environment: "prod",
        projectName: "AIStudio",
        owner: "TSD Engineering",
        stackName: "TestStack",
      }

      const aspect = new TaggingAspect(config)
      cdk.Aspects.of(stack).add(aspect)

      new cdk.aws_s3.Bucket(stack, "TestBucket")

      const template = Template.fromStack(stack)

      // Should still have core tags
      template.hasResourceProperties("AWS::S3::Bucket", {
        Tags: Match.arrayWith([
          { Key: "Environment", Value: "Prod" },
          { Key: "Project", Value: "AIStudio" },
        ]),
      })
    })



    test("should not fail on non-taggable resources", () => {
      const config: TaggingConfig = {
        environment: "prod",
        projectName: "AIStudio",
        owner: "TSD Engineering",
        stackName: "TestStack",
      }

      const aspect = new TaggingAspect(config)
      cdk.Aspects.of(stack).add(aspect)

      // CloudFormation output is not taggable
      new cdk.CfnOutput(stack, "TestOutput", {
        value: "test-value",
      })

      // Should not throw an error
      expect(() => Template.fromStack(stack)).not.toThrow()
    })



    test("should always set ManagedBy to CDK", () => {
      const config: TaggingConfig = {
        environment: "dev",
        projectName: "AIStudio",
        owner: "TSD Engineering",
        stackName: "TestStack",
      }

      const aspect = new TaggingAspect(config)
      cdk.Aspects.of(stack).add(aspect)

      new cdk.aws_s3.Bucket(stack, "TestBucket")

      const template = Template.fromStack(stack)

      template.hasResourceProperties("AWS::S3::Bucket", {
        Tags: Match.arrayWith([
          { Key: "ManagedBy", Value: "CDK" },
        ]),
      })
    })



    test("should set DeployedAt to valid ISO timestamp", () => {
      const config: TaggingConfig = {
        environment: "dev",
        projectName: "AIStudio",
        owner: "TSD Engineering",
        stackName: "TestStack",
      }

      const aspect = new TaggingAspect(config)
      cdk.Aspects.of(stack).add(aspect)

      new cdk.aws_s3.Bucket(stack, "TestBucket")

      const template = Template.fromStack(stack)
      const bucketResource = template.findResources("AWS::S3::Bucket")
      const bucket = Object.values(bucketResource)[0] as TaggedResource
      const deployedAtTag = bucket.Properties.Tags.find(
        (tag) => tag.Key === "DeployedAt"
      )

      expect(deployedAtTag).toBeDefined()
      expect(deployedAtTag?.Value).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

})
