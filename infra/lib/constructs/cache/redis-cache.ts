import * as cdk from "aws-cdk-lib"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import * as elasticache from "aws-cdk-lib/aws-elasticache"
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
 * - A single-node CfnCacheCluster (engine 'redis').
 *
 * Phase 1 is intentionally a single node (no replication / automatic failover).
 * Production HA — a CfnReplicationGroup with Multi-AZ + a replica, or a
 * Serverless cache — is a follow-up. The collab server tolerates a brief Redis
 * outage by falling back to per-task in-memory state, so a single node is
 * acceptable for the initial rollout.
 *
 * Encryption: transit encryption is enabled (`transitEncryptionEnabled: true`)
 * so Y.Doc CRDT updates (which may contain PII) travel over TLS. At-rest
 * encryption requires migrating to CfnReplicationGroup (CfnCacheCluster does
 * not expose atRestEncryptionEnabled) — tracked as a follow-up for Phase 2 HA.
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
    // Single-node Redis cluster (Phase 1 — no replication / failover).
    // ========================================================================
    const cluster = new elasticache.CfnCacheCluster(this, "RedisCluster", {
      engine: "redis",
      cacheNodeType,
      numCacheNodes: 1,
      clusterName: `aistudio-${environment}-atrium`,
      vpcSecurityGroupIds: [this.securityGroup.securityGroupId],
      cacheSubnetGroupName: subnetGroup.ref,
      // Apply patches in a low-traffic window; minor versions auto-upgrade.
      autoMinorVersionUpgrade: true,
      // Y.Doc CRDT updates may contain PII — enforce TLS for data in transit.
      // Port stays 6379; ElastiCache TLS does not change the default port.
      transitEncryptionEnabled: true,
    })
    cluster.addDependency(subnetGroup)

    // ========================================================================
    // Tags — required by the tag-based access control policy (CLAUDE.md). The
    // L1 ElastiCache resources are tagged explicitly because stack-level
    // Tags.of() does not always propagate to every Cfn* property.
    // ========================================================================
    for (const resource of [this.securityGroup, subnetGroup, cluster]) {
      cdk.Tags.of(resource).add("Environment", environment)
      cdk.Tags.of(resource).add("ManagedBy", "cdk")
    }

    this.endpointAddress = cluster.attrRedisEndpointAddress
    this.endpointPort = cluster.attrRedisEndpointPort
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
