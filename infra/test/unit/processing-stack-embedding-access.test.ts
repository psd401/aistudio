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

function synthesizeProcessingStack(): Template {
  const app = new cdk.App();
  const stack = new ProcessingStack(app, 'ProcessingEmbeddingAccessTest', {
    env: { account: '123456789012', region: 'us-east-1' },
    environment: 'dev',
    documentsBucketName: 'aistudio-dev-documents',
    databaseResourceArn:
      'arn:aws:rds:us-east-1:123456789012:cluster:aistudio-dev',
    databaseSecretArn:
      'arn:aws:secretsmanager:us-east-1:123456789012:secret:aistudio-dev',
  });
  return Template.fromStack(stack);
}

describe('ProcessingStack embedding visual-artifact access', () => {
  const template = synthesizeProcessingStack();
  const statements = policyStatements(template.toJSON());

  it('grants read-only access to repository artifacts without the broken generic S3 condition', () => {
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

  it('grants the embedding worker every configured Bedrock model and no wildcard model access', () => {
    const statement = statements.find(
      (candidate) => candidate.Sid === 'RepositoryTitanEmbeddingAccess',
    );
    const resources = Array.isArray(statement?.Resource)
      ? statement.Resource
      : [statement?.Resource];
    const serializedResources = JSON.stringify(resources);

    expect(statement?.Action).toBe('bedrock:InvokeModel');
    expect(serializedResources).toContain('/amazon.titan-embed-text-v1');
    expect(serializedResources).toContain('/amazon.titan-embed-text-v2:0');
    expect(serializedResources).toContain('/cohere.embed-v4:0');
    expect(resources).not.toContain('*');
  });

  it('alarms on embedding backlog, terminal DLQ records, and worker failures', () => {
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

  it('routes group-sync alarms through the shared monitoring topic', () => {
    const alarms = Object.values(
      template.findResources('AWS::CloudWatch::Alarm'),
    );

    for (const alarmName of [
      'psd-group-sync-failure-dev',
      'psd-group-sync-staleness-dev',
    ]) {
      const alarm = alarms.find((resource) =>
        JSON.stringify(resource).includes(`\"AlarmName\":\"${alarmName}\"`),
      );
      expect(alarm).toBeDefined();
      expect(JSON.stringify(alarm)).toContain(
        'aistudio-dev-monitoring-alarms',
      );
      expect(JSON.stringify(alarm)).not.toContain('psd-group-sync-alarms-dev');
    }

    const topics = template.findResources('AWS::SNS::Topic');
    expect(JSON.stringify(topics)).not.toContain('psd-group-sync-alarms-dev');
    const subscriptions = template.findResources('AWS::SNS::Subscription');
    expect(JSON.stringify(subscriptions)).not.toContain('"Protocol":"email"');
  });
});
