import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export interface AuthStackProps extends cdk.StackProps {
  environment: 'dev' | 'prod';
  googleClientSecret: cdk.SecretValue; // From Secrets Manager
  callbackUrls: string[];
  logoutUrls: string[];
}

export class AuthStack extends cdk.Stack {
  public readonly googleContentOAuthSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const googleClientIdParam = new cdk.CfnParameter(this, 'GoogleClientId', {
      type: 'String',
      description: `Google OAuth Client ID for ${props.environment}`,
    });
    const googleClientId = googleClientIdParam.valueAsString;
    const googlePickerApiKeyParam = new cdk.CfnParameter(this, 'GooglePickerApiKey', {
      type: 'String',
      noEcho: true,
      minLength: 1,
      description: `Browser-restricted Google Picker API key for ${props.environment}`,
    });

    // Reuse the Google OAuth web client already required by this stack and
    // assemble the content connector's complete runtime contract in
    // CloudFormation. The application must never depend on an operator-created
    // Secrets Manager object. A web client id encodes its owning Google Cloud
    // project number before the first "-"; Picker requires that value as appId.
    this.googleContentOAuthSecret = new secretsmanager.Secret(this, 'GoogleContentOAuthSecret', {
      secretName: `aistudio/${props.environment}/google-content-oauth`,
      description: 'Deployment-managed Google OAuth and Picker configuration for repository synchronization',
      secretObjectValue: {
        clientId: cdk.SecretValue.unsafePlainText(googleClientId),
        clientSecret: props.googleClientSecret,
        pickerApiKey: cdk.SecretValue.unsafePlainText(googlePickerApiKeyParam.valueAsString),
        appId: cdk.SecretValue.unsafePlainText(
          cdk.Fn.select(0, cdk.Fn.split('-', googleClientId))
        ),
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    cdk.Tags.of(this.googleContentOAuthSecret).add('Environment', props.environment);
    cdk.Tags.of(this.googleContentOAuthSecret).add('ManagedBy', 'cdk');

    // Cognito User Pool
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `aistudio-${props.environment}-userpool`,
      signInAliases: { email: true },
      selfSignUpEnabled: false,
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: cdk.Duration.days(7),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: props.environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // Google Identity Provider
    const googleProvider = new cognito.UserPoolIdentityProviderGoogle(this, 'Google', {
      clientId: googleClientId,
      clientSecretValue: props.googleClientSecret,
      userPool,
      scopes: [
        'openid',
        'profile',
        'email',
      ],
      attributeMapping: {
        email: cognito.ProviderAttribute.GOOGLE_EMAIL,
        givenName: cognito.ProviderAttribute.GOOGLE_GIVEN_NAME,
        familyName: cognito.ProviderAttribute.GOOGLE_FAMILY_NAME,
        profilePicture: cognito.ProviderAttribute.GOOGLE_PICTURE
      },
    });
    userPool.registerIdentityProvider(googleProvider);

    // User Pool Domain
    const domainPrefix = `aistudio-${props.environment}`;
    const userPoolDomain = new cognito.UserPoolDomain(this, 'UserPoolDomain', {
      userPool,
      cognitoDomain: {
        domainPrefix,
      },
    });

    // User Pool Client
    const userPoolClient = userPool.addClient('WebClient', {
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: props.callbackUrls,
        logoutUrls: props.logoutUrls,
      },
      generateSecret: false,
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.GOOGLE,
      ],
      // Configure token lifetimes to match application requirements
      // This fixes the 1-hour logout issue by extending token validity
      accessTokenValidity: cdk.Duration.hours(12),  // 12 hours instead of 1 hour default
      idTokenValidity: cdk.Duration.hours(12),      // 12 hours instead of 1 hour default
      refreshTokenValidity: cdk.Duration.days(30),  // 30 days (keep default)
    });
    userPoolClient.node.addDependency(googleProvider);

    // ============================================================================
    // NextAuth Secret for JWT Signing
    // ============================================================================
    const authSecret = new secretsmanager.Secret(this, 'AuthSecret', {
      secretName: `aistudio-${props.environment}-auth-secret`,
      description: `NextAuth secret for ${props.environment} environment`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'AUTH_SECRET',
        excludePunctuation: true,
        passwordLength: 32,
      },
      removalPolicy: props.environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    // Outputs
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID',
      exportName: `${props.environment}-CognitoUserPoolId`,
    });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
      exportName: `${props.environment}-CognitoUserPoolClientId`,
    });
    new cdk.CfnOutput(this, 'CognitoDomainUrl', {
      value: `https://${userPoolDomain.domainName}.auth.${this.region}.amazoncognito.com`,
      description: 'Cognito Domain URL',
      exportName: `${props.environment}-CognitoDomainUrl`,
    });
    new cdk.CfnOutput(this, 'AuthSecretArn', {
      value: authSecret.secretArn,
      description: 'NextAuth secret ARN',
      exportName: `${props.environment}-AuthSecretArn`,
    });
    new cdk.CfnOutput(this, 'GoogleContentOAuthSecretArn', {
      value: this.googleContentOAuthSecret.secretArn,
      description: 'Deployment-managed Google content OAuth configuration secret ARN',
      exportName: `${props.environment}-GoogleContentOAuthSecretArn`,
    });
  }
}
