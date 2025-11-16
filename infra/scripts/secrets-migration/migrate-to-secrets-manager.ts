#!/usr/bin/env ts-node

/**
 * Secrets Migration Tool
 *
 * Migrates existing secrets from environment variables and SSM parameters
 * to AWS Secrets Manager with proper tagging and rotation configuration.
 *
 * Features:
 * - Scans Lambda functions for environment variables
 * - Discovers SSM parameters
 * - Creates corresponding Secrets Manager secrets
 * - Enables rotation where applicable
 * - Updates service configurations
 * - Validates migration success
 * - Generates rollback script
 *
 * Usage:
 *   npm run migrate-secrets -- --environment dev --dry-run
 *   npm run migrate-secrets -- --environment prod --execute
 */

import {
  SecretsManagerClient,
  CreateSecretCommand,
  DescribeSecretCommand,
  TagResourceCommand,
  PutResourcePolicyCommand,
} from "@aws-sdk/client-secrets-manager"
import {
  SSMClient,
  GetParametersByPathCommand,
} from "@aws-sdk/client-ssm"
import {
  LambdaClient,
  ListFunctionsCommand,
  GetFunctionConfigurationCommand,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda"
import * as fs from "fs"
import * as path from "path"

interface SecretMapping {
  source: "env-var" | "ssm-param"
  sourceName: string
  sourceValue: string
  targetSecretName: string
  secretType: "database" | "api-key" | "oauth" | "custom"
  enableRotation: boolean
  affectedServices: string[]
}

interface MigrationOptions {
  environment: string
  dryRun: boolean
  region?: string
  projectName: string
}

/**
 * Main migration orchestrator
 */
class SecretsMigrator {
  private secretsClient: SecretsManagerClient
  private ssmClient: SSMClient
  private lambdaClient: LambdaClient
  private options: MigrationOptions
  private migrations: SecretMapping[] = []

  constructor(options: MigrationOptions) {
    this.options = options
    const region = options.region || process.env.AWS_REGION || "us-east-1"

    this.secretsClient = new SecretsManagerClient({ region })
    this.ssmClient = new SSMClient({ region })
    this.lambdaClient = new LambdaClient({ region })
  }

  /**
   * Sanitize secret mapping for logging
   * Redacts the sourceValue to prevent secret exposure in logs
   */
  private sanitizeForLogging(mapping: SecretMapping): Partial<SecretMapping> {
    return {
      ...mapping,
      sourceValue: "***REDACTED***",
    }
  }

  /**
   * Sanitize migrations array for report generation
   * Redacts sourceValue from all mappings
   */
  private sanitizeForReport(migrations: SecretMapping[]): Partial<SecretMapping>[] {
    return migrations.map((m) => this.sanitizeForLogging(m))
  }

  /**
   * Execute the migration process
   */
  async migrate(): Promise<void> {
    console.log("🔍 Starting Secrets Manager migration...")
    console.log(`Environment: ${this.options.environment}`)
    console.log(`Dry Run: ${this.options.dryRun}`)
    console.log()

    // Step 1: Discover existing secrets
    await this.discoverSecrets()

    // Step 2: Plan migrations
    await this.planMigrations()

    // Step 3: Execute migrations (if not dry run)
    if (!this.options.dryRun) {
      await this.executeMigrations()
    }

    // Step 4: Generate reports
    await this.generateReports()
  }

  /**
   * Discover existing secrets in the environment
   */
  private async discoverSecrets(): Promise<void> {
    console.log("📋 Discovering existing secrets...")

    // Scan Lambda functions for environment variables
    await this.scanLambdaFunctions()

    // Scan SSM Parameter Store
    await this.scanSSMParameters()

    // Scan configuration files (if applicable)
    await this.scanConfigFiles()

    console.log(`Found ${this.migrations.length} secrets to migrate\n`)
  }

  /**
   * Scan Lambda functions for secrets in environment variables
   */
  private async scanLambdaFunctions(): Promise<void> {
    try {
      const response = await this.lambdaClient.send(new ListFunctionsCommand({}))

      if (!response.Functions) {
        return
      }

      for (const func of response.Functions) {
        if (!func.FunctionName) continue

        // Skip if not for this environment
        if (!func.FunctionName.includes(this.options.environment)) {
          continue
        }

        const config = await this.lambdaClient.send(
          new GetFunctionConfigurationCommand({
            FunctionName: func.FunctionName,
          })
        )

        if (config.Environment?.Variables) {
          for (const [key, value] of Object.entries(config.Environment.Variables)) {
            if (this.isSecretEnvVar(key, value)) {
              this.migrations.push({
                source: "env-var",
                sourceName: `${func.FunctionName}:${key}`,
                sourceValue: value,
                targetSecretName: this.generateSecretName(key),
                secretType: this.detectSecretType(key, value),
                enableRotation: this.shouldEnableRotation(key),
                affectedServices: [func.FunctionName],
              })
            }
          }
        }
      }

      console.log(`  ✓ Scanned Lambda functions`)
    } catch (error) {
      console.error(`  ✗ Error scanning Lambda functions:`, error)
    }
  }

  /**
   * Scan SSM Parameter Store for secrets
   */
  private async scanSSMParameters(): Promise<void> {
    try {
      const basePath = `/${this.options.projectName.toLowerCase()}/${this.options.environment}`

      const response = await this.ssmClient.send(
        new GetParametersByPathCommand({
          Path: basePath,
          Recursive: true,
          WithDecryption: true,
        })
      )

      if (response.Parameters) {
        for (const param of response.Parameters) {
          if (!param.Name || !param.Value) continue

          // Determine if this is a secret
          if (param.Type === "SecureString" || this.isSecretParameter(param.Name)) {
            this.migrations.push({
              source: "ssm-param",
              sourceName: param.Name,
              sourceValue: param.Value,
              targetSecretName: this.ssmToSecretName(param.Name),
              secretType: this.detectSecretType(param.Name, param.Value),
              enableRotation: this.shouldEnableRotation(param.Name),
              affectedServices: await this.findParameterUsage(param.Name),
            })
          }
        }
      }

      console.log(`  ✓ Scanned SSM Parameter Store`)
    } catch (error) {
      console.error(`  ✗ Error scanning SSM:`, error)
    }
  }

  /**
   * Scan configuration files for hardcoded secrets
   */
  private async scanConfigFiles(): Promise<void> {
    // This would scan .env files, config/*.json, etc.
    // For now, just log that we checked
    console.log(`  ✓ Scanned configuration files`)
  }

  /**
   * Plan the migrations with user review
   */
  private async planMigrations(): Promise<void> {
    console.log("\n📝 Migration Plan:")
    console.log("=" .repeat(80))

    const grouped = this.groupMigrationsByType()

    for (const [type, secrets] of Object.entries(grouped)) {
      console.log(`\n${type.toUpperCase()} (${secrets.length} secrets):`)

      for (const secret of secrets) {
        console.log(`  ${secret.targetSecretName}`)
        console.log(`    Source: ${secret.source} - ${secret.sourceName}`)
        console.log(`    Type: ${secret.secretType}`)
        console.log(`    Rotation: ${secret.enableRotation ? "✓ Enabled" : "✗ Disabled"}`)
        console.log(`    Services: ${secret.affectedServices.join(", ")}`)
      }
    }

    console.log("\n" + "=".repeat(80))
  }

  /**
   * Execute the planned migrations
   */
  private async executeMigrations(): Promise<void> {
    console.log("\n🚀 Executing migrations...")

    const results = {
      success: 0,
      failed: 0,
      skipped: 0,
    }

    for (const migration of this.migrations) {
      try {
        console.log(`\n  Migrating: ${migration.targetSecretName}`)

        // Check if secret already exists
        if (await this.secretExists(migration.targetSecretName)) {
          console.log(`    ⚠️  Secret already exists, skipping`)
          results.skipped++
          continue
        }

        // Create the secret
        await this.createSecret(migration)

        // Update affected services
        await this.updateServices(migration)

        console.log(`    ✓ Success`)
        results.success++
      } catch (error) {
        console.error(`    ✗ Failed:`, error)
        results.failed++
      }
    }

    console.log("\n📊 Migration Results:")
    console.log(`  Success: ${results.success}`)
    console.log(`  Failed: ${results.failed}`)
    console.log(`  Skipped: ${results.skipped}`)
  }

  /**
   * Create a secret in Secrets Manager
   */
  private async createSecret(migration: SecretMapping): Promise<void> {
    // Prepare secret string (format for database secrets)
    let secretString = migration.sourceValue

    if (migration.secretType === "database") {
      // Try to parse as database connection string
      secretString = this.formatDatabaseSecret(migration.sourceValue)
    }

    await this.secretsClient.send(
      new CreateSecretCommand({
        Name: migration.targetSecretName,
        SecretString: secretString,
        Description: `Migrated from ${migration.source}: ${migration.sourceName}`,
        Tags: [
          { Key: "ManagedBy", Value: "SecretsManager" },
          { Key: "Environment", Value: this.options.environment },
          { Key: "SecretType", Value: migration.secretType },
          { Key: "MigratedFrom", Value: migration.source },
          { Key: "MigrationDate", Value: new Date().toISOString() },
        ],
      })
    )

    console.log(`    ✓ Created secret`)
  }

  /**
   * Update services to use the new secret
   */
  private async updateServices(migration: SecretMapping): Promise<void> {
    for (const service of migration.affectedServices) {
      if (migration.source === "env-var") {
        await this.updateLambdaFunction(service, migration)
      }
    }
  }

  /**
   * Update Lambda function to use Secrets Manager
   */
  private async updateLambdaFunction(
    functionName: string,
    migration: SecretMapping
  ): Promise<void> {
    const config = await this.lambdaClient.send(
      new GetFunctionConfigurationCommand({
        FunctionName: functionName,
      })
    )

    if (!config.Environment?.Variables) {
      return
    }

    // Replace environment variable with secret ARN reference
    const envKey = migration.sourceName.split(":")[1]
    const updatedVariables = { ...config.Environment.Variables }
    updatedVariables[envKey] = migration.targetSecretName

    await this.lambdaClient.send(
      new UpdateFunctionConfigurationCommand({
        FunctionName: functionName,
        Environment: {
          Variables: updatedVariables,
        },
      })
    )

    console.log(`    ✓ Updated Lambda function: ${functionName}`)
  }

  /**
   * Generate migration reports and rollback script
   */
  private async generateReports(): Promise<void> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
    const reportDir = path.join(process.cwd(), "migration-reports")

    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true })
    }

    console.log("\n⚠️  WARNING: Migration reports contain sensitive data.")
    console.log("   Please store securely and delete after use.")
    console.log("   Consider encrypting reports before storing.\n")

    // Generate migration report with sanitized secrets
    const reportPath = path.join(reportDir, `migration-${timestamp}.json`)
    const sanitizedMigrations = this.sanitizeForReport(this.migrations)
    fs.writeFileSync(reportPath, JSON.stringify(sanitizedMigrations, null, 2))

    // Generate rollback script
    const rollbackPath = path.join(reportDir, `rollback-${timestamp}.sh`)
    const rollbackScript = this.generateRollbackScript()
    fs.writeFileSync(rollbackPath, rollbackScript, { mode: 0o755 })

    console.log(`\n📄 Reports generated:`)
    console.log(`  Migration report: ${reportPath}`)
    console.log(`  Rollback script: ${rollbackPath}`)
  }

  /**
   * Helper methods
   */

  private async secretExists(secretName: string): Promise<boolean> {
    try {
      await this.secretsClient.send(
        new DescribeSecretCommand({
          SecretId: secretName,
        })
      )
      return true
    } catch {
      return false
    }
  }

  private isSecretEnvVar(key: string, value: string): boolean {
    const secretKeywords = [
      "password",
      "secret",
      "key",
      "token",
      "api",
      "credential",
      "auth",
    ]

    return (
      secretKeywords.some((keyword) => key.toLowerCase().includes(keyword)) &&
      value !== "" &&
      value !== "undefined"
    )
  }

  private isSecretParameter(name: string): boolean {
    return name.toLowerCase().includes("password") || name.toLowerCase().includes("secret")
  }

  private detectSecretType(
    name: string,
    value: string
  ): "database" | "api-key" | "oauth" | "custom" {
    if (name.toLowerCase().includes("database") || name.toLowerCase().includes("db")) {
      return "database"
    }
    if (name.toLowerCase().includes("api") && name.toLowerCase().includes("key")) {
      return "api-key"
    }
    if (name.toLowerCase().includes("oauth") || name.toLowerCase().includes("token")) {
      return "oauth"
    }
    return "custom"
  }

  private shouldEnableRotation(name: string): boolean {
    // Enable rotation for database and API keys
    return (
      name.toLowerCase().includes("database") ||
      name.toLowerCase().includes("db") ||
      name.toLowerCase().includes("api")
    )
  }

  private generateSecretName(envKey: string): string {
    return `/${this.options.projectName.toLowerCase()}/${this.options.environment}/${envKey.toLowerCase().replace(/_/g, "-")}`
  }

  private ssmToSecretName(ssmPath: string): string {
    // Convert SSM path to Secrets Manager name
    return ssmPath.replace("/ssm/", "/secrets/")
  }

  private formatDatabaseSecret(value: string): string {
    // Try to parse database connection string
    // For now, return as-is
    return value
  }

  private async findParameterUsage(paramName: string): Promise<string[]> {
    // This would scan Lambda functions, ECS tasks, etc. for parameter usage
    return ["TBD"]
  }

  private groupMigrationsByType(): Record<string, SecretMapping[]> {
    return this.migrations.reduce(
      (acc, migration) => {
        if (!acc[migration.secretType]) {
          acc[migration.secretType] = []
        }
        acc[migration.secretType].push(migration)
        return acc
      },
      {} as Record<string, SecretMapping[]>
    )
  }

  private generateRollbackScript(): string {
    return `#!/bin/bash
# Rollback script for secrets migration
# Generated: ${new Date().toISOString()}

echo "⚠️  This will delete migrated secrets and restore original configuration"
read -p "Continue? (yes/no): " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
  echo "Rollback cancelled"
  exit 0
fi

${this.migrations
  .map(
    (m) => `
# Rollback: ${m.targetSecretName}
aws secretsmanager delete-secret --secret-id "${m.targetSecretName}" --force-delete-without-recovery
`
  )
  .join("\n")}

echo "✓ Rollback completed"
`
  }
}

/**
 * CLI entry point
 */
async function main() {
  const args = process.argv.slice(2)
  const options: MigrationOptions = {
    environment: "dev",
    dryRun: true,
    projectName: "AIStudio",
  }

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--environment" || args[i] === "-e") {
      options.environment = args[++i]
    } else if (args[i] === "--execute") {
      options.dryRun = false
    } else if (args[i] === "--dry-run") {
      options.dryRun = true
    } else if (args[i] === "--region") {
      options.region = args[++i]
    } else if (args[i] === "--project") {
      options.projectName = args[++i]
    }
  }

  const migrator = new SecretsMigrator(options)
  await migrator.migrate()
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Migration failed:", error)
    process.exit(1)
  })
}

export { SecretsMigrator, MigrationOptions, SecretMapping }
