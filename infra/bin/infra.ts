#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { InfraStack } from '../lib/infra-stack';
import { DatabaseStack } from '../lib/database-stack';
import { AuthStack } from '../lib/auth-stack';
import { StorageStack } from '../lib/storage-stack';
import { FrontendStackEcs } from '../lib/frontend-stack-ecs';
import { ProcessingStack } from '../lib/processing-stack';
import { DocumentProcessingStack } from '../lib/document-processing-stack';
import { MonitoringStack } from '../lib/monitoring-stack';
import { SchedulerStack } from '../lib/scheduler-stack';
import { EmailNotificationStack } from '../lib/email-notification-stack';
import { PowerTuningStack } from '../lib/power-tuning-stack';
import { SecretsManagerStack } from '../lib/secrets-manager-stack';
import { SecretValue } from 'aws-cdk-lib';
import { PermissionBoundaryConstruct } from '../lib/constructs/security';
import { AccessAnalyzerStack } from '../lib/stacks/access-analyzer-stack';
import { EnvironmentConfig } from '../lib/constructs/config/environment-config';

const app = new cdk.App();

// Standard tags for cost allocation
const standardTags = {
  Project: 'AIStudio',
  Owner: 'TSD Engineering',
};

// Get configuration from context
const baseDomain = app.node.tryGetContext('baseDomain');
const alertEmail = app.node.tryGetContext('alertEmail');

// Helper to get callback/logout URLs for any environment
function getCallbackAndLogoutUrls(environment: string, baseDomain?: string): { callbackUrls: string[], logoutUrls: string[] } {
  // Determine ECS subdomain based on environment
  const ecsSubdomain = environment === 'dev'
    ? `dev.${baseDomain}`
    : baseDomain; // Prod uses root domain for ECS

  const urls = {
    callbackUrls: [
      baseDomain ? `https://${baseDomain}/` : 'https://example.com/',
      baseDomain ? `https://${baseDomain}/api/auth/callback/cognito` : 'https://example.com/api/auth/callback/cognito',
      // ECS URLs
      baseDomain ? `https://${ecsSubdomain}/` : undefined,
      baseDomain ? `https://${ecsSubdomain}/api/auth/callback/cognito` : undefined,
    ].filter(Boolean) as string[],
    logoutUrls: [
      baseDomain ? `https://${baseDomain}/` : 'https://example.com/',
      baseDomain ? `https://${baseDomain}/oauth2/idpresponse` : 'https://example.com/oauth2/idpresponse',
      // ECS URLs
      baseDomain ? `https://${ecsSubdomain}/` : undefined,
      baseDomain ? `https://${ecsSubdomain}/oauth2/idpresponse` : undefined,
    ].filter(Boolean) as string[],
  };

  // Add dev-specific URLs (localhost and Amplify dev subdomain)
  if (environment === 'dev') {
    urls.callbackUrls.push(
      'http://localhost:3000/',
      'http://localhost:3001/',
      'http://localhost:3000/api/auth/callback/cognito',
      'http://localhost:3001/api/auth/callback/cognito',
      baseDomain ? `https://dev.${baseDomain}/` : 'https://dev.example.com/',
      baseDomain ? `https://dev.${baseDomain}/api/auth/callback/cognito` : 'https://dev.example.com/api/auth/callback/cognito'
    );
    urls.logoutUrls.push(
      'http://localhost:3000/',
      'http://localhost:3001/',
      'http://localhost:3000/oauth2/idpresponse',
      'http://localhost:3001/oauth2/idpresponse',
      baseDomain ? `https://dev.${baseDomain}/` : 'https://dev.example.com/',
      baseDomain ? `https://dev.${baseDomain}/oauth2/idpresponse` : 'https://dev.example.com/oauth2/idpresponse'
    );
  }

  return urls;
}

// Dev environment

// PowerTuning Stack - utility for Lambda optimization
const devPowerTuningStack = new PowerTuningStack(app, 'AIStudio-PowerTuningStack-Dev', {
  environment: 'dev',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
cdk.Tags.of(devPowerTuningStack).add('Environment', 'Dev');
Object.entries(standardTags).forEach(([key, value]) => cdk.Tags.of(devPowerTuningStack).add(key, value));

// Permission Boundary Stack - must be deployed first before other stacks
const devPermissionBoundaryStack = new cdk.Stack(app, 'AIStudio-PermissionBoundary-Dev', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
new PermissionBoundaryConstruct(devPermissionBoundaryStack, 'PermissionBoundary', {
  environment: 'dev',
});
cdk.Tags.of(devPermissionBoundaryStack).add('Environment', 'Dev');
Object.entries(standardTags).forEach(([key, value]) => cdk.Tags.of(devPermissionBoundaryStack).add(key, value));

// Access Analyzer Stack - continuous IAM compliance monitoring
const devAccessAnalyzerStack = new AccessAnalyzerStack(app, 'AIStudio-AccessAnalyzer-Dev', {
  config: {} as any, // Config not used by current implementation
  environment: 'dev',
  alertEmail,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
cdk.Tags.of(devAccessAnalyzerStack).add('Environment', 'Dev');
Object.entries(standardTags).forEach(([key, value]) => cdk.Tags.of(devAccessAnalyzerStack).add(key, value));

// Secrets Manager Stack - centralized secrets management
const devSecretsManagerStack = new SecretsManagerStack(app, 'AIStudio-SecretsManagerStack-Dev', {
  environment: 'dev',
  config: EnvironmentConfig.get('dev'),
  alertEmail,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
cdk.Tags.of(devSecretsManagerStack).add('Environment', 'Dev');
Object.entries(standardTags).forEach(([key, value]) => cdk.Tags.of(devSecretsManagerStack).add(key, value));

const devDbStack = new DatabaseStack(app, 'AIStudio-DatabaseStack-Dev', {
  environment: 'dev',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
cdk.Tags.of(devDbStack).add('Environment', 'Dev');
Object.entries(standardTags).forEach(([key, value]) => cdk.Tags.of(devDbStack).add(key, value));

const devUrls = getCallbackAndLogoutUrls('dev', baseDomain);
const devAuthStack = new AuthStack(app, 'AIStudio-AuthStack-Dev', {
  environment: 'dev',
  googleClientSecret: SecretValue.secretsManager('aistudio-dev-google-oauth', { jsonField: 'clientSecret' }),
  callbackUrls: devUrls.callbackUrls,
  logoutUrls: devUrls.logoutUrls,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
cdk.Tags.of(devAuthStack).add('Environment', 'Dev');
Object.entries(standardTags).forEach(([key, value]) => cdk.Tags.of(devAuthStack).add(key, value));

const devStorageStack = new StorageStack(app, 'AIStudio-StorageStack-Dev', {
  environment: 'dev',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
cdk.Tags.of(devStorageStack).add('Environment', 'Dev');
Object.entries(standardTags).forEach(([key, value]) => cdk.Tags.of(devStorageStack).add(key, value));

const devProcessingStack = new ProcessingStack(app, 'AIStudio-ProcessingStack-Dev', {
  environment: 'dev',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
cdk.Tags.of(devProcessingStack).add('Environment', 'Dev');
Object.entries(standardTags).forEach(([key, value]) => cdk.Tags.of(devProcessingStack).add(key, value));

const devDocumentProcessingStack = new DocumentProcessingStack(app, 'AIStudio-DocumentProcessingStack-Dev', {
  environment: 'dev',
  rdsClusterArn: devDbStack.databaseResourceArn,
  rdsSecretArn: devDbStack.databaseSecretArn,
  documentsBucketName: devStorageStack.documentsBucketName,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
devDocumentProcessingStack.addDependency(devDbStack);
devDocumentProcessingStack.addDependency(devStorageStack);
cdk.Tags.of(devDocumentProcessingStack).add('Environment', 'Dev');
Object.entries(standardTags).forEach(([key, value]) => cdk.Tags.of(devDocumentProcessingStack).add(key, value));

const devSchedulerStack = new SchedulerStack(app, 'AIStudio-SchedulerStack-Dev', {
  environment: 'dev',
  databaseResourceArn: devDbStack.databaseResourceArn,
  databaseSecretArn: devDbStack.databaseSecretArn,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
devSchedulerStack.addDependency(devDbStack);
// Note: FrontendStack-ECS dependency added below (after FrontendStack is created)
cdk.Tags.of(devSchedulerStack).add('Environment', 'Dev');
Object.entries(standardTags).forEach(([key, value]) => cdk.Tags.of(devSchedulerStack).add(key, value));

// Get email configuration from context (environment-specific with fallback)
const devEmailDomain = app.node.tryGetContext('devEmailDomain') || app.node.tryGetContext('emailDomain');
const devSesIdentityExists = app.node.tryGetContext('devSesIdentityExists') === 'true' ||
                             app.node.tryGetContext('sesIdentityExists') === 'true';

// Only create dev email notification stack if emailDomain is provided
let devEmailNotificationStack: EmailNotificationStack | undefined;
if (devEmailDomain) {
  devEmailNotificationStack = new EmailNotificationStack(app, 'AIStudio-EmailNotificationStack-Dev', {
    environment: 'dev',
    databaseResourceArn: devDbStack.databaseResourceArn,
    databaseSecretArn: devDbStack.databaseSecretArn,
    // SES configuration from context
    createSesIdentity: !devSesIdentityExists,
    emailDomain: devEmailDomain,
    fromEmail: `noreply@${devEmailDomain}`,
    appBaseUrl: baseDomain ? `https://dev.${baseDomain}` : undefined,
    useDomainIdentity: false, // Dev uses email identity by default
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  });
  devEmailNotificationStack.addDependency(devDbStack);
  cdk.Tags.of(devEmailNotificationStack).add('Environment', 'Dev');
  Object.entries(standardTags).forEach(([key, value]) => cdk.Tags.of(devEmailNotificationStack!).add(key, value));
}

// Prod environment
// Permission Boundary Stack - must be deployed first before other stacks
const prodPermissionBoundaryStack = new cdk.Stack(app, 'AIStudio-PermissionBoundary-Prod', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
new PermissionBoundaryConstruct(prodPermissionBoundaryStack, 'PermissionBoundary', {
  environment: 'prod',
});
cdk.Tags.of(prodPermissionBoundaryStack).add('Environment', 'Prod');
Object.entries(standardTags).forEach(([key, value]) => cdk.Tags.of(prodPermissionBoundaryStack).add(key, value));

// Secrets Manager Stack - centralized secrets management
const prodSecretsManagerStack = new SecretsManagerStack(app, 'AIStudio-SecretsManagerStack-Prod', {
  environment: 'prod',
  config: EnvironmentConfig.get('prod'),
  alertEmail,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
cdk.Tags.of(prodSecretsManagerStack).add('Environment', 'Prod');
Object.entries(standardTags).forEach(([key, value]) => cdk.Tags.of(prodSecretsManagerStack).add(key, value));

const prodDbStack = new DatabaseStack(app, 'AIStudio-DatabaseStack-Prod', {
  environment: 'prod',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
cdk.Tags.of(prodDbStack).add('Environment', 'Prod');
Object.entries(standardTags).forEach(([key, value]) => cdk.Tags.of(prodDbStack).add(key, value));

const prodUrls = getCallbackAndLogoutUrls('prod', baseDomain);
const prodAuthStack = new AuthStack(app, 'AIStudio-AuthStack-Prod', {
  environment: 'prod',
  googleClientSecret: SecretValue.secretsManager('aistudio-prod-google-oauth', { jsonField: 'clientSecret' }),
  callbackUrls: prodUrls.callbackUrls,
  logoutUrls: prodUrls.logoutUrls,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
cdk.Tags.of(prodAuthStack).add('Environment', 'Prod');
Object.entries(standardTags).forEach(([key, value]) => cdk.Tags.of(prodAuthStack).add(key, value));

const prodStorageStack = new StorageStack(app, 'AIStudio-StorageStack-Prod', {
  environment: 'prod',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
cdk.Tags.of(prodStorageStack).add('Environment', 'Prod');
Object.entries(standardTags).forEach(([key, value]) => cdk.Tags.of(prodStorageStack).add(key, value));

const prodProcessingStack = new ProcessingStack(app, 'AIStudio-ProcessingStack-Prod', {
  environment: 'prod',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
cdk.Tags.of(prodProcessingStack).add('Environment', 'Prod');
Object.entries(standardTags).forEach(([key, value]) => cdk.Tags.of(prodProcessingStack).add(key, value));

const prodDocumentProcessingStack = new DocumentProcessingStack(app, 'AIStudio-DocumentProcessingStack-Prod', {
  environment: 'prod',
  rdsClusterArn: prodDbStack.databaseResourceArn,
  rdsSecretArn: prodDbStack.databaseSecretArn,
  documentsBucketName: prodStorageStack.documentsBucketName,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
prodDocumentProcessingStack.addDependency(prodDbStack);
prodDocumentProcessingStack.addDependency(prodStorageStack);
cdk.Tags.of(prodDocumentProcessingStack).add('Environment', 'Prod');
Object.entries(standardTags).forEach(([key, value]) => cdk.Tags.of(prodDocumentProcessingStack).add(key, value));

const prodSchedulerStack = new SchedulerStack(app, 'AIStudio-SchedulerStack-Prod', {
  environment: 'prod',
  databaseResourceArn: prodDbStack.databaseResourceArn,
  databaseSecretArn: prodDbStack.databaseSecretArn,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
prodSchedulerStack.addDependency(prodDbStack);
// Note: FrontendStack-ECS dependency added below (after FrontendStack is created)
cdk.Tags.of(prodSchedulerStack).add('Environment', 'Prod');
Object.entries(standardTags).forEach(([key, value]) => cdk.Tags.of(prodSchedulerStack).add(key, value));

// Get prod email configuration from context (environment-specific with fallback)
const prodEmailDomain = app.node.tryGetContext('prodEmailDomain') || app.node.tryGetContext('emailDomain');
const prodSesIdentityExists = app.node.tryGetContext('prodSesIdentityExists') === 'true' ||
                              app.node.tryGetContext('sesIdentityExists') === 'true';
const prodUseDomainIdentity = app.node.tryGetContext('prodUseDomainIdentity') !== 'false';

// Only create prod email notification stack if emailDomain is provided
let prodEmailNotificationStack: EmailNotificationStack | undefined;
if (prodEmailDomain) {
  prodEmailNotificationStack = new EmailNotificationStack(app, 'AIStudio-EmailNotificationStack-Prod', {
    environment: 'prod',
    databaseResourceArn: prodDbStack.databaseResourceArn,
    databaseSecretArn: prodDbStack.databaseSecretArn,
    // Production SES configuration from context
    createSesIdentity: !prodSesIdentityExists,
    emailDomain: prodEmailDomain,
    fromEmail: `noreply@${prodEmailDomain}`,
    appBaseUrl: baseDomain ? `https://${baseDomain}` : undefined,
    useDomainIdentity: prodUseDomainIdentity, // Defaults to true for production
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  });
  prodEmailNotificationStack.addDependency(prodDbStack);
  cdk.Tags.of(prodEmailNotificationStack).add('Environment', 'Prod');
  Object.entries(standardTags).forEach(([key, value]) => cdk.Tags.of(prodEmailNotificationStack!).add(key, value));
}
// Frontend stacks - ECS Fargate with ALB for streaming support
if (baseDomain) {
  // Skip DNS/certificate setup in CI (when baseDomain is a dummy value like example.com)
  // VPC lookup will use cached context from cdk.context.json (committed to version control)
  const setupDns = baseDomain !== 'example.com';

  const devFrontendStack = new FrontendStackEcs(app, 'AIStudio-FrontendStack-ECS-Dev', {
    environment: 'dev',
    baseDomain: 'aistudio.psd401.ai', // The subdomain for AI Studio
    customSubdomain: 'dev', // Creates dev.aistudio.psd401.ai
    documentsBucketName: devStorageStack.documentsBucketName,
    useExistingVpc: setupDns, // Use VPC sharing in real deployments, create new VPC for CI validation
    setupDns, // Enable DNS/certificate setup (false for CI validation with example.com)
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  });
  devFrontendStack.addDependency(devDbStack); // Need VPC from DB stack
  devFrontendStack.addDependency(devStorageStack); // Need bucket name
  devFrontendStack.addDependency(devAuthStack); // Need auth secret ARN export
  cdk.Tags.of(devFrontendStack).add('Environment', 'Dev');
  Object.entries(standardTags).forEach(([key, value]) => cdk.Tags.of(devFrontendStack).add(key, value));

  // SchedulerStack depends on FrontendStack-ECS to read SSM parameters (ECS security group ID, internal endpoint)
  devSchedulerStack.addDependency(devFrontendStack);

  const prodFrontendStack = new FrontendStackEcs(app, 'AIStudio-FrontendStack-ECS-Prod', {
    environment: 'prod',
    baseDomain: 'aistudio.psd401.ai', // The subdomain for AI Studio
    // No customSubdomain for prod - will use root: aistudio.psd401.ai
    documentsBucketName: prodStorageStack.documentsBucketName,
    useExistingVpc: setupDns, // Use VPC sharing in real deployments, create new VPC for CI validation
    setupDns, // Enable DNS/certificate setup (false for CI validation with example.com)
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  });
  prodFrontendStack.addDependency(prodDbStack); // Need VPC from DB stack
  prodFrontendStack.addDependency(prodStorageStack); // Need bucket name
  prodFrontendStack.addDependency(prodAuthStack); // Need auth secret ARN export
  cdk.Tags.of(prodFrontendStack).add('Environment', 'Prod');
  Object.entries(standardTags).forEach(([key, value]) => cdk.Tags.of(prodFrontendStack).add(key, value));

  // SchedulerStack depends on FrontendStack-ECS to read SSM parameters (ECS security group ID, internal endpoint)
  prodSchedulerStack.addDependency(prodFrontendStack);

  // To deploy, use:
  // cdk deploy AIStudio-FrontendStack-ECS-Dev --context baseDomain=yourdomain.com
  // cdk deploy AIStudio-FrontendStack-ECS-Prod --context baseDomain=yourdomain.com
}

// Monitoring stacks - created after all other stacks for comprehensive monitoring
// Now receives metrics from infrastructure stacks for consolidated dashboards
const devMonitoringStack = new MonitoringStack(app, 'AIStudio-MonitoringStack-Dev', {
  environment: 'dev',
  alertEmail,
  auroraCostDashboard: devDbStack.costDashboard,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
// Ensure DatabaseStack deploys first - MonitoringStack requires Aurora metrics for consolidated dashboards
devMonitoringStack.addDependency(devDbStack);
cdk.Tags.of(devMonitoringStack).add('Environment', 'Dev');
Object.entries(standardTags).forEach(([key, value]) => cdk.Tags.of(devMonitoringStack).add(key, value));

const prodMonitoringStack = new MonitoringStack(app, 'AIStudio-MonitoringStack-Prod', {
  environment: 'prod',
  alertEmail,
  auroraCostDashboard: prodDbStack.costDashboard,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
// Ensure DatabaseStack deploys first - MonitoringStack requires Aurora metrics for consolidated dashboards
prodMonitoringStack.addDependency(prodDbStack);
cdk.Tags.of(prodMonitoringStack).add('Environment', 'Prod');
Object.entries(standardTags).forEach(([key, value]) => cdk.Tags.of(prodMonitoringStack).add(key, value));

// To deploy monitoring with email alerts:
// cdk deploy AIStudio-MonitoringStack-Dev --context alertEmail=your-email@example.com
// cdk deploy AIStudio-MonitoringStack-Prod --context alertEmail=your-email@example.com

new InfraStack(app, 'AIStudio-InfraStack', {
  /* If you don't specify 'env', this stack will be environment-agnostic.
   * Account/Region-dependent features and context lookups will not work,
   * but a single synthesized template can be deployed anywhere. */

  /* Uncomment the next line to specialize this stack for the AWS Account
   * and Region that are implied by the current CLI configuration. */
  // env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },

  /* Uncomment the next line if you know exactly what Account and Region you
   * want to deploy the stack to. */
  // env: { account: '123456789012', region: 'us-east-1' },

  /* For more information, see https://docs.aws.amazon.com/cdk/latest/guide/environments.html */
});