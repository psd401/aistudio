import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { PowerTuningStateMachine } from './constructs';

export interface PowerTuningStackProps extends cdk.StackProps {
  environment: string;
}

/**
 * PowerTuning Stack
 *
 * Deploys AWS Lambda PowerTuning State Machine for optimizing Lambda function memory configurations.
 * This is a utility stack that should be deployed once per environment and kept running.
 *
 * Usage:
 * 1. Deploy this stack once: `bunx cdk deploy AIStudio-PowerTuningStack-Dev`
 * 2. Run tuning on Lambda functions as needed
 * 3. Keep deployed - it costs almost nothing (~$0.10/month)
 *
 * Part of: Epic #372 - CDK Infrastructure Optimization
 * Based on: ADR-005 - Lambda Function Comprehensive Optimization
 */
export class PowerTuningStack extends cdk.Stack {
  public readonly stateMachine: PowerTuningStateMachine;

  constructor(scope: Construct, id: string, props: PowerTuningStackProps) {
    super(scope, id, props);

    // Create PowerTuning State Machine
    this.stateMachine = new PowerTuningStateMachine(this, 'PowerTuning', {
      environment: props.environment,
      // Dev: Keep logs for 1 week, Prod: Keep for 1 month
      logRetention: props.environment === 'prod'
        ? cdk.aws_logs.RetentionDays.ONE_MONTH
        : cdk.aws_logs.RetentionDays.ONE_WEEK,
      // Timeout after 1 hour (should be plenty for most functions)
      timeout: cdk.Duration.hours(1),
    });

    // Note: StateMachineArn export is created by the PowerTuningStateMachine construct

    // Output helpful usage example
    new cdk.CfnOutput(this, 'UsageExample', {
      value: `aws stepfunctions start-execution --state-machine-arn ${this.stateMachine.stateMachine.stateMachineArn} --input '{"lambdaARN":"arn:aws:lambda:REGION:ACCOUNT:function:YOUR-FUNCTION","powerValues":[128,256,512,1024,1536,2048,3008],"num":10,"payload":{},"strategy":"balanced"}'`,
      description: 'Example command to run PowerTuning (replace REGION, ACCOUNT, YOUR-FUNCTION)',
    });
  }
}
