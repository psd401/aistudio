#!/usr/bin/env ts-node

/**
 * IAM Policy Audit Script
 *
 * Scans CDK infrastructure code to identify overly permissive IAM policies
 * with wildcard resources. This script helps identify the 116 violations
 * mentioned in issue #379.
 *
 * Usage:
 *   bunx ts-node infra/scripts/audit-iam-policies.ts
 */

import * as fs from "fs"
import * as path from "path"
import * as glob from "glob"

interface PolicyViolation {
  file: string
  line: number
  type: "wildcard-resource" | "overly-broad-action" | "no-conditions"
  severity: "low" | "medium" | "high" | "critical"
  snippet: string
  suggestion: string
}

interface AuditReport {
  timestamp: string
  totalFiles: number
  violationsFound: number
  violations: PolicyViolation[]
  summary: {
    byType: Record<string, number>
    bySeverity: Record<string, number>
    byFile: Record<string, number>
  }
}

// Patterns to detect
const PATTERNS = {
  // Wildcard resources
  wildcardResource: /resources:\s*\[?\s*['"]\*['"]\s*\]?/gi,
  wildcardResourceArray: /resources:\s*\[\s*['"]\*['"]/gi,

  // Overly broad actions
  wildcardAction: /actions:\s*\[?\s*['"].*:\*['"]\s*\]?/gi,
  adminAction: /actions:\s*\[?\s*['"]\*:\*['"]\s*\]?/gi,

  // Common anti-patterns
  s3Star: /['"]\s*s3:\*\s*['"]/gi,
  dynamodbStar: /['"]\s*dynamodb:\*\s*['"]/gi,
  lambdaStar: /['"]\s*lambda:\*\s*['"]/gi,
  ec2Star: /['"]\s*ec2:\*\s*['"]/gi,
  iamStar: /['"]\s*iam:\*\s*['"]/gi,
}

// Allowed wildcard patterns (X-Ray, CloudWatch Logs, etc.)
const ALLOWED_WILDCARDS = [
  /xray:PutTraceSegments/,
  /xray:PutTelemetryRecords/,
  /logs:CreateLogGroup/,
  /cloudwatch:PutMetricData/,
]

function auditFile(filePath: string): PolicyViolation[] {
  const violations: PolicyViolation[] = []
  const content = fs.readFileSync(filePath, "utf-8")
  const lines = content.split("\n")

  lines.forEach((line, index) => {
    const lineNumber = index + 1

    // Check for wildcard resources
    if (PATTERNS.wildcardResource.test(line) || PATTERNS.wildcardResourceArray.test(line)) {
      // Check if it's in an allowed context
      const isAllowed = ALLOWED_WILDCARDS.some((pattern) => {
        const context = lines.slice(Math.max(0, index - 3), index + 3).join("\n")
        return pattern.test(context)
      })

      if (!isAllowed) {
        violations.push({
          file: filePath,
          line: lineNumber,
          type: "wildcard-resource",
          severity: "high",
          snippet: line.trim(),
          suggestion: "Replace wildcard resource '*' with specific ARNs",
        })
      }
    }

    // Check for overly broad actions
    if (PATTERNS.adminAction.test(line)) {
      violations.push({
        file: filePath,
        line: lineNumber,
        type: "overly-broad-action",
        severity: "critical",
        snippet: line.trim(),
        suggestion: "Replace '*:*' with specific actions",
      })
    }

    // Check for service-level wildcards
    Object.entries({
      s3Star: PATTERNS.s3Star,
      dynamodbStar: PATTERNS.dynamodbStar,
      lambdaStar: PATTERNS.lambdaStar,
      ec2Star: PATTERNS.ec2Star,
      iamStar: PATTERNS.iamStar,
    }).forEach(([name, pattern]) => {
      if (pattern.test(line)) {
        violations.push({
          file: filePath,
          line: lineNumber,
          type: "overly-broad-action",
          severity: name === "iamStar" ? "critical" : "high",
          snippet: line.trim(),
          suggestion: `Replace ${name.replace("Star", ":*")} with specific actions`,
        })
      }
    })
  })

  return violations
}

function generateReport(violations: PolicyViolation[]): AuditReport {
  const byType: Record<string, number> = {}
  const bySeverity: Record<string, number> = {}
  const byFile: Record<string, number> = {}

  violations.forEach((v) => {
    byType[v.type] = (byType[v.type] || 0) + 1
    bySeverity[v.severity] = (bySeverity[v.severity] || 0) + 1
    byFile[v.file] = (byFile[v.file] || 0) + 1
  })

  return {
    timestamp: new Date().toISOString(),
    totalFiles: Object.keys(byFile).length,
    violationsFound: violations.length,
    violations: violations.sort((a, b) => {
      // Sort by severity, then file, then line
      const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 }
      const severityDiff = severityOrder[a.severity] - severityOrder[b.severity]
      if (severityDiff !== 0) return severityDiff

      const fileDiff = a.file.localeCompare(b.file)
      if (fileDiff !== 0) return fileDiff

      return a.line - b.line
    }),
    summary: {
      byType,
      bySeverity,
      byFile,
    },
  }
}

function printReport(report: AuditReport): void {
  console.log("\n" + "=".repeat(80))
  console.log("IAM POLICY AUDIT REPORT")
  console.log("=".repeat(80))
  console.log(`Generated: ${report.timestamp}`)
  console.log(`Files scanned: ${report.totalFiles}`)
  console.log(`Violations found: ${report.violationsFound}`)
  console.log()

  // Summary by severity
  console.log("VIOLATIONS BY SEVERITY:")
  Object.entries(report.summary.bySeverity)
    .sort((a, b) => {
      const order = { critical: 0, high: 1, medium: 2, low: 3 }
      return order[a[0] as keyof typeof order] - order[b[0] as keyof typeof order]
    })
    .forEach(([severity, count]) => {
      const icon = severity === "critical" || severity === "high" ? "❌" : "⚠️"
      console.log(`  ${icon} ${severity.toUpperCase()}: ${count}`)
    })
  console.log()

  // Summary by type
  console.log("VIOLATIONS BY TYPE:")
  Object.entries(report.summary.byType).forEach(([type, count]) => {
    console.log(`  • ${type}: ${count}`)
  })
  console.log()

  // Top violating files
  console.log("TOP 10 FILES WITH MOST VIOLATIONS:")
  Object.entries(report.summary.byFile)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([file, count]) => {
      const relPath = path.relative(process.cwd(), file)
      console.log(`  • ${relPath}: ${count} violations`)
    })
  console.log()

  // Detailed violations (show first 20)
  console.log("DETAILED VIOLATIONS (first 20):")
  console.log("-".repeat(80))
  report.violations.slice(0, 20).forEach((v, index) => {
    const relPath = path.relative(process.cwd(), v.file)
    console.log(`\n${index + 1}. [${v.severity.toUpperCase()}] ${relPath}:${v.line}`)
    console.log(`   Type: ${v.type}`)
    console.log(`   Code: ${v.snippet}`)
    console.log(`   Fix:  ${v.suggestion}`)
  })

  if (report.violationsFound > 20) {
    console.log(`\n... and ${report.violationsFound - 20} more violations`)
  }

  console.log("\n" + "=".repeat(80))
  console.log(`Total violations: ${report.violationsFound}`)
  console.log("=".repeat(80) + "\n")
}

function saveReport(report: AuditReport, outputPath: string): void {
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2))
  console.log(`Full report saved to: ${outputPath}`)
}

// Main execution
async function main() {
  console.log("Starting IAM policy audit...")

  // Find all TypeScript files in the infra directory
  const files = glob.sync("infra/**/*.ts", {
    ignore: [
      "**/node_modules/**",
      "**/*.d.ts",
      "**/dist/**",
      "**/cdk.out/**",
    ],
  })

  console.log(`Found ${files.length} files to audit\n`)

  // Audit all files
  const allViolations: PolicyViolation[] = []
  files.forEach((file) => {
    const violations = auditFile(file)
    allViolations.push(...violations)
  })

  // Generate and print report
  const report = generateReport(allViolations)
  printReport(report)

  // Save detailed report
  const outputPath = path.join(__dirname, "../audit-report.json")
  saveReport(report, outputPath)

  // Exit with error code if violations found
  if (report.violationsFound > 0) {
    console.error(`\n⚠️  Found ${report.violationsFound} policy violations that need attention`)
    process.exit(1)
  }

  console.log("\n✅ No policy violations found!")
  process.exit(0)
}

// Run the audit
main().catch((error) => {
  console.error("Error running audit:", error)
  process.exit(1)
})
