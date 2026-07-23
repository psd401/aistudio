import * as cdk from "aws-cdk-lib"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import * as elasticache from "aws-cdk-lib/aws-elasticache"
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager"
import { Construct } from "constructs"

/**
 * RedisCache — ElastiCache (Redis OSS) single-node cache for Atrium collaboration.
 *
 * Issue #1051 (Epic #1059, Atrium Phase 1). The Atrium collaboration server
 * (lib/content/collab/collab-server.ts) only enables Redis fan-out when
 * REDIS_HOST is set, so this cache is what lets Yjs document updates fan out
 * across multiple ECS tasks. Without it, each ECS task keeps an isolated
 * in-memory Y.Doc and clients on different tasks diverge.
 *
 * The construct provisions:
 * - A dedicated Redis security group that only accepts TCP 6379 from the ECS
 *   service security group (passed in as `ingressSecurityGroup`).
 * - A CfnSubnetGroup over the VPC's Private-Data subnets (the tier the shared
 *   VPC reserves for data stores like RDS/ElastiCache).
 * - A Secrets Manager secret holding the Redis AUTH token.
 * - A single-node CfnReplicationGroup (engine 'redis') with auth + encryption.
 *
 * Phase 1 is intentionally a single node (`numCacheClusters: 1`, no automatic
 * failover). Production HA — Multi-AZ + a replica, or a Serverless cache — is a
 * follow-up. The collab server tolerates a brief Redis outage by falling back to
 * per-task in-memory state, so a single node is acceptable for the initial rollout.
 *
 * Security:
 * - **AUTH token** (`authToken`) is REQUIRED: without it, any process that can
 *   reach 6379 inside the VPC security group — including a compromised co-tenant
 *   container — could read/write all Yjs CRDT state. The token is generated into
 *   Secrets Manager and injected into the ECS container as REDIS_PASSWORD. Adding
 *   auth later would require a cluster recreation (downtime), so it is wired now.
 *   Auth requires transit encryption, which is enabled.
 * - **Transit encryption** (`transitEncryptionEnabled: true`): Y.Doc CRDT updates
 *   (which may contain PII) travel over TLS.
 * - **At-rest encryption** (`atRestEncryptionEnabled: true`): persisted/snapshotted
 *   CRDT state is encrypted at rest. A standalone CfnCacheCluster cannot express
 *   either auth or at-rest encryption — that is the reason this construct uses a
 *   single-node CfnReplicationGroup rather than CfnCacheCluster.
 */
export interface RedisCacheProps {
  /**
   * The VPC the cache lives in. Use the same shared VPC the ECS service uses so
   * the security-group ingress rule and routing resolve correctly.
   */
  vpc: ec2.IVpc

  /**
   * Environment name (dev / prod). Drives the node size default and the
   * Environment tag required by the tag-based access control policy.
   */
  environment: "dev" | "prod"

  /**
   * The ECS service security group. Redis ingress on 6379 is restricted to this
   * group only — nothing else in the VPC can reach the cache.
   */
  ingressSecurityGroup: ec2.ISecurityGroup

  /**
   * Cache node type. Defaults to a small, cost-effective node for dev; callers
   * can override for prod sizing. Graviton-based t4g nodes are the cheapest
   * burstable option that supports the current Redis OSS engine.
   * @default 't4g.micro'
   */
  cacheNodeType?: string
}

export class RedisCache extends Construct {
  /**
   * The Redis primary endpoint hostname. Wire into the ECS container as
   * REDIS_HOST. This is a CloudFormation token resolved at deploy time.
   */
  public readonly endpointAddress: string

  /**
   * The Redis primary endpoint port (typically 6379). Wire into the ECS
   * container as REDIS_PORT. This is a CloudFormation token resolved at deploy
   * time.
   */
  public readonly endpointPort: string

  /**
   * The security group attached to the cache, exposed for callers that need to
   * add additional ingress sources later.
   */
  public readonly securityGroup: ec2.SecurityGroup

  /**
   * The Secrets Manager secret holding the Redis AUTH token. Inject its value
   * into the ECS container as REDIS_PASSWORD (ecs.Secret.fromSecretsManager) so
   * the collab server can authenticate to Redis. Never expose the plaintext.
   */
  public readonly authSecret: secretsmanager.Secret

  constructor(scope: Construct, id: string, props: RedisCacheProps) {
    super(scope, id)

    const { vpc, environment, ingressSecurityGroup } = props
    const cacheNodeType = props.cacheNodeType ?? "cache.t4g.micro"

    // ========================================================================
    // Security group — only the ECS service may reach Redis on 6379.
    // ========================================================================
    this.securityGroup = new ec2.SecurityGroup(this, "RedisSecurityGroup", {
      vpc,
      description: `Atrium Redis cache security group (${environment})`,
      allowAllOutbound: false,
    })

    this.securityGroup.addIngressRule(
      ingressSecurityGroup,
      ec2.Port.tcp(6379),
      "Allow Redis access from the ECS service only"
    )

    // ========================================================================
    // Subnet group — place the cache in the Private-Data subnet tier, the same
    // tier the shared VPC reserves for RDS/ElastiCache. Falls back to all
    // private-with-egress subnets if the named group is unavailable (e.g. a
    // freshly created CI VPC).
    // ========================================================================
    const dataSubnets = this.selectDataSubnets(vpc)

    const subnetGroup = new elasticache.CfnSubnetGroup(this, "RedisSubnetGroup", {
      description: `Atrium Redis subnet group (${environment})`,
      subnetIds: dataSubnets,
      cacheSubnetGroupName: `aistudio-${environment}-atrium-redis`,
    })

    // ========================================================================
    // AUTH token — generated into Secrets Manager. ElastiCache requires the
    // token to be 16–128 printable chars and to EXCLUDE these characters:
    // / @ " and whitespace. Restrict the generated set accordingly.
    // ========================================================================
    this.authSecret = new secretsmanager.Secret(this, "RedisAuthToken", {
      secretName: `aistudio-${environment}-atrium-redis-auth`,
      description: `Atrium Redis AUTH token (${environment})`,
      generateSecretString: {
        passwordLength: 64,
        // ElastiCache AUTH forbids / @ " and whitespace; also drop : to keep the
        // token URL/connection-string safe.
        excludeCharacters: '/@"\\ :',
        excludePunctuation: false,
        includeSpace: false,
      },
    })

    // ========================================================================
    // Single-node Redis replication group (Phase 1 — no replica / failover).
    // A replication group (not a bare CfnCacheCluster) is required because only
    // it supports AUTH (authToken) and at-rest encryption.
    // ========================================================================
    const cluster = new elasticache.CfnReplicationGroup(this, "RedisCluster", {
      replicationGroupDescription: `Atrium collab cache (${environment})`,
      replicationGroupId: `aistudio-${environment}-atrium`,
      engine: "redis",
      // Pin the MAJOR engine version so a CloudFormation diff doesn't silently jump
      // major versions (which can carry breaking changes) when ElastiCache rotates
      // its default. Patch/minor versions still float via autoMinorVersionUpgrade
      // below — "7.1" selects the latest 7.1.x patch line at create time.
      engineVersion: "7.1",
      cacheNodeType,
      // Single node: 1 cluster, no replicas, no automatic failover (Phase 1).
      numCacheClusters: 1,
      automaticFailoverEnabled: false,
      multiAzEnabled: false,
      securityGroupIds: [this.securityGroup.securityGroupId],
      cacheSubnetGroupName: subnetGroup.ref,
      // Apply patches in a low-traffic window; minor versions auto-upgrade.
      autoMinorVersionUpgrade: true,
      // Y.Doc CRDT updates may contain PII — enforce TLS for data in transit
      // (required for AUTH) and encrypt persisted/snapshotted state at rest.
      transitEncryptionEnabled: true,
      atRestEncryptionEnabled: true,
      // AUTH token: every connection must present this. Requires transit encryption.
      // `unsafeUnwrap()` here does NOT expose plaintext: CfnReplicationGroup.authToken
      // is a string property, and `secretValue` synthesizes to a CloudFormation
      // dynamic reference (`{{resolve:secretsmanager:<arn>:SecretString:...}}`) that
      // CFN resolves at deploy time. The secret value is never materialized at synth
      // time or written to the template — `unsafeUnwrap` only suppresses CDK's
      // unresolved-token guard for this L1 prop that has no native secret integration.
      authToken: this.authSecret.secretValue.unsafeUnwrap(),
    })
    cluster.addDependency(subnetGroup)

    // ========================================================================
    // Tags — required by the tag-based access control policy (CLAUDE.md). The
    // L1 ElastiCache resources are tagged explicitly because stack-level
    // Tags.of() does not always propagate to every Cfn* property.
    // ========================================================================
    for (const resource of [this.securityGroup, subnetGroup, cluster, this.authSecret]) {
      cdk.Tags.of(resource).add("Environment", environment)
      cdk.Tags.of(resource).add("ManagedBy", "cdk")
    }

    // CfnReplicationGroup exposes the primary endpoint via the PrimaryEndPoint
    // attributes (a bare cache cluster used RedisEndpoint.*).
    this.endpointAddress = cluster.attrPrimaryEndPointAddress
    this.endpointPort = cluster.attrPrimaryEndPointPort
  }

  /**
   * Resolve the subnet IDs for the cache. Prefer the Private-Data group; if it
   * cannot be resolved (no matching subnets), fall back to the private
   * egress-capable subnets so synth/deploy still succeeds.
   */
  private selectDataSubnets(vpc: ec2.IVpc): string[] {
    try {
      const dataSubnets = vpc.selectSubnets({ subnetGroupName: "Private-Data" })
      if (dataSubnets.subnetIds.length > 0) {
        return dataSubnets.subnetIds
      }
    } catch {
      // selectSubnets throws when the named group does not exist — fall through.
    }
    return vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    }).subnetIds
  }
}
