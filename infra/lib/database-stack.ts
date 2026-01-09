import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as path from 'path';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import {
  AuroraCostOptimizer,
  AuroraCostDashboard,
  VPCProvider,
  EnvironmentConfig,
} from './constructs';

export interface DatabaseStackProps extends cdk.StackProps {
  environment: 'dev' | 'prod';
}

export class DatabaseStack extends cdk.Stack {
  public readonly databaseResourceArn: string;
  public readonly databaseSecretArn: string;
  public readonly cluster: rds.IDatabaseCluster;
  public readonly costDashboard?: AuroraCostDashboard;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    // Get environment configuration
    const config = EnvironmentConfig.get(props.environment);

    // Use shared VPC instead of creating a new one
    // This reduces costs by eliminating duplicate NAT gateways and improves security
    const vpc = VPCProvider.getOrCreate(this, props.environment, config);

    // Security group for DB access
    const dbSg = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc,
      description: 'Allow inbound PostgreSQL',
      allowAllOutbound: true,
    });

    // For development, allow PostgreSQL access from anywhere (you should restrict this to your IP)
    if (props.environment === 'dev') {
      dbSg.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(5432),
        'Allow PostgreSQL access from anywhere (DEV ONLY)'
      );
      // Better practice: restrict to your IP
      // dbSg.addIngressRule(ec2.Peer.ipv4('YOUR.IP.ADDRESS.HERE/32'), ec2.Port.tcp(5432), 'Allow PostgreSQL from my IP');
    } else {
      // Production: only allow from within VPC
      dbSg.addIngressRule(
        ec2.Peer.ipv4(vpc.vpcCidrBlock),
        ec2.Port.tcp(5432),
        'Allow PostgreSQL access from VPC'
      );
    }

    // Secrets Manager secret for DB credentials
    const dbSecret = new secretsmanager.Secret(this, 'DbSecret', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'master' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        includeSpace: false,
      },
    });

    // Check if we should restore from snapshot (for one-time testing/migration)
    const snapshotId = this.node.tryGetContext('snapshotIdentifier');
    const restoreFromSnapshot = snapshotId !== undefined;

    if (restoreFromSnapshot) {
      // ==================================================================
      // SNAPSHOT RESTORATION PATH (One-time operation for testing)
      // ==================================================================
      // Use L1 CfnDBCluster to restore from snapshot
      // Note: Snapshot already contains schema and data, so db-init Lambda will be skipped

      // Get isolated subnet IDs for the cluster
      const isolatedSubnets = vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED });

      // Create subnet group for the cluster
      const subnetGroup = new rds.CfnDBSubnetGroup(this, 'DbSubnetGroup', {
        dbSubnetGroupDescription: `Subnet group for ${props.environment} Aurora cluster (restored from snapshot)`,
        subnetIds: isolatedSubnets.subnetIds,
        dbSubnetGroupName: `aistudio-${props.environment}-subnet-group`,
      });

      // Create cluster from snapshot using L1 construct
      const cfnCluster = new rds.CfnDBCluster(this, 'AuroraCluster', {
        snapshotIdentifier: snapshotId,
        engine: 'aurora-postgresql',
        engineVersion: '15.12', // Match snapshot version
        dbClusterIdentifier: `aistudio-${props.environment}-cluster`,
        serverlessV2ScalingConfiguration: {
          minCapacity: props.environment === 'prod' ? 2 : 0.5,
          maxCapacity: props.environment === 'prod' ? 8 : 2,
        },
        enableHttpEndpoint: true, // Enable Data API
        storageEncrypted: true,
        enableCloudwatchLogsExports: ['postgresql'],
        vpcSecurityGroupIds: [dbSg.securityGroupId],
        dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
        backupRetentionPeriod: props.environment === 'prod' ? 7 : 1,
        deletionProtection: props.environment === 'prod',
        // Note: masterUsername and masterUserPassword are not needed for snapshot restoration
      });
      cfnCluster.addDependency(subnetGroup);

      // Create writer instance
      const cfnWriter = new rds.CfnDBInstance(this, 'Writer', {
        dbInstanceIdentifier: `aistudio-${props.environment}-writer`,
        dbClusterIdentifier: cfnCluster.ref,
        dbInstanceClass: 'db.serverless',
        engine: 'aurora-postgresql',
        enablePerformanceInsights: props.environment === 'prod',
      });
      cfnWriter.addDependency(cfnCluster);

      // Import as IDatabaseCluster for compatibility with existing code
      this.cluster = rds.DatabaseCluster.fromDatabaseClusterAttributes(this, 'ImportedCluster', {
        clusterIdentifier: cfnCluster.ref,
        clusterEndpointAddress: cfnCluster.attrEndpointAddress,
        port: cfnCluster.attrEndpointPort ? cdk.Token.asNumber(cfnCluster.attrEndpointPort) : 5432,
        securityGroups: [dbSg],
        readerEndpointAddress: cfnCluster.attrReadEndpointAddress,
      });

      this.databaseResourceArn = cfnCluster.attrDbClusterArn;
      this.databaseSecretArn = dbSecret.secretArn;

    } else {
      // ==================================================================
      // NORMAL PATH - Fresh cluster creation
      // ==================================================================
      this.cluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
        clusterIdentifier: `aistudio-${props.environment}-cluster`,
        engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_15_12 }),
        credentials: rds.Credentials.fromSecret(dbSecret),
        defaultDatabaseName: 'aistudio',
        writer: rds.ClusterInstance.serverlessV2('Writer', {
          scaleWithWriter: true,
          // Note: publiclyAccessible requires the DB to be in public subnets
          // We'll keep it in private subnets and use Data API instead
        }),
        readers: props.environment === 'prod'
          ? [rds.ClusterInstance.serverlessV2('Reader', {
              scaleWithWriter: true,
            })]
          : [],
        serverlessV2MinCapacity: props.environment === 'prod' ? 2 : 0.5,
        serverlessV2MaxCapacity: props.environment === 'prod' ? 8 : 2,
        storageEncrypted: true,
        backup: {
          retention: cdk.Duration.days(props.environment === 'prod' ? 7 : 1),
        },
        removalPolicy: props.environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
        deletionProtection: props.environment === 'prod',
        cloudwatchLogsExports: ['postgresql'],
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        securityGroups: [dbSg],
        enableDataApi: true,
      });

      this.databaseResourceArn = this.cluster.clusterArn;
      this.databaseSecretArn = dbSecret.secretArn;
    }

    // RDS Proxy (skip for snapshot restoration as imported cluster doesn't support addProxy)
    let proxy: rds.IDatabaseProxy | undefined;
    if (!restoreFromSnapshot && this.cluster instanceof rds.DatabaseCluster) {
      proxy = this.cluster.addProxy('RdsProxy', {
        secrets: [dbSecret],
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        securityGroups: [dbSg],
        requireTLS: true,
        debugLogging: props.environment !== 'prod',
      });
    }

    // Add cost optimization features (skip for snapshot restoration as AuroraCostOptimizer requires DatabaseCluster)
    if (!restoreFromSnapshot && this.cluster instanceof rds.DatabaseCluster) {
      new AuroraCostOptimizer(this, 'CostOptimizer', {
        cluster: this.cluster,
        environment: props.environment,
        // Dev: Aggressive auto-pause for maximum savings
        ...(props.environment === 'dev' && {
          enableAutoPause: true,
          idleMinutesBeforePause: 30,
          enableScheduledScaling: false,
        }),
        // Prod: Predictive scaling only, never pause
        // Business hours: 7am-5pm Pacific Time (M-F)
        // Note: EventBridge uses UTC. Pacific Time = UTC-8 (PST) or UTC-7 (PDT)
        // 7am PT = 3pm UTC (PST) / 2pm UTC (PDT) - will shift 1 hour with DST
        // 5pm PT = 1am UTC next day (PST) / 12am UTC (PDT)
        // DST shift is acceptable: becomes 6am-4pm PT during winter months
        ...(props.environment === 'prod' && {
          enableAutoPause: false,
          enableScheduledScaling: true,
          businessHours: {
            scaleUpHour: 15,  // 7am Pacific Time (PST) / 6am during PDT
            scaleDownHour: 1,  // 5pm Pacific Time (PST) / 4pm during PDT
            daysOfWeek: 'MON-FRI',  // Weekdays only, weekends use lower capacity
          },
          scaling: {
            businessHoursMin: 2.0,  // M-F 7am-5pm PT: 2-8 ACU
            businessHoursMax: 8.0,
            offHoursMin: 1.0,       // Nights and weekends: 1-4 ACU
            offHoursMax: 4.0,
          },
        }),
      });

      // Export Aurora metrics for consolidated monitoring dashboard
      this.costDashboard = new AuroraCostDashboard(this, 'CostDashboard', {
        cluster: this.cluster,
        environment: props.environment,
      });
    }

    // Database initialization Lambda (SKIP when restoring from snapshot)
    // Note: Snapshot already contains schema and data, so no initialization needed
    if (!restoreFromSnapshot) {
      // Create log group for database init Lambda
      const dbInitLogGroup = new logs.LogGroup(this, 'DbInitLogGroup', {
        logGroupName: `/aws/lambda/db-init-${props.environment}`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: props.environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      });

      // Database initialization Lambda
      // Note: Lambda doesn't need to be in VPC since it uses RDS Data API
      const dbInitLambda = new lambda.Function(this, 'DbInitLambda', {
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(path.join(__dirname, '../database/lambda'), {
          bundling: {
            image: lambda.Runtime.NODEJS_20_X.bundlingImage,
            command: [
              'bash', '-c',
              'npm install && npm run build && cp -r ../schema dist/ && cp ../migrations.json dist/ && cp -r dist/* /asset-output/'
            ],
            environment: {
              NPM_CONFIG_CACHE: '/tmp/.npm',
            },
            local: {
              tryBundle(outputDir: string) {
                try {
                  const execSync = require('child_process').execSync;
                  const lambdaDir = path.join(__dirname, '../database/lambda');

                  // Run npm install and build
                  execSync('npm install', { cwd: lambdaDir, stdio: 'inherit' });
                  execSync('npm run build', { cwd: lambdaDir, stdio: 'inherit' });

                  // Copy built files to output directory
                  execSync(`cp -r ${path.join(lambdaDir, 'dist')}/* ${outputDir}/`, { stdio: 'inherit' });
                  execSync(`cp -r ${path.join(__dirname, '../database/schema')} ${outputDir}/`, { stdio: 'inherit' });
                  execSync(`cp ${path.join(__dirname, '../database/migrations.json')} ${outputDir}/`, { stdio: 'inherit' });

                  return true;
                } catch {
                  // If local bundling fails, fall back to Docker
                  return false;
                }
              },
            },
          },
        }),
        // Lambda doesn't need VPC access since it uses RDS Data API
        timeout: cdk.Duration.minutes(5),
        memorySize: 1024,
        environment: {
          NODE_OPTIONS: '--enable-source-maps',
        },
        logGroup: dbInitLogGroup,
      });

      // Grant the Lambda permission to use the Data API
      if (this.cluster instanceof rds.DatabaseCluster) {
        this.cluster.grantDataApiAccess(dbInitLambda);
      }
      dbSecret.grantRead(dbInitLambda);

      // Create log group for the Provider's internal Lambda function
      const providerLogGroup = new logs.LogGroup(this, 'DbInitProviderLogGroup', {
        logGroupName: `/aws/lambda/db-init-provider-${props.environment}`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: props.environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      });

      // Create Custom Resource Provider with explicit log group to avoid deprecation warning
      const dbInitProvider = new cr.Provider(this, 'DbInitProvider', {
        onEventHandler: dbInitLambda,
        logGroup: providerLogGroup,
      });

      // Create Custom Resource
      const dbInit = new cdk.CustomResource(this, 'DbInit', {
        serviceToken: dbInitProvider.serviceToken,
        properties: {
          ClusterArn: this.databaseResourceArn,
          SecretArn: dbSecret.secretArn,
          DatabaseName: 'aistudio',
          Environment: props.environment,
          // Add a timestamp to force update on stack updates if needed - v1.0.15
          Timestamp: new Date().toISOString(),
        },
      });

      // Ensure the database is created before initialization
      if (this.cluster instanceof rds.DatabaseCluster) {
        dbInit.node.addDependency(this.cluster);
      }
    }

    // Outputs
    if (proxy) {
      new cdk.CfnOutput(this, 'RdsProxyEndpoint', {
        value: proxy.endpoint,
        description: 'RDS Proxy endpoint',
        exportName: `${props.environment}-RdsProxyEndpoint`,
      });
    }

    if (!restoreFromSnapshot) {
      new cdk.CfnOutput(this, 'ClusterEndpoint', {
        value: this.cluster.clusterEndpoint.hostname,
        description: 'Aurora cluster writer endpoint',
        exportName: `${props.environment}-ClusterEndpoint`,
      });

      new cdk.CfnOutput(this, 'ClusterReaderEndpoint', {
        value: this.cluster.clusterReadEndpoint.hostname,
        description: 'Aurora cluster reader endpoint',
        exportName: `${props.environment}-ClusterReaderEndpoint`,
      });
    }

    // Store values in SSM Parameter Store for cross-stack references
    new ssm.StringParameter(this, 'DbClusterArnParam', {
      parameterName: `/aistudio/${props.environment}/db-cluster-arn`,
      stringValue: this.databaseResourceArn,
      description: 'Aurora cluster ARN for Data API',
    });

    new ssm.StringParameter(this, 'DbSecretArnParam', {
      parameterName: `/aistudio/${props.environment}/db-secret-arn`,
      stringValue: this.databaseSecretArn,
      description: 'Secrets Manager ARN for DB credentials',
    });

    // Issue #603: Add direct PostgreSQL connection parameters for postgres.js driver
    // These enable ECS tasks to connect directly to Aurora without Data API
    if (!restoreFromSnapshot && this.cluster instanceof rds.DatabaseCluster) {
      new ssm.StringParameter(this, 'DbHostParam', {
        parameterName: `/aistudio/${props.environment}/db-host`,
        stringValue: this.cluster.clusterEndpoint.hostname,
        description: 'Aurora cluster endpoint hostname for direct PostgreSQL connection',
      });

      new ssm.StringParameter(this, 'DbPortParam', {
        parameterName: `/aistudio/${props.environment}/db-port`,
        stringValue: '5432',
        description: 'Aurora cluster port for PostgreSQL connection',
      });

      new ssm.StringParameter(this, 'DbNameParam', {
        parameterName: `/aistudio/${props.environment}/db-name`,
        stringValue: 'aistudio',
        description: 'Database name',
      });
    }

    // Keep CloudFormation outputs for backward compatibility and monitoring
    new cdk.CfnOutput(this, 'ClusterArn', {
      value: this.databaseResourceArn,
      description: 'Aurora cluster ARN for Data API',
      exportName: `${props.environment}-ClusterArn`,
    });

    new cdk.CfnOutput(this, 'DbSecretArn', {
      value: this.databaseSecretArn,
      description: 'Secrets Manager ARN for DB credentials',
      exportName: `${props.environment}-DbSecretArn`,
    });
  }
}
