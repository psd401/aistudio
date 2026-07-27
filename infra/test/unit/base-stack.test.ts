import * as cdk from "aws-cdk-lib"
import { Template, Match } from "aws-cdk-lib/assertions"
import { BaseStack, BaseStackProps } from "../../lib/constructs/base/base-stack"
import { EnvironmentConfig } from "../../lib/constructs/config/environment-config"

// Test implementation of BaseStack
class TestStack extends BaseStack {
  public envValueForTest<T>(devValue: T, prodValue: T): T {
    return this.getEnvValue(devValue, prodValue)
  }

  protected defineResources(_props: BaseStackProps): void {
    // Create a simple S3 bucket for testing
    new cdk.aws_s3.Bucket(this, "TestBucket", {
      removalPolicy: this.getRemovalPolicy(),
    })

    // Create an SSM parameter using helper
    this.createParameter("test-value", "test-123", "Test parameter")
  }
}

let app: cdk.App
const testEnv = {
    account: "123456789012",
    region: "us-east-1",
  }

function defineBaseStackSuite1Part1() {


  // Standard test environment for CDK stacks


  beforeEach(() => {
    app = new cdk.App()
  })

  describe("Stack Naming and Configuration", () => {
    test("should create stack with correct naming convention", () => {
      const stack = new TestStack(app, "TestStack-Dev", {
        deploymentEnvironment: "dev",
        config: EnvironmentConfig.get("dev"),
        env: {
          account: "123456789012",
          region: "us-east-1",
        },
      })

      expect(stack.stackName).toBe("AIStudio-TestStack-Dev-dev")
    })

    test("should use custom project name in stack name", () => {
      const stack = new TestStack(app, "TestStack-Dev", {
        deploymentEnvironment: "dev",
        config: EnvironmentConfig.get("dev"),
        projectName: "CustomProject",
        env: {
          account: "123456789012",
          region: "us-east-1",
        },
      })

      expect(stack.stackName).toBe("CustomProject-TestStack-Dev-dev")
    })

    test("should set description based on environment", () => {
      const stack = new TestStack(app, "TestStack-Dev", {
        deploymentEnvironment: "dev",
        config: EnvironmentConfig.get("dev"),
        env: testEnv,
      })

      const template = Template.fromStack(stack)
      expect(template.toJSON().Description).toBe("TestStack-Dev for dev environment")
    })
  })

  describe("Termination Protection", () => {
    test("should enable termination protection for prod", () => {
      const stack = new TestStack(app, "TestStack-Prod", {
        deploymentEnvironment: "prod",
        config: EnvironmentConfig.get("prod"),
        env: testEnv,
      })

      expect(stack.terminationProtection).toBe(true)
    })

    test("should disable termination protection for dev", () => {
      const stack = new TestStack(app, "TestStack-Dev", {
        deploymentEnvironment: "dev",
        config: EnvironmentConfig.get("dev"),
        env: testEnv,
      })

      expect(stack.terminationProtection).toBe(false)
    })

    test("should disable termination protection for staging", () => {
      const stack = new TestStack(app, "TestStack-Staging", {
        deploymentEnvironment: "staging",
        config: EnvironmentConfig.get("staging"),
        env: testEnv,
      })

      expect(stack.terminationProtection).toBe(false)
    })
  })

  }

function defineBaseStackSuite1Part2() {describe("Automatic Tagging", () => {
    test("should apply all standard tags to resources", () => {
      const stack = new TestStack(app, "TestStack-Dev", {
        deploymentEnvironment: "dev",
        config: EnvironmentConfig.get("dev"),
        env: testEnv,
      })

      const template = Template.fromStack(stack)

      // Check that bucket has tags (TaggingAspect should apply them)
      template.hasResourceProperties("AWS::S3::Bucket", {
        Tags: Match.arrayWith([{ Key: "Environment", Value: "Dev" }]),
      })
      template.hasResourceProperties("AWS::S3::Bucket", {
        Tags: Match.arrayWith([{ Key: "Project", Value: "AIStudio" }]),
      })
      template.hasResourceProperties("AWS::S3::Bucket", {
        Tags: Match.arrayWith([{ Key: "Owner", Value: "TSD Engineering" }]),
      })
      template.hasResourceProperties("AWS::S3::Bucket", {
        Tags: Match.arrayWith([{ Key: "ManagedBy", Value: "CDK" }]),
      })
    })

    test("should capitalize environment in tags", () => {
      const stack = new TestStack(app, "TestStack-Prod", {
        deploymentEnvironment: "prod",
        config: EnvironmentConfig.get("prod"),
        env: testEnv,
      })

      const template = Template.fromStack(stack)

      template.hasResourceProperties("AWS::S3::Bucket", {
        Tags: Match.arrayWith([
          { Key: "Environment", Value: "Prod" },
        ]),
      })
    })

    test("should apply custom project name to tags", () => {
      const stack = new TestStack(app, "TestStack-Dev", {
        deploymentEnvironment: "dev",
        config: EnvironmentConfig.get("dev"),
        projectName: "CustomProject",
        env: testEnv,
      })

      const template = Template.fromStack(stack)

      template.hasResourceProperties("AWS::S3::Bucket", {
        Tags: Match.arrayWith([
          { Key: "Project", Value: "CustomProject" },
        ]),
      })
    })

    test("should apply custom owner to tags", () => {
      const stack = new TestStack(app, "TestStack-Dev", {
        deploymentEnvironment: "dev",
        config: EnvironmentConfig.get("dev"),
        owner: "Custom Team",
        env: testEnv,
      })

      const template = Template.fromStack(stack)

      template.hasResourceProperties("AWS::S3::Bucket", {
        Tags: Match.arrayWith([
          { Key: "Owner", Value: "Custom Team" },
        ]),
      })
    })
  })

  describe("Standard Outputs", () => {
    test("should create StackEnvironment output", () => {
      const stack = new TestStack(app, "TestStack-Dev", {
        deploymentEnvironment: "dev",
        config: EnvironmentConfig.get("dev"),
        env: testEnv,
      })

      const template = Template.fromStack(stack)

      template.hasOutput("StackEnvironment", {
        Value: "dev",
        Description: "Environment for this stack",
        Export: {
          Name: "AIStudio-TestStack-Dev-dev-Environment",
        },
      })
    })

    test("should create StackVersion output", () => {
      const stack = new TestStack(app, "TestStack-Dev", {
        deploymentEnvironment: "dev",
        config: EnvironmentConfig.get("dev"),
        env: testEnv,
      })

      const template = Template.fromStack(stack)

      template.hasOutput("StackVersion", {
        Description: "CDK version used for deployment",
      })
    })
  })

  }

function defineBaseStackSuite1Part3() {describe("Helper Methods", () => {
    test("getRemovalPolicy should return RETAIN for prod", () => {
      const stack = new TestStack(app, "TestStack-Prod", {
        deploymentEnvironment: "prod",
        config: EnvironmentConfig.get("prod"),
        env: {
          account: "123456789012",
          region: "us-east-1",
        },
      })

      const template = Template.fromStack(stack)

      // Bucket should have DeletionPolicy: Retain
      template.hasResource("AWS::S3::Bucket", {
        DeletionPolicy: "Retain",
      })
    })

    test("getRemovalPolicy should return DESTROY for dev", () => {
      const stack = new TestStack(app, "TestStack-Dev", {
        deploymentEnvironment: "dev",
        config: EnvironmentConfig.get("dev"),
        env: {
          account: "123456789012",
          region: "us-east-1",
        },
      })

      const template = Template.fromStack(stack)

      // Bucket should have DeletionPolicy: Delete
      template.hasResource("AWS::S3::Bucket", {
        DeletionPolicy: "Delete",
      })
    })

    test("getEnvValue should return dev value for dev environment", () => {
      const stack = new TestStack(app, "TestStack-Dev", {
        deploymentEnvironment: "dev",
        config: EnvironmentConfig.get("dev"),
        env: testEnv,
      })

      // Access the protected method through a type assertion
      const result = stack.envValueForTest("dev-value", "prod-value")
      expect(result).toBe("dev-value")
    })

    test("getEnvValue should return prod value for prod environment", () => {
      const stack = new TestStack(app, "TestStack-Prod", {
        deploymentEnvironment: "prod",
        config: EnvironmentConfig.get("prod"),
        env: testEnv,
      })

      const result = stack.envValueForTest("dev-value", "prod-value")
      expect(result).toBe("prod-value")
    })

    test("createParameter should create SSM parameter with correct naming", () => {
      const stack = new TestStack(app, "TestStack-Dev", {
        deploymentEnvironment: "dev",
        config: EnvironmentConfig.get("dev"),
        env: {
          account: "123456789012",
          region: "us-east-1",
        },
      })

      const template = Template.fromStack(stack)

      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/aistudio/dev/test-value",
        Value: "test-123",
        Description: "Test parameter",
        Type: "String",
      })
    })

    test("createParameter should respect custom project name", () => {
      const stack = new TestStack(app, "TestStack-Dev", {
        deploymentEnvironment: "dev",
        config: EnvironmentConfig.get("dev"),
        projectName: "CustomProject",
        env: {
          account: "123456789012",
          region: "us-east-1",
        },
      })

      const template = Template.fromStack(stack)

      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/customproject/dev/test-value",
        Value: "test-123",
      })
    })
  })

  }

function defineBaseStackSuite1Part4() {describe("Configuration Access", () => {
    test("should provide access to environment configuration", () => {
      const stack = new TestStack(app, "TestStack-Dev", {
        deploymentEnvironment: "dev",
        config: EnvironmentConfig.get("dev"),
        env: testEnv,
      })

      expect(stack.config.database.minCapacity).toBe(0.5)
      expect(stack.config.compute.lambdaMemory).toBe(1024)
      expect(stack.config.costOptimization).toBe(true)
    })

    test("should provide access to deployment environment string", () => {
      const stack = new TestStack(app, "TestStack-Prod", {
        deploymentEnvironment: "prod",
        config: EnvironmentConfig.get("prod"),
        env: testEnv,
      })

      expect(stack.deploymentEnvironment).toBe("prod")
    })
  })
}

const defineBaseStackSuite1 = () => {
  defineBaseStackSuite1Part1()
  defineBaseStackSuite1Part2()
  defineBaseStackSuite1Part3()
  defineBaseStackSuite1Part4()
};

describe("BaseStack", defineBaseStackSuite1)
