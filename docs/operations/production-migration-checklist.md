# Production VPC Consolidation Migration - Quick Checklist

**Environment:** Production
**Snapshot ID:** `<to-be-created>`
**Estimated Downtime:** 30-45 minutes
**Rollback Time:** 15-20 minutes

## Pre-Migration (Do in advance)

- [ ] Schedule maintenance window (weekend/off-hours recommended)
- [ ] Notify users of planned downtime
- [ ] Create database snapshot:
  ```bash
  aws rds create-db-cluster-snapshot \
    --db-cluster-identifier aistudio-prod-cluster \
    --db-cluster-snapshot-identifier pre-vpc-migration-$(date +%Y%m%d-%H%M%S)
  ```
- [ ] Wait for snapshot to complete (check status)
- [ ] Record snapshot ID for migration
- [ ] Verify dev migration was successful
- [ ] Review and test rollback procedures

## Migration Day

### Phase 1: Destroy Existing Stacks (10 minutes)

```bash
cd infra

# Destroy in reverse dependency order
bunx cdk destroy AIStudio-FrontendStack-ECS-Prod --force
bunx cdk destroy AIStudio-DocumentProcessingStack-Prod --force
bunx cdk destroy AIStudio-SchedulerStack-Prod --force
bunx cdk destroy AIStudio-DatabaseStack-Prod --force
```

**Clean up orphaned resources:**
```bash
aws logs delete-log-group --log-group-name /aws/lambda/vpc-ssm-cleanup-provider-prod
aws logs delete-log-group --log-group-name /aws/lambda/db-init-provider-prod
```

### Phase 2: Deploy Database Stack (15 minutes)

```bash
bunx cdk deploy AIStudio-DatabaseStack-Prod \
  --context snapshotIdentifier=<YOUR-SNAPSHOT-ID> \
  --require-approval never
```

**Update database credentials:**
```bash
SECRET_ARN=$(aws ssm get-parameter --name /aistudio/prod/db-secret-arn --query 'Parameter.Value' --output text)
NEW_PASSWORD=$(aws secretsmanager get-secret-value --secret-id $SECRET_ARN --query 'SecretString' --output text | jq -r '.password')

aws rds modify-db-cluster \
  --db-cluster-identifier aistudio-prod-cluster \
  --master-user-password "$NEW_PASSWORD" \
  --apply-immediately

# Wait ~60 seconds for credential reset
```

**Verify database:**
```bash
CLUSTER_ARN=$(aws ssm get-parameter --name /aistudio/prod/db-cluster-arn --query 'Parameter.Value' --output text)
SECRET_ARN=$(aws ssm get-parameter --name /aistudio/prod/db-secret-arn --query 'Parameter.Value' --output text)

# Test connectivity
aws rds-data execute-statement \
  --resource-arn "$CLUSTER_ARN" \
  --secret-arn "$SECRET_ARN" \
  --database "aistudio" \
  --sql "SELECT COUNT(*) FROM users;"
```

### Phase 3: Deploy Application Stacks (20 minutes)

```bash
# Deploy Scheduler Stack
bunx cdk deploy AIStudio-SchedulerStack-Prod \
  --context snapshotIdentifier=<YOUR-SNAPSHOT-ID> \
  --require-approval never

# Deploy Document Processing Stack
bunx cdk deploy AIStudio-DocumentProcessingStack-Prod \
  --context snapshotIdentifier=<YOUR-SNAPSHOT-ID> \
  --require-approval never

# Deploy Frontend Stack (this builds and pushes Docker image)
bunx cdk deploy AIStudio-FrontendStack-ECS-Prod \
  --context snapshotIdentifier=<YOUR-SNAPSHOT-ID> \
  --context baseDomain=aistudio.psd401.ai \
  --require-approval never
```

### Phase 4: Verification (5 minutes)

**Check ECS service:**
```bash
aws ecs describe-services \
  --cluster aistudio-prod \
  --services aistudio-prod \
  --query 'services[0].{Status:status,Running:runningCount,Desired:desiredCount}'
```

**Verify data integrity:**
```bash
# Check critical data counts
aws rds-data execute-statement \
  --resource-arn "$CLUSTER_ARN" \
  --secret-arn "$SECRET_ARN" \
  --database "aistudio" \
  --sql "SELECT COUNT(*) FROM users;"

aws rds-data execute-statement \
  --resource-arn "$CLUSTER_ARN" \
  --secret-arn "$SECRET_ARN" \
  --database "aistudio" \
  --sql "SELECT COUNT(*) FROM nexus_conversations;"
```

**Manual application testing:**
- [ ] Access application URL: https://aistudio.psd401.ai
- [ ] Test login with Cognito
- [ ] Create a test conversation
- [ ] Upload a test document
- [ ] Create a test scheduled execution
- [ ] Verify all features work as expected

### Phase 5: Monitor (First 24 hours)

**CloudWatch dashboards:**
- [ ] Check ECS dashboard: `aistudio-ecs-prod`
- [ ] Monitor Aurora metrics for performance issues
- [ ] Watch for errors in CloudWatch Logs

**Key metrics to watch:**
```bash
# ECS task health
aws ecs describe-services --cluster aistudio-prod --services aistudio-prod

# Database cluster status
aws rds describe-db-clusters --db-cluster-identifier aistudio-prod-cluster

# View application logs
aws logs tail /ecs/aistudio-prod --follow
```

## Rollback Procedure (If Needed)

If critical issues occur within first hour:

1. **Restore from snapshot to new cluster:**
   ```bash
   aws rds restore-db-cluster-from-snapshot \
     --db-cluster-identifier aistudio-prod-cluster-rollback \
     --snapshot-identifier <ORIGINAL-SNAPSHOT-ID> \
     --engine aurora-postgresql \
     --engine-version 15.12
   ```

2. **Checkout previous commit:**
   ```bash
   git checkout <commit-before-vpc-consolidation>
   ```

3. **Redeploy old stacks:**
   ```bash
   cd infra
   bunx cdk deploy --all --require-approval never
   ```

## Post-Migration Tasks

- [ ] Update team documentation with new endpoints
- [ ] Archive migration documentation
- [ ] Remove maintenance window notification
- [ ] Monitor for 1 week before considering migration complete
- [ ] Update runbooks with new infrastructure details

## Critical Information

**Application URL:** https://aistudio.psd401.ai

**Key ARNs (after migration):**
- Database: `/aistudio/prod/db-cluster-arn` (SSM)
- Secret: `/aistudio/prod/db-secret-arn` (SSM)
- Internal API Secret: `/aistudio/prod/internal-api-secret-arn` (SSM)

**Support Contacts:**
- Primary: Kris Hagel (CIO)
- Escalation: TSD Engineering Team

## Success Criteria

Migration is successful when:
- [ ] All 4 stacks deployed without errors
- [ ] ECS service shows 2+ running tasks (prod uses multi-AZ)
- [ ] Database shows "available" status
- [ ] Application accessible via HTTPS
- [ ] Authentication works
- [ ] All data counts match pre-migration
- [ ] No critical errors in logs for 1 hour
- [ ] Users can perform all core functions
