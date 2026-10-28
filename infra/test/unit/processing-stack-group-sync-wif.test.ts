/**
 * CDK assertions for keyless group-sync auth (#1989).
 *
 * psd401/psd-gcp-infra directory-reader.tf trusts the group-sync role by its
 * EXACT name and the Lambda reads its WIF config from the environment, so this
 * pins: the role name, the two WIF env vars, and that no
 * aistudio-<env>-google-directory-* key secret is readable any more.
 */
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ProcessingStack } from '../../lib/processing-stack';

function synthesizeProcessingStack(environment: 'dev' | 'prod'): Template {
  const app = new cdk.App();
  const stack = new ProcessingStack(app, `ProcessingGroupSyncWifTest-${environment}`, {
    env: { account: '123456789012', region: 'us-east-1' },
    environment,
    documentsBucketName: `aistudio-${environment}-documents`,
    databaseResourceArn:
      `arn:aws:rds:us-east-1:123456789012:cluster:aistudio-${environment}`,
    databaseSecretArn:
      `arn:aws:secretsmanager:us-east-1:123456789012:secret:aistudio-${environment}`,
    googleContentOAuthSecretArn:
      `arn:aws:secretsmanager:us-east-1:123456789012:secret:aistudio/${environment}/google-content-oauth-AbCdEf`,
  });
  return Template.fromStack(stack);
}

describe.each(['dev', 'prod'] as const)('group-sync keyless auth (%s)', (environment) => {
  const template = synthesizeProcessingStack(environment);

  it('runs under the role name the directory-reader provider trusts', () => {
    const roles = template.findResources('AWS::IAM::Role', {
      Properties: {
        RoleName: `psd-group-sync-${environment}-execution-role-${environment}`,
      },
    });
    const [roleId] = Object.keys(roles);
    expect(roleId).toBeDefined();
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: `psd-group-sync-${environment}`,
      Role: { 'Fn::GetAtt': [roleId, 'Arn'] },
    });
  });

  it('carries the shared groups reader WIF config', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: `psd-group-sync-${environment}`,
      Environment: {
        Variables: Match.objectLike({
          GOOGLE_DIRECTORY_WIF_AUDIENCE:
            '//iam.googleapis.com/projects/1022506104054/locations/global/' +
            'workloadIdentityPools/aws-agent-broker/providers/directory-reader',
          GOOGLE_DIRECTORY_SERVICE_ACCOUNT_EMAIL:
            'directory-groups-reader@psd-org-tooling.iam.gserviceaccount.com',
        }),
      },
    });
  });

  it('can no longer read a Google directory key secret', () => {
    expect(JSON.stringify(template.toJSON())).not.toContain('google-directory');
  });
});
