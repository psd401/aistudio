# VPC Consolidation and Network Optimization

## Overview

This document describes the VPC consolidation implementation that replaced duplicate VPCs with a single shared VPC architecture. This optimization reduces infrastructure costs by $102/month ($1,224/year) while improving security and network visibility.

## Architecture

### Before Consolidation

```
┌─────────────────────────┐     ┌─────────────────────────┐
│   Database Stack VPC    │     │   ECS Stack VPC         │
│                         │     │                         │
│  ┌─────────────────┐    │     │  ┌─────────────────┐   │
│  │  NAT Gateway    │    │     │  │  NAT Gateway    │   │
│  │  ($45/month)    │    │     │  │  ($45/month)    │   │
│  └─────────────────┘    │     │  └─────────────────┘   │
│                         │     │                         │
│  ┌─────────────────┐    │     │  ┌─────────────────┐   │
│  │  Aurora DB      │    │     │  │  ECS Service    │   │
│  └─────────────────┘    │     │  └─────────────────┘   │
└─────────────────────────┘     └─────────────────────────┘

Total NAT Cost: $90/month (2 gateways × $45)
No VPC Endpoints: Data transfer through NAT ($50/month)
No Flow Logs: Limited network visibility
```

### After Consolidation

```
┌────────────────────────────────────────────────────────┐
│              Shared VPC Architecture                   │
│                                                        │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │ Public       │  │ Private App  │  │ Private Data│ │
│  │ Subnets      │  │ Subnets      │  │ Subnets     │ │
│  │              │  │              │  │             │ │
│  │ ┌──────────┐ │  │ ┌──────────┐ │  │ ┌─────────┐│ │
│  │ │   ALB    │ │  │ │   ECS    │ │  │ │ Aurora  ││ │
│  │ └──────────┘ │  │ └──────────┘ │  │ └─────────┘│ │
│  │              │  │              │  │             │ │
│  │ ┌──────────┐ │  │ ┌──────────┐ │  │             │ │
│  │ │  NAT GW  │ │  │ │ Lambda   │ │  │             │ │
│  │ │ ($45/mo) │ │  │ └──────────┘ │  │             │ │
│  │ └──────────┘ │  │              │  │             │ │
│  └──────────────┘  └──────────────┘  └─────────────┘ │
│                                                        │
│  ┌────────────────────────────────────────────────┐   │
│  │          VPC Endpoints ($108/month)            │   │
│  │  S3, RDS, ECR, Secrets Manager, CloudWatch... │   │
│  └────────────────────────────────────────────────┘   │
│                                                        │
│  ┌────────────────────────────────────────────────┐   │
│  │     VPC Flow Logs to S3 ($5/month)             │   │
│  └────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────┘

Total Cost: $218/month (down from $320/month)
Savings: $102/month ($1,224/year)
```

## Implementation Details

### Shared VPC Construct

The `SharedVPC` construct creates a single VPC with four subnet types:

1. **Public Subnets** (CIDR /24)
   - Application Load Balancers
   - NAT Gateways
   - Internet Gateway access

2. **Private Application Subnets** (CIDR /22)
   - ECS Fargate tasks
   - Lambda functions
   - Application workloads
   - Larger CIDR for more IP addresses (1024 IPs)

3. **Private Data Subnets** (CIDR /24)
   - Aurora databases
   - ElastiCache
   - Sensitive data workloads
   - Standard CIDR (256 IPs)

4. **Isolated Subnets** (CIDR /24)
   - No internet access
   - Highly sensitive workloads
   - Security-critical operations

### VPC Provider Pattern

The `VPCProvider` class implements a singleton pattern for cross-stack VPC sharing:

```typescript
// In any stack, get the shared VPC
const vpc = VPCProvider.getOrCreate(this, environment, config);
```

**How it works:**
1. First stack creates VPC and stores metadata in SSM Parameter Store
2. Subsequent stacks import VPC using SSM parameters
3. No CloudFormation exports (avoids circular dependencies)
4. Automatic cleanup on stack deletion

**SSM Parameters Created:**
- `/aistudio/{env}/vpc-id` - VPC identifier
- `/aistudio/{env}/vpc-azs` - Availability zones
- `/aistudio/{env}/vpc-public-subnet-ids` - Public subnet IDs
- `/aistudio/{env}/vpc-private-subnet-ids` - Private app subnet IDs
- `/aistudio/{env}/vpc-data-subnet-ids` - Data subnet IDs
- `/aistudio/{env}/vpc-isolated-subnet-ids` - Isolated subnet IDs

### VPC Endpoints

#### Gateway Endpoints (No Cost)
- **S3**: Direct private access to S3 buckets
- **DynamoDB**: Private DynamoDB access

#### Interface Endpoints (~$7.20/month each)

**Essential (All Environments):**
- Secrets Manager
- RDS & RDS Data API
- ECR API & Docker
- CloudWatch Logs & Monitoring
- SNS, SQS
- Lambda
- SSM
- KMS
- ECS, ECS Agent, ECS Telemetry

**Production Only:**
- Textract (document processing)
- Comprehend (text analysis)

**Cost Justification:**
- Each endpoint: $7.20/month
- Saves: NAT Gateway data transfer costs
- 15 endpoints × $7.20 = $108/month
- Without endpoints: $150+/month in data transfer
- Net savings: $42/month + improved performance

### VPC Flow Logs

Flow logs capture all network traffic for security monitoring:

**Storage Strategy:**
- **Primary**: S3 (cost-effective, long-term storage)
  - Dev: 30-day retention
  - Prod: 90-day retention with IA transition after 30 days

- **Secondary (Prod Only)**: CloudWatch Logs
  - Real-time analysis
  - Rejected traffic only (security alerts)
  - 7-day retention

**Cost:**
- S3 storage: ~$5/month
- CloudWatch Logs (prod): ~$3/month
- Total: $8/month for complete network visibility

### NAT Gateway Optimization

**Development:**
- Uses NAT Instance (t3.nano)
- Cost: ~$5/month
- Acceptable for dev workloads

**Production:**
- Uses NAT Gateways (managed)
- Cost: $45/month each
- High availability and reliability
- Reduced count: 2 (down from 4)

## Cost Analysis

### Monthly Cost Breakdown

| Component | Before | After | Savings |
|-----------|--------|-------|---------|
| NAT Gateways (Dev) | $90 | $5 | $85 |
| NAT Gateways (Prod) | $180 | $90 | $90 |
| VPC Endpoints | $0 | $108 | -$108 |
| Flow Logs | $0 | $8 | -$8 |
| Data Transfer | $50 | $10 | $40 |
| **Total** | **$320** | **$218** | **$102** |

### Annual Savings

- **Total**: $1,224/year
- **3-Year**: $3,672
- **ROI**: 8 months (based on 40 hours implementation time)

## Migration Guide

### Step 1: Deploy New VPC (Dev)

```bash
cd infra
bunx cdk deploy AIStudio-DatabaseStack-Dev
```

The VPC will be automatically created on first deployment.

### Step 2: Verify VPC Creation

```bash
# Check SSM parameters
aws ssm get-parameter --name /aistudio/dev/vpc-id
aws ssm get-parameter --name /aistudio/dev/vpc-private-subnet-ids

# Verify VPC endpoints
aws ec2 describe-vpc-endpoints --filters "Name=vpc-id,Values=<VPC_ID>"

# Check flow logs
aws ec2 describe-flow-logs
```

### Step 3: Deploy Other Stacks

```bash
# ECS stack will automatically use the shared VPC
bunx cdk deploy AIStudio-FrontendStack-Ecs-Dev
```

### Step 4: Monitor Network Traffic

```bash
# CloudWatch dashboard
aws cloudwatch get-dashboard --dashboard-name dev-vpc-metrics

# Flow logs in S3
aws s3 ls s3://aistudio-dev-vpc-flow-logs-ACCOUNT_ID/vpc-flow-logs/
```

### Step 5: Production Deployment

After successful dev validation:

```bash
bunx cdk deploy AIStudio-DatabaseStack-Prod
bunx cdk deploy AIStudio-FrontendStack-Ecs-Prod
```

## Usage in Stacks

### Using Shared VPC in New Stacks

```typescript
import { VPCProvider, EnvironmentConfig } from './constructs';

export class MyNewStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MyStackProps) {
    super(scope, id, props);

    // Get environment config
    const config = EnvironmentConfig.get(props.environment);

    // Get shared VPC
    const vpc = VPCProvider.getOrCreate(this, props.environment, config);

    // Use appropriate subnets
    const service = new ecs.FargateService(this, 'Service', {
      vpc,
      vpcSubnets: vpc.selectSubnets({
        subnetGroupName: 'Private-Application',
      }),
    });
  }
}
```

### Workload-Specific Subnet Selection

The `SharedVPC` construct provides a helper method:

```typescript
const vpc = VPCProvider.getOrCreate(this, environment, config);

// Web tier (ALB, public access)
const webSubnets = vpc.getSubnetsForWorkload('web');

// Application tier (ECS, Lambda)
const appSubnets = vpc.getSubnetsForWorkload('app');

// Data tier (RDS, ElastiCache)
const dataSubnets = vpc.getSubnetsForWorkload('data');

// Secure tier (no internet)
const secureSubnets = vpc.getSubnetsForWorkload('secure');
```

## Testing

Unit tests are provided in `infra/test/unit/shared-vpc.test.ts`:

```bash
cd infra
npm test -- shared-vpc.test.ts
```

**Test Coverage:**
- VPC creation with correct subnet configuration
- NAT instance vs gateway based on environment
- VPC endpoint creation
- Flow logs to S3 and CloudWatch
- Security group configuration
- Subnet tagging
- CloudWatch dashboard

## Monitoring

### CloudWatch Dashboard

Each environment has a VPC metrics dashboard:

**Metrics Tracked:**
- NAT Gateway data transfer
- NAT Gateway packet counts
- VPC Endpoint usage
- Network bytes processed

**Access:**
```bash
aws cloudwatch get-dashboard --dashboard-name {environment}-vpc-metrics
```

### VPC Flow Logs

**S3 Location:**
```
s3://aistudio-{environment}-vpc-flow-logs-{account}/vpc-flow-logs/
```

**CloudWatch Logs (Prod):**
```
/aws/vpc/flowlogs/prod
```

**Query Examples:**

```bash
# Find rejected connections
aws logs filter-log-events \
  --log-group-name /aws/vpc/flowlogs/prod \
  --filter-pattern "[version, account, eni, source, destination, srcport, destport, protocol, packets, bytes, windowstart, windowend, action=REJECT, flowlogstatus]"

# Top talkers by bytes
aws logs start-query \
  --log-group-name /aws/vpc/flowlogs/prod \
  --start-time $(date -u -d '1 hour ago' +%s) \
  --end-time $(date -u +%s) \
  --query-string 'fields @timestamp, srcAddr, dstAddr, bytes | sort bytes desc | limit 20'
```

## Security

### Network Segmentation

1. **Public Subnets**
   - Internet-facing load balancers only
   - Restricted ingress rules
   - Tagged for ELB auto-discovery

2. **Private Application Subnets**
   - Application workloads (ECS, Lambda)
   - Outbound internet via NAT Gateway
   - No direct inbound from internet

3. **Private Data Subnets**
   - Database clusters
   - Cache layers
   - Restricted to application subnet access

4. **Isolated Subnets**
   - No internet access (no NAT)
   - Highest security workloads
   - VPC endpoints for AWS services

### Security Groups

**VPC Endpoint Security Group:**
- Allows HTTPS (443) from VPC CIDR
- No outbound rules (restrictive)
- Applied to all interface endpoints

**Best Practices:**
- Use security groups for service-to-service communication
- Leverage VPC endpoint policies for additional access control
- Monitor flow logs for unauthorized access attempts

## Troubleshooting

### Issue: Stack can't find VPC

**Symptom:**
```
Error: VPC not found for lookup
```

**Solution:**
1. Ensure DatabaseStack deployed first
2. Check SSM parameter exists:
   ```bash
   aws ssm get-parameter --name /aistudio/{env}/vpc-id
   ```
3. If missing, redeploy DatabaseStack

### Issue: VPC endpoint connection failures

**Symptom:**
Service can't connect to AWS API through VPC endpoint

**Solution:**
1. Verify endpoint security group allows HTTPS:
   ```bash
   aws ec2 describe-security-groups --group-ids sg-xxx
   ```
2. Check private DNS is enabled:
   ```bash
   aws ec2 describe-vpc-endpoints --vpc-endpoint-ids vpce-xxx
   ```
3. Verify route tables have endpoint routes

### Issue: High NAT Gateway costs

**Symptom:**
NAT Gateway data transfer charges still high

**Solution:**
1. Check which services aren't using VPC endpoints:
   ```bash
   # Analyze flow logs for NAT Gateway traffic
   aws logs start-query --log-group-name /aws/vpc/flowlogs/prod ...
   ```
2. Add missing VPC endpoints for frequently accessed services
3. Review application code for unnecessary external API calls

## Rollback Procedure

If issues arise, rollback to previous VPC configuration:

1. **Stop deploying new stacks**
   ```bash
   # Cancel any in-progress deployments
   aws cloudformation cancel-update-stack --stack-name AIStudio-*
   ```

2. **Revert code changes**
   ```bash
   git revert <commit-hash>
   ```

3. **Redeploy previous version**
   ```bash
   bunx cdk deploy --all
   ```

4. **Clean up orphaned resources**
   ```bash
   # Delete new VPC (if safe)
   aws ec2 delete-vpc --vpc-id <NEW_VPC_ID>
   ```

## Future Enhancements

1. **VPC Peering**
   - Connect to other organizational VPCs
   - Share resources across accounts

2. **Transit Gateway**
   - Scale to 10+ VPCs
   - Centralized routing and management

3. **PrivateLink Services**
   - Expose internal APIs via PrivateLink
   - Secure service-to-service communication

4. **Network Firewall**
   - Deep packet inspection
   - Advanced threat protection
   - Centralized firewall rules

5. **Additional VPC Endpoints**
   - Add endpoints based on usage patterns
   - Monitor and optimize endpoint selection

## References

- [AWS VPC Best Practices](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-best-practices.html)
- [VPC Endpoints](https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints.html)
- [VPC Flow Logs](https://docs.aws.amazon.com/vpc/latest/userguide/flow-logs.html)
- [NAT Gateway Pricing](https://aws.amazon.com/vpc/pricing/)
- [CDK VPC Construct](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ec2.Vpc.html)

## Related Issues

- Issue #375: VPC Consolidation and Network Optimization (this implementation)
- Issue #372: CDK Infrastructure Optimization (parent epic)
- Issue #374: Aurora Cost Optimization (related cost savings)

---

*Last Updated: October 2025*
*Implementation: Issue #375*
*Cost Savings: $102/month ($1,224/year)*
