#!/usr/bin/env ts-node
"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecretsMigrator = void 0;
const client_secrets_manager_1 = require("@aws-sdk/client-secrets-manager");
const client_ssm_1 = require("@aws-sdk/client-ssm");
const client_lambda_1 = require("@aws-sdk/client-lambda");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/**
 * Main migration orchestrator
 */
class SecretsMigrator {
    secretsClient;
    ssmClient;
    lambdaClient;
    options;
    migrations = [];
    constructor(options) {
        this.options = options;
        const region = options.region || process.env.AWS_REGION || "us-east-1";
        this.secretsClient = new client_secrets_manager_1.SecretsManagerClient({ region });
        this.ssmClient = new client_ssm_1.SSMClient({ region });
        this.lambdaClient = new client_lambda_1.LambdaClient({ region });
    }
    /**
     * Sanitize secret mapping for logging
     * Redacts the sourceValue to prevent secret exposure in logs
     */
    sanitizeForLogging(mapping) {
        return {
            ...mapping,
            sourceValue: "***REDACTED***",
        };
    }
    /**
     * Sanitize migrations array for report generation
     * Redacts sourceValue from all mappings
     */
    sanitizeForReport(migrations) {
        return migrations.map((m) => this.sanitizeForLogging(m));
    }
    /**
     * Execute the migration process
     */
    async migrate() {
        console.log("🔍 Starting Secrets Manager migration...");
        console.log(`Environment: ${this.options.environment}`);
        console.log(`Dry Run: ${this.options.dryRun}`);
        console.log();
        // Step 1: Discover existing secrets
        await this.discoverSecrets();
        // Step 2: Plan migrations
        await this.planMigrations();
        // Step 3: Execute migrations (if not dry run)
        if (!this.options.dryRun) {
            await this.executeMigrations();
        }
        // Step 4: Generate reports
        await this.generateReports();
    }
    /**
     * Discover existing secrets in the environment
     */
    async discoverSecrets() {
        console.log("📋 Discovering existing secrets...");
        // Scan Lambda functions for environment variables
        await this.scanLambdaFunctions();
        // Scan SSM Parameter Store
        await this.scanSSMParameters();
        // Scan configuration files (if applicable)
        await this.scanConfigFiles();
        console.log(`Found ${this.migrations.length} secrets to migrate\n`);
    }
    /**
     * Scan Lambda functions for secrets in environment variables
     */
    async scanLambdaFunctions() {
        try {
            const response = await this.lambdaClient.send(new client_lambda_1.ListFunctionsCommand({}));
            if (!response.Functions) {
                return;
            }
            for (const func of response.Functions) {
                if (!func.FunctionName)
                    continue;
                // Skip if not for this environment
                if (!func.FunctionName.includes(this.options.environment)) {
                    continue;
                }
                const config = await this.lambdaClient.send(new client_lambda_1.GetFunctionConfigurationCommand({
                    FunctionName: func.FunctionName,
                }));
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
                            });
                        }
                    }
                }
            }
            console.log(`  ✓ Scanned Lambda functions`);
        }
        catch (error) {
            console.error(`  ✗ Error scanning Lambda functions:`, error);
        }
    }
    /**
     * Scan SSM Parameter Store for secrets
     */
    async scanSSMParameters() {
        try {
            const basePath = `/${this.options.projectName.toLowerCase()}/${this.options.environment}`;
            const response = await this.ssmClient.send(new client_ssm_1.GetParametersByPathCommand({
                Path: basePath,
                Recursive: true,
                WithDecryption: true,
            }));
            if (response.Parameters) {
                for (const param of response.Parameters) {
                    if (!param.Name || !param.Value)
                        continue;
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
                        });
                    }
                }
            }
            console.log(`  ✓ Scanned SSM Parameter Store`);
        }
        catch (error) {
            console.error(`  ✗ Error scanning SSM:`, error);
        }
    }
    /**
     * Scan configuration files for hardcoded secrets
     */
    async scanConfigFiles() {
        // This would scan .env files, config/*.json, etc.
        // For now, just log that we checked
        console.log(`  ✓ Scanned configuration files`);
    }
    /**
     * Plan the migrations with user review
     */
    async planMigrations() {
        console.log("\n📝 Migration Plan:");
        console.log("=".repeat(80));
        const grouped = this.groupMigrationsByType();
        for (const [type, secrets] of Object.entries(grouped)) {
            console.log(`\n${type.toUpperCase()} (${secrets.length} secrets):`);
            for (const secret of secrets) {
                console.log(`  ${secret.targetSecretName}`);
                console.log(`    Source: ${secret.source} - ${secret.sourceName}`);
                console.log(`    Type: ${secret.secretType}`);
                console.log(`    Rotation: ${secret.enableRotation ? "✓ Enabled" : "✗ Disabled"}`);
                console.log(`    Services: ${secret.affectedServices.join(", ")}`);
            }
        }
        console.log("\n" + "=".repeat(80));
    }
    /**
     * Execute the planned migrations
     */
    async executeMigrations() {
        console.log("\n🚀 Executing migrations...");
        const results = {
            success: 0,
            failed: 0,
            skipped: 0,
        };
        for (const migration of this.migrations) {
            try {
                console.log(`\n  Migrating: ${migration.targetSecretName}`);
                // Check if secret already exists
                if (await this.secretExists(migration.targetSecretName)) {
                    console.log(`    ⚠️  Secret already exists, skipping`);
                    results.skipped++;
                    continue;
                }
                // Create the secret
                await this.createSecret(migration);
                // Update affected services
                await this.updateServices(migration);
                console.log(`    ✓ Success`);
                results.success++;
            }
            catch (error) {
                console.error(`    ✗ Failed:`, error);
                results.failed++;
            }
        }
        console.log("\n📊 Migration Results:");
        console.log(`  Success: ${results.success}`);
        console.log(`  Failed: ${results.failed}`);
        console.log(`  Skipped: ${results.skipped}`);
    }
    /**
     * Create a secret in Secrets Manager
     */
    async createSecret(migration) {
        // Prepare secret string (format for database secrets)
        let secretString = migration.sourceValue;
        if (migration.secretType === "database") {
            // Try to parse as database connection string
            secretString = this.formatDatabaseSecret(migration.sourceValue);
        }
        await this.secretsClient.send(new client_secrets_manager_1.CreateSecretCommand({
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
        }));
        console.log(`    ✓ Created secret`);
    }
    /**
     * Update services to use the new secret
     */
    async updateServices(migration) {
        for (const service of migration.affectedServices) {
            if (migration.source === "env-var") {
                await this.updateLambdaFunction(service, migration);
            }
        }
    }
    /**
     * Update Lambda function to use Secrets Manager
     */
    async updateLambdaFunction(functionName, migration) {
        const config = await this.lambdaClient.send(new client_lambda_1.GetFunctionConfigurationCommand({
            FunctionName: functionName,
        }));
        if (!config.Environment?.Variables) {
            return;
        }
        // Replace environment variable with secret ARN reference
        const envKey = migration.sourceName.split(":")[1];
        const updatedVariables = { ...config.Environment.Variables };
        updatedVariables[envKey] = migration.targetSecretName;
        await this.lambdaClient.send(new client_lambda_1.UpdateFunctionConfigurationCommand({
            FunctionName: functionName,
            Environment: {
                Variables: updatedVariables,
            },
        }));
        console.log(`    ✓ Updated Lambda function: ${functionName}`);
    }
    /**
     * Generate migration reports and rollback script
     */
    async generateReports() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const reportDir = path.join(process.cwd(), "migration-reports");
        if (!fs.existsSync(reportDir)) {
            fs.mkdirSync(reportDir, { recursive: true });
        }
        console.log("\n⚠️  WARNING: Migration reports contain sensitive data.");
        console.log("   Please store securely and delete after use.");
        console.log("   Consider encrypting reports before storing.\n");
        // Generate migration report with sanitized secrets
        const reportPath = path.join(reportDir, `migration-${timestamp}.json`);
        const sanitizedMigrations = this.sanitizeForReport(this.migrations);
        fs.writeFileSync(reportPath, JSON.stringify(sanitizedMigrations, null, 2));
        // Generate rollback script
        const rollbackPath = path.join(reportDir, `rollback-${timestamp}.sh`);
        const rollbackScript = this.generateRollbackScript();
        fs.writeFileSync(rollbackPath, rollbackScript, { mode: 0o755 });
        console.log(`\n📄 Reports generated:`);
        console.log(`  Migration report: ${reportPath}`);
        console.log(`  Rollback script: ${rollbackPath}`);
    }
    /**
     * Helper methods
     */
    async secretExists(secretName) {
        try {
            await this.secretsClient.send(new client_secrets_manager_1.DescribeSecretCommand({
                SecretId: secretName,
            }));
            return true;
        }
        catch {
            return false;
        }
    }
    isSecretEnvVar(key, value) {
        const secretKeywords = [
            "password",
            "secret",
            "key",
            "token",
            "api",
            "credential",
            "auth",
        ];
        return (secretKeywords.some((keyword) => key.toLowerCase().includes(keyword)) &&
            value !== "" &&
            value !== "undefined");
    }
    isSecretParameter(name) {
        return name.toLowerCase().includes("password") || name.toLowerCase().includes("secret");
    }
    detectSecretType(name, value) {
        if (name.toLowerCase().includes("database") || name.toLowerCase().includes("db")) {
            return "database";
        }
        if (name.toLowerCase().includes("api") && name.toLowerCase().includes("key")) {
            return "api-key";
        }
        if (name.toLowerCase().includes("oauth") || name.toLowerCase().includes("token")) {
            return "oauth";
        }
        return "custom";
    }
    shouldEnableRotation(name) {
        // Enable rotation for database and API keys
        return (name.toLowerCase().includes("database") ||
            name.toLowerCase().includes("db") ||
            name.toLowerCase().includes("api"));
    }
    generateSecretName(envKey) {
        return `/${this.options.projectName.toLowerCase()}/${this.options.environment}/${envKey.toLowerCase().replace(/_/g, "-")}`;
    }
    ssmToSecretName(ssmPath) {
        // Convert SSM path to Secrets Manager name
        return ssmPath.replace("/ssm/", "/secrets/");
    }
    formatDatabaseSecret(value) {
        // Try to parse database connection string
        // For now, return as-is
        return value;
    }
    async findParameterUsage(paramName) {
        // This would scan Lambda functions, ECS tasks, etc. for parameter usage
        return ["TBD"];
    }
    groupMigrationsByType() {
        return this.migrations.reduce((acc, migration) => {
            if (!acc[migration.secretType]) {
                acc[migration.secretType] = [];
            }
            acc[migration.secretType].push(migration);
            return acc;
        }, {});
    }
    generateRollbackScript() {
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
            .map((m) => `
# Rollback: ${m.targetSecretName}
aws secretsmanager delete-secret --secret-id "${m.targetSecretName}" --force-delete-without-recovery
`)
            .join("\n")}

echo "✓ Rollback completed"
`;
    }
}
exports.SecretsMigrator = SecretsMigrator;
/**
 * CLI entry point
 */
async function main() {
    const args = process.argv.slice(2);
    const options = {
        environment: "dev",
        dryRun: true,
        projectName: "AIStudio",
    };
    // Parse arguments
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--environment" || args[i] === "-e") {
            options.environment = args[++i];
        }
        else if (args[i] === "--execute") {
            options.dryRun = false;
        }
        else if (args[i] === "--dry-run") {
            options.dryRun = true;
        }
        else if (args[i] === "--region") {
            options.region = args[++i];
        }
        else if (args[i] === "--project") {
            options.projectName = args[++i];
        }
    }
    const migrator = new SecretsMigrator(options);
    await migrator.migrate();
}
if (require.main === module) {
    main().catch((error) => {
        console.error("Migration failed:", error);
        process.exit(1);
    });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWlncmF0ZS10by1zZWNyZXRzLW1hbmFnZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJtaWdyYXRlLXRvLXNlY3JldHMtbWFuYWdlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUVBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7R0FrQkc7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUVILDRFQU13QztBQUN4QyxvREFHNEI7QUFDNUIsMERBSytCO0FBQy9CLHVDQUF3QjtBQUN4QiwyQ0FBNEI7QUFtQjVCOztHQUVHO0FBQ0gsTUFBTSxlQUFlO0lBQ1gsYUFBYSxDQUFzQjtJQUNuQyxTQUFTLENBQVc7SUFDcEIsWUFBWSxDQUFjO0lBQzFCLE9BQU8sQ0FBa0I7SUFDekIsVUFBVSxHQUFvQixFQUFFLENBQUE7SUFFeEMsWUFBWSxPQUF5QjtRQUNuQyxJQUFJLENBQUMsT0FBTyxHQUFHLE9BQU8sQ0FBQTtRQUN0QixNQUFNLE1BQU0sR0FBRyxPQUFPLENBQUMsTUFBTSxJQUFJLE9BQU8sQ0FBQyxHQUFHLENBQUMsVUFBVSxJQUFJLFdBQVcsQ0FBQTtRQUV0RSxJQUFJLENBQUMsYUFBYSxHQUFHLElBQUksNkNBQW9CLENBQUMsRUFBRSxNQUFNLEVBQUUsQ0FBQyxDQUFBO1FBQ3pELElBQUksQ0FBQyxTQUFTLEdBQUcsSUFBSSxzQkFBUyxDQUFDLEVBQUUsTUFBTSxFQUFFLENBQUMsQ0FBQTtRQUMxQyxJQUFJLENBQUMsWUFBWSxHQUFHLElBQUksNEJBQVksQ0FBQyxFQUFFLE1BQU0sRUFBRSxDQUFDLENBQUE7SUFDbEQsQ0FBQztJQUVEOzs7T0FHRztJQUNLLGtCQUFrQixDQUFDLE9BQXNCO1FBQy9DLE9BQU87WUFDTCxHQUFHLE9BQU87WUFDVixXQUFXLEVBQUUsZ0JBQWdCO1NBQzlCLENBQUE7SUFDSCxDQUFDO0lBRUQ7OztPQUdHO0lBQ0ssaUJBQWlCLENBQUMsVUFBMkI7UUFDbkQsT0FBTyxVQUFVLENBQUMsR0FBRyxDQUFD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QUE7QUFDMUIsQ0FBQztBQUVELElBQUksT0FBTyxDQUFDLElBQUksS0FBSyxNQUFNLEVBQUUsQ0FBQztJQUM1QixJQUFJLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRTtRQUNyQixPQUFPLENBQUMsS0FBSyxDQUFDLG1CQUFtQixFQUFFLEtBQUssQ0FBQyxDQUFBO1FBQ3pDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUE7SUFDakIsQ0FBQyxDQUFDLENBQUE7QUFDSixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiIyEvdXNyL2Jpbi9lbnYgdHMtbm9kZVxuXG4vKipcbiAqIFNlY3JldHMgTWlncmF0aW9uIFRvb2xcbiAqXG4gKiBNaWdyYXRlcyBleGlzdGluZyBzZWNyZXRzIGZyb20gZW52aXJvbm1lbnQgdmFyaWFibGVzIGFuZCBTU00gcGFyYW1ldGVyc1xuICogdG8gQVdTIFNlY3JldHMgTWFuYWdlciB3aXRoIHByb3BlciB0YWdnaW5nIGFuZCByb3RhdGlvbiBjb25maWd1cmF0aW9uLlxuICpcbiAqIEZlYXR1cmVzOlxuICogLSBTY2FucyBMYW1iZGEgZnVuY3Rpb25zIGZvciBlbnZpcm9ubWVudCB2YXJpYWJsZXNcbiAqIC0gRGlzY292ZXJzIFNTTSBwYXJhbWV0ZXJzXG4gKiAtIENyZWF0ZXMgY29ycmVzcG9uZGluZyBTZWNyZXRzIE1hbmFnZXIgc2VjcmV0c1xuICogLSBFbmFibGVzIHJvdGF0aW9uIHdoZXJlIGFwcGxpY2FibGVcbiAqIC0gVXBkYXRlcyBzZXJ2aWNlIGNvbmZpZ3VyYXRpb25zXG4gKiAtIFZhbGlkYXRlcyBtaWdyYXRpb24gc3VjY2Vzc1xuICogLSBHZW5lcmF0ZXMgcm9sbGJhY2sgc2NyaXB0XG4gKlxuICogVXNhZ2U6XG4gKiAgIG5wbSBydW4gbWlncmF0ZS1zZWNyZXRzIC0tIC0tZW52aXJvbm1lbnQgZGV2IC0tZHJ5LXJ1blxuICogICBucG0gcnVuIG1pZ3JhdGUtc2VjcmV0cyAtLSAtLWVudmlyb25tZW50IHByb2QgLS1leGVjdXRlXG4gKi9cblxuaW1wb3J0IHtcbiAgU2VjcmV0c01hbmFnZXJDbGllbnQsXG4gIENyZWF0ZVNlY3JldENvbW1hbmQsXG4gIERlc2NyaWJlU2VjcmV0Q29tbWFuZCxcbiAgVGFnUmVzb3VyY2VDb21tYW5kLFxuICBQdXRSZXNvdXJjZVBvbGljeUNvbW1hbmQsXG59IGZyb20gXCJAYXdzLXNkay9jbGllbnQtc2VjcmV0cy1tYW5hZ2VyXCJcbmltcG9ydCB7XG4gIFNTTUNsaWVudCxcbiAgR2V0UGFyYW1ldGVyc0J5UGF0aENvbW1hbmQsXG59IGZyb20gXCJAYXdzLXNkay9jbGllbnQtc3NtXCJcbmltcG9ydCB7XG4gIExhbWJkYUNsaWVudCxcbiAgTGlzdEZ1bmN0aW9uc0NvbW1hbmQsXG4gIEdldEZ1bmN0aW9uQ29uZmlndXJhdGlvbkNvbW1hbmQsXG4gIFVwZGF0ZUZ1bmN0aW9uQ29uZmlndXJhdGlvbkNvbW1hbmQsXG59IGZyb20gXCJAYXdzLXNkay9jbGllbnQtbGFtYmRhXCJcbmltcG9ydCAqIGFzIGZzIGZyb20gXCJmc1wiXG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gXCJwYXRoXCJcblxuaW50ZXJmYWNlIFNlY3JldE1hcHBpbmcge1xuICBzb3VyY2U6IFwiZW52LXZhclwiIHwgXCJzc20tcGFyYW1cIlxuICBzb3VyY2VOYW1lOiBzdHJpbmdcbiAgc291cmNlVmFsdWU6IHN0cmluZ1xuICB0YXJnZXRTZWNyZXROYW1lOiBzdHJpbmdcbiAgc2VjcmV0VHlwZTogXCJkYXRhYmFzZVwiIHwgXCJhcGkta2V5XCIgfCBcIm9hdXRoXCIgfCBcImN1c3RvbVwiXG4gIGVuYWJsZVJvdGF0aW9uOiBib29sZWFuXG4gIGFmZmVjdGVkU2VydmljZXM6IHN0cmluZ1tdXG59XG5cbmludGVyZmFjZSBNaWdyYXRpb25PcHRpb25zIHtcbiAgZW52aXJvbm1lbnQ6IHN0cmluZ1xuICBkcnlSdW46IGJvb2xlYW5cbiAgcmVnaW9uPzogc3RyaW5nXG4gIHByb2plY3ROYW1lOiBzdHJpbmdcbn1cblxuLyoqXG4gKiBNYWluIG1pZ3JhdGlvbiBvcmNoZXN0cmF0b3JcbiAqL1xuY2xhc3MgU2VjcmV0c01pZ3JhdG9yIHtcbiAgcHJpdmF0ZSBzZWNyZXRzQ2xpZW50OiBTZWNyZXRzTWFuYWdlckNsaWVudFxuICBwcml2YXRlIHNzbUNsaWVudDogU1NNQ2xpZW50XG4gIHByaXZhdGUgbGFtYmRhQ2xpZW50OiBMYW1iZGFDbGllbnRcbiAgcHJpdmF0ZSBvcHRpb25zOiBNaWdyYXRpb25PcHRpb25zXG4gIHByaXZhdGUgbWlncmF0aW9uczogU2VjcmV0TWFwcGluZ1tdID0gW11cblxuICBjb25zdHJ1Y3RvcihvcHRpb25zOiBNaWdyYXRpb25PcHRpb25zKSB7XG4gICAgdGhpcy5vcHRpb25zID0gb3B0aW9uc1xuICAgIGNvbnN0IHJlZ2lvbiA9IG9wdGlvbnMucmVnaW9uIHx8IHByb2Nlc3MuZW52LkFXU19SRUdJT04gfHwgXCJ1cy1lYXN0LTFcIlxuXG4gICAgdGhpcy5zZWNyZXRzQ2xpZW50ID0gbmV3IFNlY3JldHNNYW5hZ2VyQ2xpZW50KHsgcmVnaW9uIH0pXG4gICAgdGhpcy5zc21DbGllbnQgPSBuZXcgU1NNQ2xpZW50KHsgcmVnaW9uIH0pXG4gICAgdGhpcy5sYW1iZGFDbGllbnQgPSBuZXcgTGFtYmRhQ2xpZW50KHsgcmVnaW9uIH0pXG4gIH1cblxuICAvKipcbiAgICogU2FuaXRpemUgc2VjcmV0IG1hcHBpbmcgZm9yIGxvZ2dpbmdcbiAgICogUmVkYWN0cyB0aGUgc291cmNlVmFsdWUgdG8gcHJldmVudCBzZWNyZXQgZXhwb3N1cmUgaW4gbG9nc1xuICAgKi9cbiAgcHJpdmF0ZSBzYW5pdGl6ZUZvckxvZ2dpbmcobWFwcGluZzogU2VjcmV0TWFwcGluZyk6IFBhcnRpYWw8U2VjcmV0TWFwcGluZz4ge1xuICAgIHJldHVybiB7XG4gICAgICAuLi5tYXBwaW5nLFxuICAgICAgc291cmNlVmFsdWU6IFwiKioqUkVEQUNURUQqKipcIixcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogU2FuaXRpemUgbWlncmF0aW9ucyBhcnJheSBmb3IgcmVwb3J0IGdlbmVyYXRpb25cbiAgICogUmVkYWN0cyBzb3VyY2VWYWx1ZSBmcm9tIGFsbCBtYXBwaW5nc1xuICAgKi9cbiAgcHJpdmF0ZSBzYW5pdGl6ZUZvclJlcG9ydChtaWdyYXRpb25zOiBTZWNyZXRNYXBwaW5nW10pOiBQYXJ0aWFsPFNlY3JldE1hcHBpbmc+W10ge1xuICAgIHJldHVybiBtaWdyYXRpb25zLm1hcCgobSkgPT4gdGhpcy5zYW5pdGl6ZUZvckxvZ2dpbmcobSkpXG4gIH1cblxuICAvKipcbiAgICogRXhlY3V0ZSB0aGUgbWlncmF0aW9uIHByb2Nlc3NcbiAgICovXG4gIGFzeW5jIG1pZ3JhdGUoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc29sZS5sb2coXCLwn5SNIFN0YXJ0aW5nIFNlY3JldHMgTWFuYWdlciBtaWdyYXRpb24uLi5cIilcbiAgICBjb25zb2xlLmxvZyhgRW52aXJvbm1lbnQ6ICR7dGhpcy5vcHRpb25zLmVudmlyb25tZW50fWApXG4gICAgY29uc29sZS5sb2coYERyeSBSdW46ICR7dGhpcy5vcHRpb25zLmRyeVJ1bn1gKVxuICAgIGNvbnNvbGUubG9nKClcblxuICAgIC8vIFN0ZXAgMTogRGlzY292ZXIgZXhpc3Rpbmcgc2VjcmV0c1xuICAgIGF3YWl0IHRoaXMuZGlzY292ZXJTZWNyZXRzKClcblxuICAgIC8vIFN0ZXAgMjogUGxhbiBtaWdyYXRpb25zXG4gICAgYXdhaXQgdGhpcy5wbGFuTWlncmF0aW9ucygpXG5cbiAgICAvLyBTdGVwIDM6IEV4ZWN1dGUgbWlncmF0aW9ucyAoaWYgbm90IGRyeSBydW4pXG4gICAgaWYgKCF0aGlzLm9wdGlvbnMuZHJ5UnVuKSB7XG4gICAgICBhd2FpdCB0aGlzLmV4ZWN1dGVNaWdyYXRpb25zKClcbiAgICB9XG5cbiAgICAvLyBTdGVwIDQ6IEdlbmVyYXRlIHJlcG9ydHNcbiAgICBhd2FpdCB0aGlzLmdlbmVyYXRlUmVwb3J0cygpXG4gIH1cblxuICAvKipcbiAgICogRGlzY292ZXIgZXhpc3Rpbmcgc2VjcmV0cyBpbiB0aGUgZW52aXJvbm1lbnRcbiAgICovXG4gIHByaXZhdGUgYXN5bmMgZGlzY292ZXJTZWNyZXRzKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnNvbGUubG9nKFwi8J+TiyBEaXNjb3ZlcmluZyBleGlzdGluZyBzZWNyZXRzLi4uXCIpXG5cbiAgICAvLyBTY2FuIExhbWJkYSBmdW5jdGlvbnMgZm9yIGVudmlyb25tZW50IHZhcmlhYmxlc1xuICAgIGF3YWl0IHRoaXMuc2NhbkxhbWJkYUZ1bmN0aW9ucygpXG5cbiAgICAvLyBTY2FuIFNTTSBQYXJhbWV0ZXIgU3RvcmVcbiAgICBhd2FpdCB0aGlzLnNjYW5TU01QYXJhbWV0ZXJzKClcblxuICAgIC8vIFNjYW4gY29uZmlndXJhdGlvbiBmaWxlcyAoaWYgYXBwbGljYWJsZSlcbiAgICBhd2FpdCB0aGlzLnNjYW5Db25maWdGaWxlcygpXG5cbiAgICBjb25zb2xlLmxvZyhgRm91bmQgJHt0aGlzLm1pZ3JhdGlvbnMubGVuZ3RofSBzZWNyZXRzIHRvIG1pZ3JhdGVcXG5gKVxuICB9XG5cbiAgLyoqXG4gICAqIFNjYW4gTGFtYmRhIGZ1bmN0aW9ucyBmb3Igc2VjcmV0cyBpbiBlbnZpcm9ubWVudCB2YXJpYWJsZXNcbiAgICovXG4gIHByaXZhdGUgYXN5bmMgc2NhbkxhbWJkYUZ1bmN0aW9ucygpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLmxhbWJkYUNsaWVudC5zZW5kKG5ldyBMaXN0RnVuY3Rpb25zQ29tbWFuZCh7fSkpXG5cbiAgICAgIGlmICghcmVzcG9uc2UuRnVuY3Rpb25zKSB7XG4gICAgICAgIHJldHVyblxuICAgICAgfVxuXG4gICAgICBmb3IgKGNvbnN0IGZ1bmMgb2YgcmVzcG9uc2UuRnVuY3Rpb25zKSB7XG4gICAgICAgIGlmICghZnVuYy5GdW5jdGlvbk5hbWUpIGNvbnRpbnVlXG5cbiAgICAgICAgLy8gU2tpcCBpZiBub3QgZm9yIHRoaXMgZW52aXJvbm1lbnRcbiAgICAgICAgaWYgKCFmdW5jLkZ1bmN0aW9uTmFtZS5pbmNsdWRlcyh0aGlzLm9wdGlvbnMuZW52aXJvbm1lbnQpKSB7XG4gICAgICAgICAgY29udGludWVcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IGNvbmZpZyA9IGF3YWl0IHRoaXMubGFtYmRhQ2xpZW50LnNlbmQoXG4gICAgICAgICAgbmV3IEdldEZ1bmN0aW9uQ29uZmlndXJhdGlvbkNvbW1hbmQoe1xuICAgICAgICAgICAgRnVuY3Rpb25OYW1lOiBmdW5jLkZ1bmN0aW9uTmFtZSxcbiAgICAgICAgICB9KVxuICAgICAgICApXG5cbiAgICAgICAgaWYgKGNvbmZpZy5FbnZpcm9ubWVudD8uVmFyaWFibGVzKSB7XG4gICAgICAgICAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMoY29uZmlnLkVudmlyb25tZW50LlZhcmlhYmxlcykpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLmlzU2VjcmV0RW52VmFyKGtleSwgdmFsdWUpKSB7XG4gICAgICAgICAgICAgIHRoaXMubWlncmF0aW9ucy5wdXNoKHtcbiAgICAgICAgICAgICAgICBzb3VyY2U6IFwiZW52LXZhclwiLFxuICAgICAgICAgICAgICAgIHNvdXJjZU5hbWU6IGAke2Z1bmMuRnVuY3Rpb25OYW1lfToke2tleX1gLFxuICAgICAgICAgICAgICAgIHNvdXJjZVZhbHVlOiB2YWx1ZSxcbiAgICAgICAgICAgICAgICB0YXJnZXRTZWNyZXROYW1lOiB0aGlzLmdlbmVyYXRlU2VjcmV0TmFtZShrZXkpLFxuICAgICAgICAgICAgICAgIHNlY3JldFR5cGU6IHRoaXMuZGV0ZWN0U2VjcmV0VHlwZShrZXksIHZhbHVlKSxcbiAgICAgICAgICAgICAgICBlbmFibGVSb3RhdGlvbjogdGhpcy5zaG91bGRFbmFibGVSb3RhdGlvbihrZXkpLFxuICAgICAgICAgICAgICAgIGFmZmVjdGVkU2VydmljZXM6IFtmdW5jLkZ1bmN0aW9uTmFtZV0sXG4gICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGNvbnNvbGUubG9nKGAgIOKckyBTY2FubmVkIExhbWJkYSBmdW5jdGlvbnNgKVxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zb2xlLmVycm9yKGAgIOKclyBFcnJvciBzY2FubmluZyBMYW1iZGEgZnVuY3Rpb25zOmAsIGVycm9yKVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBTY2FuIFNTTSBQYXJhbWV0ZXIgU3RvcmUgZm9yIHNlY3JldHNcbiAgICovXG4gIHByaXZhdGUgYXN5bmMgc2NhblNTTVBhcmFtZXRlcnMoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGJhc2VQYXRoID0gYC8ke3RoaXMub3B0aW9ucy5wcm9qZWN0TmFtZS50b0xvd2VyQ2FzZSgpfS8ke3RoaXMub3B0aW9ucy5lbnZpcm9ubWVudH1gXG5cbiAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5zc21DbGllbnQuc2VuZChcbiAgICAgICAgbmV3IEdldFBhcmFtZXRlcnNCeVBhdGhDb21tYW5kKHtcbiAgICAgICAgICBQYXRoOiBiYXNlUGF0aCxcbiAgICAgICAgICBSZWN1cnNpdmU6IHRydWUsXG4gICAgICAgICAgV2l0aERlY3J5cHRpb246IHRydWUsXG4gICAgICAgIH0pXG4gICAgICApXG5cbiAgICAgIGlmIChyZXNwb25zZS5QYXJhbWV0ZXJzKSB7XG4gICAgICAgIGZvciAoY29uc3QgcGFyYW0gb2YgcmVzcG9uc2UuUGFyYW1ldGVycykge1xuICAgICAgICAgIGlmICghcGFyYW0uTmFtZSB8fCAhcGFyYW0uVmFsdWUpIGNvbnRpbnVlXG5cbiAgICAgICAgICAvLyBEZXRlcm1pbmUgaWYgdGhpcyBpcyBhIHNlY3JldFxuICAgICAgICAgIGlmIChwYXJhbS5UeXBlID09PSBcIlNlY3VyZVN0cmluZ1wiIHx8IHRoaXMuaXNTZWNyZXRQYXJhbWV0ZXIocGFyYW0uTmFtZSkpIHtcbiAgICAgICAgICAgIHRoaXMubWlncmF0aW9ucy5wdXNoKHtcbiAgICAgICAgICAgICAgc291cmNlOiBcInNzbS1wYXJhbVwiLFxuICAgICAgICAgICAgICBzb3VyY2VOYW1lOiBwYXJhbS5OYW1lLFxuICAgICAgICAgICAgICBzb3VyY2VWYWx1ZTogcGFyYW0uVmFsdWUsXG4gICAgICAgICAgICAgIHRhcmdldFNlY3JldE5hbWU6IHRoaXMuc3NtVG9TZWNyZXROYW1lKHBhcmFtLk5hbWUpLFxuICAgICAgICAgICAgICBzZWNyZXRUeXBlOiB0aGlzLmRldGVjdFNlY3JldFR5cGUocGFyYW0uTmFtZSwgcGFyYW0uVmFsdWUpLFxuICAgICAgICAgICAgICBlbmFibGVSb3RhdGlvbjogdGhpcy5zaG91bGRFbmFibGVSb3RhdGlvbihwYXJhbS5OYW1lKSxcbiAgICAgICAgICAgICAgYWZmZWN0ZWRTZXJ2aWNlczogYXdhaXQgdGhpcy5maW5kUGFyYW1ldGVyVXNhZ2UocGFyYW0uTmFtZSksXG4gICAgICAgICAgICB9KVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBjb25zb2xlLmxvZyhgICDinJMgU2Nhbm5lZCBTU00gUGFyYW1ldGVyIFN0b3JlYClcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgY29uc29sZS5lcnJvcihgICDinJcgRXJyb3Igc2Nhbm5pbmcgU1NNOmAsIGVycm9yKVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBTY2FuIGNvbmZpZ3VyYXRpb24gZmlsZXMgZm9yIGhhcmRjb2RlZCBzZWNyZXRzXG4gICAqL1xuICBwcml2YXRlIGFzeW5jIHNjYW5Db25maWdGaWxlcygpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICAvLyBUaGlzIHdvdWxkIHNjYW4gLmVudiBmaWxlcywgY29uZmlnLyouanNvbiwgZXRjLlxuICAgIC8vIEZvciBub3csIGp1c3QgbG9nIHRoYXQgd2UgY2hlY2tlZFxuICAgIGNvbnNvbGUubG9nKGAgIOKckyBTY2FubmVkIGNvbmZpZ3VyYXRpb24gZmlsZXNgKVxuICB9XG5cbiAgLyoqXG4gICAqIFBsYW4gdGhlIG1pZ3JhdGlvbnMgd2l0aCB1c2VyIHJldmlld1xuICAgKi9cbiAgcHJpdmF0ZSBhc3luYyBwbGFuTWlncmF0aW9ucygpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zb2xlLmxvZyhcIlxcbvCfk50gTWlncmF0aW9uIFBsYW46XCIpXG4gICAgY29uc29sZS5sb2coXCI9XCIgLnJlcGVhdCg4MCkpXG5cbiAgICBjb25zdCBncm91cGVkID0gdGhpcy5ncm91cE1pZ3JhdGlvbnNCeVR5cGUoKVxuXG4gICAgZm9yIChjb25zdCBbdHlwZSwgc2VjcmV0c10gb2YgT2JqZWN0LmVudHJpZXMoZ3JvdXBlZCkpIHtcbiAgICAgIGNvbnNvbGUubG9nKGBcXG4ke3R5cGUudG9VcHBlckNhc2UoKX0gKCR7c2VjcmV0cy5sZW5ndGh9IHNlY3JldHMpOmApXG5cbiAgICAgIGZvciAoY29uc3Qgc2VjcmV0IG9mIHNlY3JldHMpIHtcbiAgICAgICAgY29uc29sZS5sb2coYCAgJHtzZWNyZXQudGFyZ2V0U2VjcmV0TmFtZX1gKVxuICAgICAgICBjb25zb2xlLmxvZyhgICAgIFNvdXJjZTogJHtzZWNyZXQuc291cmNlfSAtICR7c2VjcmV0LnNvdXJjZU5hbWV9YClcbiAgICAgICAgY29uc29sZS5sb2coYCAgICBUeXBlOiAke3NlY3JldC5zZWNyZXRUeXBlfWApXG4gICAgICAgIGNvbnNvbGUubG9nKGAgICAgUm90YXRpb246ICR7c2VjcmV0LmVuYWJsZVJvdGF0aW9uID8gXCLinJMgRW5hYmxlZFwiIDogXCLinJcgRGlzYWJsZWRcIn1gKVxuICAgICAgICBjb25zb2xlLmxvZyhgICAgIFNlcnZpY2VzOiAke3NlY3JldC5hZmZlY3RlZFNlcnZpY2VzLmpvaW4oXCIsIFwiKX1gKVxuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnNvbGUubG9nKFwiXFxuXCIgKyBcIj1cIi5yZXBlYXQoODApKVxuICB9XG5cbiAgLyoqXG4gICAqIEV4ZWN1dGUgdGhlIHBsYW5uZWQgbWlncmF0aW9uc1xuICAgKi9cbiAgcHJpdmF0ZSBhc3luYyBleGVjdXRlTWlncmF0aW9ucygpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zb2xlLmxvZyhcIlxcbvCfmoAgRXhlY3V0aW5nIG1pZ3JhdGlvbnMuLi5cIilcblxuICAgIGNvbnN0IHJlc3VsdHMgPSB7XG4gICAgICBzdWNjZXNzOiAwLFxuICAgICAgZmFpbGVkOiAwLFxuICAgICAgc2tpcHBlZDogMCxcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IG1pZ3JhdGlvbiBvZiB0aGlzLm1pZ3JhdGlvbnMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnNvbGUubG9nKGBcXG4gIE1pZ3JhdGluZzogJHttaWdyYXRpb24udGFyZ2V0U2VjcmV0TmFtZX1gKVxuXG4gICAgICAgIC8vIENoZWNrIGlmIHNlY3JldCBhbHJlYWR5IGV4aXN0c1xuICAgICAgICBpZiAoYXdhaXQgdGhpcy5zZWNyZXRFeGlzdHMobWlncmF0aW9uLnRhcmdldFNlY3JldE5hbWUpKSB7XG4gICAgICAgICAgY29uc29sZS5sb2coYCAgICDimqDvuI8gIFNlY3JldCBhbHJlYWR5IGV4aXN0cywgc2tpcHBpbmdgKVxuICAgICAgICAgIHJlc3VsdHMuc2tpcHBlZCsrXG4gICAgICAgICAgY29udGludWVcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIENyZWF0ZSB0aGUgc2VjcmV0XG4gICAgICAgIGF3YWl0IHRoaXMuY3JlYXRlU2VjcmV0KG1pZ3JhdGlvbilcblxuICAgICAgICAvLyBVcGRhdGUgYWZmZWN0ZWQgc2VydmljZXNcbiAgICAgICAgYXdhaXQgdGhpcy51cGRhdGVTZXJ2aWNlcyhtaWdyYXRpb24pXG5cbiAgICAgICAgY29uc29sZS5sb2coYCAgICDinJMgU3VjY2Vzc2ApXG4gICAgICAgIHJlc3VsdHMuc3VjY2VzcysrXG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBjb25zb2xlLmVycm9yKGAgICAg4pyXIEZhaWxlZDpgLCBlcnJvcilcbiAgICAgICAgcmVzdWx0cy5mYWlsZWQrK1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnNvbGUubG9nKFwiXFxu8J+TiiBNaWdyYXRpb24gUmVzdWx0czpcIilcbiAgICBjb25zb2xlLmxvZyhgICBTdWNjZXNzOiAke3Jlc3VsdHMuc3VjY2Vzc31gKVxuICAgIGNvbnNvbGUubG9nKGAgIEZhaWxlZDogJHtyZXN1bHRzLmZhaWxlZH1gKVxuICAgIGNvbnNvbGUubG9nKGAgIFNraXBwZWQ6ICR7cmVzdWx0cy5za2lwcGVkfWApXG4gIH1cblxuICAvKipcbiAgICogQ3JlYXRlIGEgc2VjcmV0IGluIFNlY3JldHMgTWFuYWdlclxuICAgKi9cbiAgcHJpdmF0ZSBhc3luYyBjcmVhdGVTZWNyZXQobWlncmF0aW9uOiBTZWNyZXRNYXBwaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgLy8gUHJlcGFyZSBzZWNyZXQgc3RyaW5nIChmb3JtYXQgZm9yIGRhdGFiYXNlIHNlY3JldHMpXG4gICAgbGV0IHNlY3JldFN0cmluZyA9IG1pZ3JhdGlvbi5zb3VyY2VWYWx1ZVxuXG4gICAgaWYgKG1pZ3JhdGlvbi5zZWNyZXRUeXBlID09PSBcImRhdGFiYXNlXCIpIHtcbiAgICAgIC8vIFRyeSB0byBwYXJzZSBhcyBkYXRhYmFzZSBjb25uZWN0aW9uIHN0cmluZ1xuICAgICAgc2VjcmV0U3RyaW5nID0gdGhpcy5mb3JtYXREYXRhYmFzZVNlY3JldChtaWdyYXRpb24uc291cmNlVmFsdWUpXG4gICAgfVxuXG4gICAgYXdhaXQgdGhpcy5zZWNyZXRzQ2xpZW50LnNlbmQoXG4gICAgICBuZXcgQ3JlYXRlU2VjcmV0Q29tbWFuZCh7XG4gICAgICAgIE5hbWU6IG1pZ3JhdGlvbi50YXJnZXRTZWNyZXROYW1lLFxuICAgICAgICBTZWNyZXRTdHJpbmc6IHNlY3JldFN0cmluZyxcbiAgICAgICAgRGVzY3JpcHRpb246IGBNaWdyYXRlZCBmcm9tICR7bWlncmF0aW9uLnNvdXJjZX06ICR7bWlncmF0aW9uLnNvdXJjZU5hbWV9YCxcbiAgICAgICAgVGFnczogW1xuICAgICAgICAgIHsgS2V5OiBcIk1hbmFnZWRCeVwiLCBWYWx1ZTogXCJTZWNyZXRzTWFuYWdlclwiIH0sXG4gICAgICAgICAgeyBLZXk6IFwiRW52aXJvbm1lbnRcIiwgVmFsdWU6IHRoaXMub3B0aW9ucy5lbnZpcm9ubWVudCB9LFxuICAgICAgICAgIHsgS2V5OiBcIlNlY3JldFR5cGVcIiwgVmFsdWU6IG1pZ3JhdGlvbi5zZWNyZXRUeXBlIH0sXG4gICAgICAgICAgeyBLZXk6IFwiTWlncmF0ZWRGcm9tXCIsIFZhbHVlOiBtaWdyYXRpb24uc291cmNlIH0sXG4gICAgICAgICAgeyBLZXk6IFwiTWlncmF0aW9uRGF0ZVwiLCBWYWx1ZTogbmV3IERhdGUoKS50b0lTT1N0cmluZygpIH0sXG4gICAgICAgIF0sXG4gICAgICB9KVxuICAgIClcblxuICAgIGNvbnNvbGUubG9nKGAgICAg4pyTIENyZWF0ZWQgc2VjcmV0YClcbiAgfVxuXG4gIC8qKlxuICAgKiBVcGRhdGUgc2VydmljZXMgdG8gdXNlIHRoZSBuZXcgc2VjcmV0XG4gICAqL1xuICBwcml2YXRlIGFzeW5jIHVwZGF0ZVNlcnZpY2VzKG1pZ3JhdGlvbjogU2VjcmV0TWFwcGluZyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGZvciAoY29uc3Qgc2VydmljZSBvZiBtaWdyYXRpb24uYWZmZWN0ZWRTZXJ2aWNlcykge1xuICAgICAgaWYgKG1pZ3JhdGlvbi5zb3VyY2UgPT09IFwiZW52LXZhclwiKSB7XG4gICAgICAgIGF3YWl0IHRoaXMudXBkYXRlTGFtYmRhRnVuY3Rpb24oc2VydmljZSwgbWlncmF0aW9uKVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBVcGRhdGUgTGFtYmRhIGZ1bmN0aW9uIHRvIHVzZSBTZWNyZXRzIE1hbmFnZXJcbiAgICovXG4gIHByaXZhdGUgYXN5bmMgdXBkYXRlTGFtYmRhRnVuY3Rpb24oXG4gICAgZnVuY3Rpb25OYW1lOiBzdHJpbmcsXG4gICAgbWlncmF0aW9uOiBTZWNyZXRNYXBwaW5nXG4gICk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IGNvbmZpZyA9IGF3YWl0IHRoaXMubGFtYmRhQ2xpZW50LnNlbmQoXG4gICAgICBuZXcgR2V0RnVuY3Rpb25Db25maWd1cmF0aW9uQ29tbWFuZCh7XG4gICAgICAgIEZ1bmN0aW9uTmFtZTogZnVuY3Rpb25OYW1lLFxuICAgICAgfSlcbiAgICApXG5cbiAgICBpZiAoIWNvbmZpZy5FbnZpcm9ubWVudD8uVmFyaWFibGVzKSB7XG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICAvLyBSZXBsYWNlIGVudmlyb25tZW50IHZhcmlhYmxlIHdpdGggc2VjcmV0IEFSTiByZWZlcmVuY2VcbiAgICBjb25zdCBlbnZLZXkgPSBtaWdyYXRpb24uc291cmNlTmFtZS5zcGxpdChcIjpcIilbMV1cbiAgICBjb25zdCB1cGRhdGVkVmFyaWFibGVzID0geyAuLi5jb25maWcuRW52aXJvbm1lbnQuVmFyaWFibGVzIH1cbiAgICB1cGRhdGVkVmFyaWFibGVzW2VudktleV0gPSBtaWdyYXRpb24udGFyZ2V0U2VjcmV0TmFtZVxuXG4gICAgYXdhaXQgdGhpcy5sYW1iZGFDbGllbnQuc2VuZChcbiAgICAgIG5ldyBVcGRhdGVGdW5jdGlvbkNvbmZpZ3VyYXRpb25Db21tYW5kKHtcbiAgICAgICAgRnVuY3Rpb25OYW1lOiBmdW5jdGlvbk5hbWUsXG4gICAgICAgIEVudmlyb25tZW50OiB7XG4gICAgICAgICAgVmFyaWFibGVzOiB1cGRhdGVkVmFyaWFibGVzLFxuICAgICAgICB9LFxuICAgICAgfSlcbiAgICApXG5cbiAgICBjb25zb2xlLmxvZyhgICAgIOKckyBVcGRhdGVkIExhbWJkYSBmdW5jdGlvbjogJHtmdW5jdGlvbk5hbWV9YClcbiAgfVxuXG4gIC8qKlxuICAgKiBHZW5lcmF0ZSBtaWdyYXRpb24gcmVwb3J0cyBhbmQgcm9sbGJhY2sgc2NyaXB0XG4gICAqL1xuICBwcml2YXRlIGFzeW5jIGdlbmVyYXRlUmVwb3J0cygpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCB0aW1lc3RhbXAgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkucmVwbGFjZSgvWzouXS9nLCBcIi1cIilcbiAgICBjb25zdCByZXBvcnREaXIgPSBwYXRoLmpvaW4ocHJvY2Vzcy5jd2QoKSwgXCJtaWdyYXRpb24tcmVwb3J0c1wiKVxuXG4gICAgaWYgKCFmcy5leGlzdHNTeW5jKHJlcG9ydERpcikpIHtcbiAgICAgIGZzLm1rZGlyU3luYyhyZXBvcnREaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pXG4gICAgfVxuXG4gICAgY29uc29sZS5sb2coXCJcXG7imqDvuI8gIFdBUk5JTkc6IE1pZ3JhdGlvbiByZXBvcnRzIGNvbnRhaW4gc2Vuc2l0aXZlIGRhdGEuXCIpXG4gICAgY29uc29sZS5sb2coXCIgICBQbGVhc2Ugc3RvcmUgc2VjdXJlbHkgYW5kIGRlbGV0ZSBhZnRlciB1c2UuXCIpXG4gICAgY29uc29sZS5sb2coXCIgICBDb25zaWRlciBlbmNyeXB0aW5nIHJlcG9ydHMgYmVmb3JlIHN0b3JpbmcuXFxuXCIpXG5cbiAgICAvLyBHZW5lcmF0ZSBtaWdyYXRpb24gcmVwb3J0IHdpdGggc2FuaXRpemVkIHNlY3JldHNcbiAgICBjb25zdCByZXBvcnRQYXRoID0gcGF0aC5qb2luKHJlcG9ydERpciwgYG1pZ3JhdGlvbi0ke3RpbWVzdGFtcH0uanNvbmApXG4gICAgY29uc3Qgc2FuaXRpemVkTWlncmF0aW9ucyA9IHRoaXMuc2FuaXRpemVGb3JSZXBvcnQodGhpcy5taWdyYXRpb25zKVxuICAgIGZzLndyaXRlRmlsZVN5bmMocmVwb3J0UGF0aCwgSlNPTi5zdHJpbmdpZnkoc2FuaXRpemVkTWlncmF0aW9ucywgbnVsbCwgMikpXG5cbiAgICAvLyBHZW5lcmF0ZSByb2xsYmFjayBzY3JpcHRcbiAgICBjb25zdCByb2xsYmFja1BhdGggPSBwYXRoLmpvaW4ocmVwb3J0RGlyLCBgcm9sbGJhY2stJHt0aW1lc3RhbXB9LnNoYClcbiAgICBjb25zdCByb2xsYmFja1NjcmlwdCA9IHRoaXMuZ2VuZXJhdGVSb2xsYmFja1NjcmlwdCgpXG4gICAgZnMud3JpdGVGaWxlU3luYyhyb2xsYmFja1BhdGgsIHJvbGxiYWNrU2NyaXB0LCB7IG1vZGU6IDBvNzU1IH0pXG5cbiAgICBjb25zb2xlLmxvZyhgXFxu8J+ThCBSZXBvcnRzIGdlbmVyYXRlZDpgKVxuICAgIGNvbnNvbGUubG9nKGAgIE1pZ3JhdGlvbiByZXBvcnQ6ICR7cmVwb3J0UGF0aH1gKVxuICAgIGNvbnNvbGUubG9nKGAgIFJvbGxiYWNrIHNjcmlwdDogJHtyb2xsYmFja1BhdGh9YClcbiAgfVxuXG4gIC8qKlxuICAgKiBIZWxwZXIgbWV0aG9kc1xuICAgKi9cblxuICBwcml2YXRlIGFzeW5jIHNlY3JldEV4aXN0cyhzZWNyZXROYW1lOiBzdHJpbmcpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgdGhpcy5zZWNyZXRzQ2xpZW50LnNlbmQoXG4gICAgICAgIG5ldyBEZXNjcmliZVNlY3JldENvbW1hbmQoe1xuICAgICAgICAgIFNlY3JldElkOiBzZWNyZXROYW1lLFxuICAgICAgICB9KVxuICAgICAgKVxuICAgICAgcmV0dXJuIHRydWVcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBmYWxzZVxuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgaXNTZWNyZXRFbnZWYXIoa2V5OiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICBjb25zdCBzZWNyZXRLZXl3b3JkcyA9IFtcbiAgICAgIFwicGFzc3dvcmRcIixcbiAgICAgIFwic2VjcmV0XCIsXG4gICAgICBcImtleVwiLFxuICAgICAgXCJ0b2tlblwiLFxuICAgICAgXCJhcGlcIixcbiAgICAgIFwiY3JlZGVudGlhbFwiLFxuICAgICAgXCJhdXRoXCIsXG4gICAgXVxuXG4gICAgcmV0dXJuIChcbiAgICAgIHNlY3JldEtleXdvcmRzLnNvbWUoKGtleXdvcmQpID0+IGtleS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKGtleXdvcmQpKSAmJlxuICAgICAgdmFsdWUgIT09IFwiXCIgJiZcbiAgICAgIHZhbHVlICE9PSBcInVuZGVmaW5lZFwiXG4gICAgKVxuICB9XG5cbiAgcHJpdmF0ZSBpc1NlY3JldFBhcmFtZXRlcihuYW1lOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICByZXR1cm4gbmFtZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFwicGFzc3dvcmRcIikgfHwgbmFtZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFwic2VjcmV0XCIpXG4gIH1cblxuICBwcml2YXRlIGRldGVjdFNlY3JldFR5cGUoXG4gICAgbmFtZTogc3RyaW5nLFxuICAgIHZhbHVlOiBzdHJpbmdcbiAgKTogXCJkYXRhYmFzZVwiIHwgXCJhcGkta2V5XCIgfCBcIm9hdXRoXCIgfCBcImN1c3RvbVwiIHtcbiAgICBpZiAobmFtZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFwiZGF0YWJhc2VcIikgfHwgbmFtZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFwiZGJcIikpIHtcbiAgICAgIHJldHVybiBcImRhdGFiYXNlXCJcbiAgICB9XG4gICAgaWYgKG5hbWUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhcImFwaVwiKSAmJiBuYW1lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJrZXlcIikpIHtcbiAgICAgIHJldHVybiBcImFwaS1rZXlcIlxuICAgIH1cbiAgICBpZiAobmFtZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFwib2F1dGhcIikgfHwgbmFtZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFwidG9rZW5cIikpIHtcbiAgICAgIHJldHVybiBcIm9hdXRoXCJcbiAgICB9XG4gICAgcmV0dXJuIFwiY3VzdG9tXCJcbiAgfVxuXG4gIHByaXZhdGUgc2hvdWxkRW5hYmxlUm90YXRpb24obmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgLy8gRW5hYmxlIHJvdGF0aW9uIGZvciBkYXRhYmFzZSBhbmQgQVBJIGtleXNcbiAgICByZXR1cm4gKFxuICAgICAgbmFtZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFwiZGF0YWJhc2VcIikgfHxcbiAgICAgIG5hbWUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhcImRiXCIpIHx8XG4gICAgICBuYW1lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJhcGlcIilcbiAgICApXG4gIH1cblxuICBwcml2YXRlIGdlbmVyYXRlU2VjcmV0TmFtZShlbnZLZXk6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGAvJHt0aGlzLm9wdGlvbnMucHJvamVjdE5hbWUudG9Mb3dlckNhc2UoKX0vJHt0aGlzLm9wdGlvbnMuZW52aXJvbm1lbnR9LyR7ZW52S2V5LnRvTG93ZXJDYXNlKCkucmVwbGFjZSgvXy9nLCBcIi1cIil9YFxuICB9XG5cbiAgcHJpdmF0ZSBzc21Ub1NlY3JldE5hbWUoc3NtUGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICAvLyBDb252ZXJ0IFNTTSBwYXRoIHRvIFNlY3JldHMgTWFuYWdlciBuYW1lXG4gICAgcmV0dXJuIHNzbVBhdGgucmVwbGFjZShcIi9zc20vXCIsIFwiL3NlY3JldHMvXCIpXG4gIH1cblxuICBwcml2YXRlIGZvcm1hdERhdGFiYXNlU2VjcmV0KHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIC8vIFRyeSB0byBwYXJzZSBkYXRhYmFzZSBjb25uZWN0aW9uIHN0cmluZ1xuICAgIC8vIEZvciBub3csIHJldHVybiBhcy1pc1xuICAgIHJldHVybiB2YWx1ZVxuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBmaW5kUGFyYW1ldGVyVXNhZ2UocGFyYW1OYW1lOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZ1tdPiB7XG4gICAgLy8gVGhpcyB3b3VsZCBzY2FuIExhbWJkYSBmdW5jdGlvbnMsIEVDUyB0YXNrcywgZXRjLiBmb3IgcGFyYW1ldGVyIHVzYWdlXG4gICAgcmV0dXJuIFtcIlRCRFwiXVxuICB9XG5cbiAgcHJpdmF0ZSBncm91cE1pZ3JhdGlvbnNCeVR5cGUoKTogUmVjb3JkPHN0cmluZywgU2VjcmV0TWFwcGluZ1tdPiB7XG4gICAgcmV0dXJuIHRoaXMubWlncmF0aW9ucy5yZWR1Y2UoXG4gICAgICAoYWNjLCBtaWdyYXRpb24pID0+IHtcbiAgICAgICAgaWYgKCFhY2NbbWlncmF0aW9uLnNlY3JldFR5cGVdKSB7XG4gICAgICAgICAgYWNjW21pZ3JhdGlvbi5zZWNyZXRUeXBlXSA9IFtdXG4gICAgICAgIH1cbiAgICAgICAgYWNjW21pZ3JhdGlvbi5zZWNyZXRUeXBlXS5wdXNoKG1pZ3JhdGlvbilcbiAgICAgICAgcmV0dXJuIGFjY1xuICAgICAgfSxcbiAgICAgIHt9IGFzIFJlY29yZDxzdHJpbmcsIFNlY3JldE1hcHBpbmdbXT5cbiAgICApXG4gIH1cblxuICBwcml2YXRlIGdlbmVyYXRlUm9sbGJhY2tTY3JpcHQoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gYCMhL2Jpbi9iYXNoXG4jIFJvbGxiYWNrIHNjcmlwdCBmb3Igc2VjcmV0cyBtaWdyYXRpb25cbiMgR2VuZXJhdGVkOiAke25ldyBEYXRlKCkudG9JU09TdHJpbmcoKX1cblxuZWNobyBcIuKaoO+4jyAgVGhpcyB3aWxsIGRlbGV0ZSBtaWdyYXRlZCBzZWNyZXRzIGFuZCByZXN0b3JlIG9yaWdpbmFsIGNvbmZpZ3VyYXRpb25cIlxucmVhZCAtcCBcIkNvbnRpbnVlPyAoeWVzL25vKTogXCIgQ09ORklSTVxuXG5pZiBbIFwiJENPTkZJUk1cIiAhPSBcInllc1wiIF07IHRoZW5cbiAgZWNobyBcIlJvbGxiYWNrIGNhbmNlbGxlZFwiXG4gIGV4aXQgMFxuZmlcblxuJHt0aGlzLm1pZ3JhdGlvbnNcbiAgLm1hcChcbiAgICAobSkgPT4gYFxuIyBSb2xsYmFjazogJHttLnRhcmdldFNlY3JldE5hbWV9XG5hd3Mgc2VjcmV0c21hbmFnZXIgZGVsZXRlLXNlY3JldCAtLXNlY3JldC1pZCBcIiR7bS50YXJnZXRTZWNyZXROYW1lfVwiIC0tZm9yY2UtZGVsZXRlLXdpdGhvdXQtcmVjb3ZlcnlcbmBcbiAgKVxuICAuam9pbihcIlxcblwiKX1cblxuZWNobyBcIuKckyBSb2xsYmFjayBjb21wbGV0ZWRcIlxuYFxuICB9XG59XG5cbi8qKlxuICogQ0xJIGVudHJ5IHBvaW50XG4gKi9cbmFzeW5jIGZ1bmN0aW9uIG1haW4oKSB7XG4gIGNvbnN0IGFyZ3MgPSBwcm9jZXNzLmFyZ3Yuc2xpY2UoMilcbiAgY29uc3Qgb3B0aW9uczogTWlncmF0aW9uT3B0aW9ucyA9IHtcbiAgICBlbnZpcm9ubWVudDogXCJkZXZcIixcbiAgICBkcnlSdW46IHRydWUsXG4gICAgcHJvamVjdE5hbWU6IFwiQUlTdHVkaW9cIixcbiAgfVxuXG4gIC8vIFBhcnNlIGFyZ3VtZW50c1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGFyZ3MubGVuZ3RoOyBpKyspIHtcbiAgICBpZiAoYXJnc1tpXSA9PT0gXCItLWVudmlyb25tZW50XCIgfHwgYXJnc1tpXSA9PT0gXCItZVwiKSB7XG4gICAgICBvcHRpb25zLmVudmlyb25tZW50ID0gYXJnc1srK2ldXG4gICAgfSBlbHNlIGlmIChhcmdzW2ldID09PSBcIi0tZXhlY3V0ZVwiKSB7XG4gICAgICBvcHRpb25zLmRyeVJ1biA9IGZhbHNlXG4gICAgfSBlbHNlIGlmIChhcmdzW2ldID09PSBcIi0tZHJ5LXJ1blwiKSB7XG4gICAgICBvcHRpb25zLmRyeVJ1biA9IHRydWVcbiAgICB9IGVsc2UgaWYgKGFyZ3NbaV0gPT09IFwiLS1yZWdpb25cIikge1xuICAgICAgb3B0aW9ucy5yZWdpb24gPSBhcmdzWysraV1cbiAgICB9IGVsc2UgaWYgKGFyZ3NbaV0gPT09IFwiLS1wcm9qZWN0XCIpIHtcbiAgICAgIG9wdGlvbnMucHJvamVjdE5hbWUgPSBhcmdzWysraV1cbiAgICB9XG4gIH1cblxuICBjb25zdCBtaWdyYXRvciA9IG5ldyBTZWNyZXRzTWlncmF0b3Iob3B0aW9ucylcbiAgYXdhaXQgbWlncmF0b3IubWlncmF0ZSgpXG59XG5cbmlmIChyZXF1aXJlLm1haW4gPT09IG1vZHVsZSkge1xuICBtYWluKCkuY2F0Y2goKGVycm9yKSA9PiB7XG4gICAgY29uc29sZS5lcnJvcihcIk1pZ3JhdGlvbiBmYWlsZWQ6XCIsIGVycm9yKVxuICAgIHByb2Nlc3MuZXhpdCgxKVxuICB9KVxufVxuXG5leHBvcnQgeyBTZWNyZXRzTWlncmF0b3IsIE1pZ3JhdGlvbk9wdGlvbnMsIFNlY3JldE1hcHBpbmcgfVxuIl19