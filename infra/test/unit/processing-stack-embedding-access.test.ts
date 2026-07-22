import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ProcessingStack } from '../../lib/processing-stack';

interface PolicyStatement {
  Sid?: string;
  Effect?: string;
  Action?: string | string[];
  Resource?: unknown;
  Condition?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function policyStatements(value: unknown): PolicyStatement[] {
  if (Array.isArray(value)) {
    return value.flatMap(policyStatements);
  }
  if (!isRecord(value)) {
    return [];
  }

  const direct = Array.isArray(value.Statement)
    ? value.Statement.filter(isRecord).map(
        (statement): PolicyStatement => statement,
      )
    : [];

  return [...direct, ...Object.values(value).flatMap(policyStatements)];
}

describe('ProcessingStack embedding visual-artifact access', () => {
  it('grants read-only access to repository artifacts without the broken generic S3 condition', () => {
    const app = new cdk.App();
    const stack = new ProcessingStack(app, 'ProcessingAccessTest', {
      env: { account: '123456789012', region: 'us-east-1' },
      environment: 'dev',
      documentsBucketName: 'aistudio-dev-documents',
      databaseResourceArn:
        'arn:aws:rds:us-east-1:123456789012:cluster:aistudio-dev',
      databaseSecretArn:
        'arn:aws:secretsmanager:us-east-1:123456789012:secret:aistudio-dev',
    });
    const template = Template.fromStack(stack);
    const statements = policyStatements(template.toJSON());
    const statement = statements.find(
      (candidate) => candidate.Sid === 'RepositoryVisualArtifactRead',
    );

    expect(statement).toMatchObject({
      Sid: 'RepositoryVisualArtifactRead',
      Effect: 'Allow',
    });
    expect(
      Array.isArray(statement?.Action) ? statement.Action : [statement?.Action],
    ).toEqual(['s3:GetObject']);
    expect(JSON.stringify(statement?.Resource)).toContain(
      ':s3:::aistudio-dev-documents/repositories/*',
    );
    expect(statement?.Condition).toBeUndefined();
    expect(statement?.Action).not.toEqual(
      expect.arrayContaining(['s3:PutObject', 's3:DeleteObject']),
    );
  });

  it('alarms on embedding backlog, terminal DLQ records, and worker failures', () => {
    const app = new cdk.App();
    const stack = new ProcessingStack(app, 'ProcessingAlarmTest', {
      env: { account: '123456789012', region: 'us-east-1' },
      environment: 'dev',
      documentsBucketName: 'aistudio-dev-documents',
      databaseResourceArn:
        'arn:aws:rds:us-east-1:123456789012:cluster:aistudio-dev',
      databaseSecretArn:
        'arn:aws:secretsmanager:us-east-1:123456789012:secret:aistudio-dev',
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'aistudio-dev-embedding-dlq-visible',
      Threshold: 1,
      TreatMissingData: 'notBreaching',
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'aistudio-dev-embedding-oldest-message',
      Threshold: 1_800,
      EvaluationPeriods: 2,
      TreatMissingData: 'notBreaching',
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'aistudio-dev-embedding-worker-errors',
      Threshold: 1,
      TreatMissingData: 'notBreaching',
    });
  });
});
