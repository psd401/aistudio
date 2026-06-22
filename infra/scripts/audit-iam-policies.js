#!/usr/bin/env ts-node
"use strict";
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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const glob = __importStar(require("glob"));
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
};
// Allowed wildcard patterns (X-Ray, CloudWatch Logs, etc.)
const ALLOWED_WILDCARDS = [
    /xray:PutTraceSegments/,
    /xray:PutTelemetryRecords/,
    /logs:CreateLogGroup/,
    /cloudwatch:PutMetricData/,
];
function auditFile(filePath) {
    const violations = [];
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    lines.forEach((line, index) => {
        const lineNumber = index + 1;
        // Check for wildcard resources
        if (PATTERNS.wildcardResource.test(line) || PATTERNS.wildcardResourceArray.test(line)) {
            // Check if it's in an allowed context
            const isAllowed = ALLOWED_WILDCARDS.some((pattern) => {
                const context = lines.slice(Math.max(0, index - 3), index + 3).join("\n");
                return pattern.test(context);
            });
            if (!isAllowed) {
                violations.push({
                    file: filePath,
                    line: lineNumber,
                    type: "wildcard-resource",
                    severity: "high",
                    snippet: line.trim(),
                    suggestion: "Replace wildcard resource '*' with specific ARNs",
                });
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
            });
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
                });
            }
        });
    });
    return violations;
}
function generateReport(violations) {
    const byType = {};
    const bySeverity = {};
    const byFile = {};
    violations.forEach((v) => {
        byType[v.type] = (byType[v.type] || 0) + 1;
        bySeverity[v.severity] = (bySeverity[v.severity] || 0) + 1;
        byFile[v.file] = (byFile[v.file] || 0) + 1;
    });
    return {
        timestamp: new Date().toISOString(),
        totalFiles: Object.keys(byFile).length,
        violationsFound: violations.length,
        violations: violations.sort((a, b) => {
            // Sort by severity, then file, then line
            const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
            const severityDiff = severityOrder[a.severity] - severityOrder[b.severity];
            if (severityDiff !== 0)
                return severityDiff;
            const fileDiff = a.file.localeCompare(b.file);
            if (fileDiff !== 0)
                return fileDiff;
            return a.line - b.line;
        }),
        summary: {
            byType,
            bySeverity,
            byFile,
        },
    };
}
function printReport(report) {
    console.log("\n" + "=".repeat(80));
    console.log("IAM POLICY AUDIT REPORT");
    console.log("=".repeat(80));
    console.log(`Generated: ${report.timestamp}`);
    console.log(`Files scanned: ${report.totalFiles}`);
    console.log(`Violations found: ${report.violationsFound}`);
    console.log();
    // Summary by severity
    console.log("VIOLATIONS BY SEVERITY:");
    Object.entries(report.summary.bySeverity)
        .sort((a, b) => {
        const order = { critical: 0, high: 1, medium: 2, low: 3 };
        return order[a[0]] - order[b[0]];
    })
        .forEach(([severity, count]) => {
        const icon = severity === "critical" || severity === "high" ? "❌" : "⚠️";
        console.log(`  ${icon} ${severity.toUpperCase()}: ${count}`);
    });
    console.log();
    // Summary by type
    console.log("VIOLATIONS BY TYPE:");
    Object.entries(report.summary.byType).forEach(([type, count]) => {
        console.log(`  • ${type}: ${count}`);
    });
    console.log();
    // Top violating files
    console.log("TOP 10 FILES WITH MOST VIOLATIONS:");
    Object.entries(report.summary.byFile)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .forEach(([file, count]) => {
        const relPath = path.relative(process.cwd(), file);
        console.log(`  • ${relPath}: ${count} violations`);
    });
    console.log();
    // Detailed violations (show first 20)
    console.log("DETAILED VIOLATIONS (first 20):");
    console.log("-".repeat(80));
    report.violations.slice(0, 20).forEach((v, index) => {
        const relPath = path.relative(process.cwd(), v.file);
        console.log(`\n${index + 1}. [${v.severity.toUpperCase()}] ${relPath}:${v.line}`);
        console.log(`   Type: ${v.type}`);
        console.log(`   Code: ${v.snippet}`);
        console.log(`   Fix:  ${v.suggestion}`);
    });
    if (report.violationsFound > 20) {
        console.log(`\n... and ${report.violationsFound - 20} more violations`);
    }
    console.log("\n" + "=".repeat(80));
    console.log(`Total violations: ${report.violationsFound}`);
    console.log("=".repeat(80) + "\n");
}
function saveReport(report, outputPath) {
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    console.log(`Full report saved to: ${outputPath}`);
}
// Main execution
async function main() {
    console.log("Starting IAM policy audit...");
    // Find all TypeScript files in the infra directory
    const files = glob.sync("infra/**/*.ts", {
        ignore: [
            "**/node_modules/**",
            "**/*.d.ts",
            "**/dist/**",
            "**/cdk.out/**",
        ],
    });
    console.log(`Found ${files.length} files to audit\n`);
    // Audit all files
    const allViolations = [];
    files.forEach((file) => {
        const violations = auditFile(file);
        allViolations.push(...violations);
    });
    // Generate and print report
    const report = generateReport(allViolations);
    printReport(report);
    // Save detailed report
    const outputPath = path.join(__dirname, "../audit-report.json");
    saveReport(report, outputPath);
    // Exit with error code if violations found
    if (report.violationsFound > 0) {
        console.error(`\n⚠️  Found ${report.violationsFound} policy violations that need attention`);
        process.exit(1);
    }
    console.log("\n✅ No policy violations found!");
    process.exit(0);
}
// Run the audit
main().catch((error) => {
    console.error("Error running audit:", error);
    process.exit(1);
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXVkaXQtaWFtLXBvbGljaWVzLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiYXVkaXQtaWFtLXBvbGljaWVzLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBRUE7Ozs7Ozs7OztHQVNHOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUVILHVDQUF3QjtBQUN4QiwyQ0FBNEI7QUFDNUIsMkNBQTRCO0FBdUI1QixxQkFBcUI7QUFDckIsTUFBTSxRQUFRLEdBQUc7SUFDZixxQkFBcUI7SUFDckIsZ0JBQWdCLEVBQUUsdUNBQXVDO0lBQ3pELHFCQUFxQixFQUFFLGdDQUFnQztJQUV2RCx1QkFBdUI7SUFDdkIsY0FBYyxFQUFFLHdDQUF3QztJQUN4RCxXQUFXLEVBQUUsd0NBQXdDO0lBRXJELHVCQUF1QjtJQUN2QixNQUFNLEVBQUUsdUJBQXVCO0lBQy9CLFlBQVksRUFBRSw2QkFBNkI7SUFDM0MsVUFBVSxFQUFFLDJCQUEyQjtJQUN2QyxPQUFPLEVBQUUsd0JBQXdCO0lBQ2pDLE9BQU8sRUFBRSx3QkFBd0I7Q0FDbEMsQ0FBQTtBQUVELDJEQUEyRDtBQUMzRCxNQUFNLGlCQUFpQixHQUFHO0lBQ3hCLHVCQUF1QjtJQUN2QiwwQkFBMEI7SUFDMUIscUJBQXFCO0lBQ3JCLDBCQUEwQjtDQUMzQixDQUFBO0FBRUQsU0FBUyxTQUFTLENBQUMsUUFBZ0I7SUFDakMsTUFBTSxVQUFVLEdBQXNCLEVBQUUsQ0FBQTtJQUN4QyxNQUFNLE9BQU8sR0FBRyxFQUFFLENBQUMsWUFBWSxDQUFDLFFBQVEsRUFBRSxPQUFPLENBQUMsQ0FBQTtJQUNsRCxNQUFNLEtBQUssR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFBO0lBRWpDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFLEVBQUU7UUFDNUIsTUFBTSxVQUFVLEdBQUcsS0FBSyxHQUFHLENBQUMsQ0FBQTtRQUU1QiwrQkFBK0I7UUFDL0Is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LENBQUMsQ0FBQTtRQUNsQyxhQUFhLENBQUMsSUFBSSxDQUFDLEdBQUcsVUFBVSxDQUFDLENBQUE7SUFDbkMsQ0FBQyxDQUFDLENBQUE7SUFFRiw0QkFBNEI7SUFDNUIsTUFBTSxNQUFNLEdBQUcsY0FBYyxDQUFDLGFBQWEsQ0FBQyxDQUFBO0lBQzVDLFdBQVcsQ0FBQyxNQUFNLENBQUMsQ0FBQTtJQUVuQix1QkFBdUI7SUFDdkIsTUFBTSxVQUFVLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxTQUFTLEVBQUUsc0JBQXNCLENBQUMsQ0FBQTtJQUMvRCxVQUFVLENBQUMsTUFBTSxFQUFFLFVBQVUsQ0FBQyxDQUFBO0lBRTlCLDJDQUEyQztJQUMzQyxJQUFJLE1BQU0sQ0FBQyxlQUFlLEdBQUcsQ0FBQyxFQUFFLENBQUM7UUFDL0IsT0FBTyxDQUFDLEtBQUssQ0FBQyxlQUFlLE1BQU0sQ0FBQyxlQUFlLHdDQUF3QyxDQUFDLENBQUE7UUFDNUYsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQTtJQUNqQixDQUFDO0lBRUQsT0FBTyxDQUFDLEdBQUcsQ0FBQyxpQ0FBaUMsQ0FBQyxDQUFBO0lBQzlDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUE7QUFDakIsQ0FBQztBQUVELGdCQUFnQjtBQUNoQixJQUFJLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRTtJQUNyQixPQUFPLENBQUMsS0FBSyxDQUFDLHNCQUFzQixFQUFFLEtBQUssQ0FBQyxDQUFBO0lBQzVDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUE7QUFDakIsQ0FBQyxDQUFDLENBQUEiLCJzb3VyY2VzQ29udGVudCI6WyIjIS91c3IvYmluL2VudiB0cy1ub2RlXG5cbi8qKlxuICogSUFNIFBvbGljeSBBdWRpdCBTY3JpcHRcbiAqXG4gKiBTY2FucyBDREsgaW5mcmFzdHJ1Y3R1cmUgY29kZSB0byBpZGVudGlmeSBvdmVybHkgcGVybWlzc2l2ZSBJQU0gcG9saWNpZXNcbiAqIHdpdGggd2lsZGNhcmQgcmVzb3VyY2VzLiBUaGlzIHNjcmlwdCBoZWxwcyBpZGVudGlmeSB0aGUgMTE2IHZpb2xhdGlvbnNcbiAqIG1lbnRpb25lZCBpbiBpc3N1ZSAjMzc5LlxuICpcbiAqIFVzYWdlOlxuICogICBidW54IHRzLW5vZGUgaW5mcmEvc2NyaXB0cy9hdWRpdC1pYW0tcG9saWNpZXMudHNcbiAqL1xuXG5pbXBvcnQgKiBhcyBmcyBmcm9tIFwiZnNcIlxuaW1wb3J0ICogYXMgcGF0aCBmcm9tIFwicGF0aFwiXG5pbXBvcnQgKiBhcyBnbG9iIGZyb20gXCJnbG9iXCJcblxuaW50ZXJmYWNlIFBvbGljeVZpb2xhdGlvbiB7XG4gIGZpbGU6IHN0cmluZ1xuICBsaW5lOiBudW1iZXJcbiAgdHlwZTogXCJ3aWxkY2FyZC1yZXNvdXJjZVwiIHwgXCJvdmVybHktYnJvYWQtYWN0aW9uXCIgfCBcIm5vLWNvbmRpdGlvbnNcIlxuICBzZXZlcml0eTogXCJsb3dcIiB8IFwibWVkaXVtXCIgfCBcImhpZ2hcIiB8IFwiY3JpdGljYWxcIlxuICBzbmlwcGV0OiBzdHJpbmdcbiAgc3VnZ2VzdGlvbjogc3RyaW5nXG59XG5cbmludGVyZmFjZSBBdWRpdFJlcG9ydCB7XG4gIHRpbWVzdGFtcDogc3RyaW5nXG4gIHRvdGFsRmlsZXM6IG51bWJlclxuICB2aW9sYXRpb25zRm91bmQ6IG51bWJlclxuICB2aW9sYXRpb25zOiBQb2xpY3lWaW9sYXRpb25bXVxuICBzdW1tYXJ5OiB7XG4gICAgYnlUeXBlOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+XG4gICAgYnlTZXZlcml0eTogUmVjb3JkPHN0cmluZywgbnVtYmVyPlxuICAgIGJ5RmlsZTogUmVjb3JkPHN0cmluZywgbnVtYmVyPlxuICB9XG59XG5cbi8vIFBhdHRlcm5zIHRvIGRldGVjdFxuY29uc3QgUEFUVEVSTlMgPSB7XG4gIC8vIFdpbGRjYXJkIHJlc291cmNlc1xuICB3aWxkY2FyZFJlc291cmNlOiAvcmVzb3VyY2VzOlxccypcXFs/XFxzKlsnXCJdXFwqWydcIl1cXHMqXFxdPy9naSxcbiAgd2lsZGNhcmRSZXNvdXJjZUFycmF5OiAvcmVzb3VyY2VzOlxccypcXFtcXHMqWydcIl1cXCpbJ1wiXS9naSxcblxuICAvLyBPdmVybHkgYnJvYWQgYWN0aW9uc1xuICB3aWxkY2FyZEFjdGlvbjogL2FjdGlvbnM6XFxzKlxcWz9cXHMqWydcIl0uKjpcXCpbJ1wiXVxccypcXF0/L2dpLFxuICBhZG1pbkFjdGlvbjogL2FjdGlvbnM6XFxzKlxcWz9cXHMqWydcIl1cXCo6XFwqWydcIl1cXHMqXFxdPy9naSxcblxuICAvLyBDb21tb24gYW50aS1wYXR0ZXJuc1xuICBzM1N0YXI6IC9bJ1wiXVxccypzMzpcXCpcXHMqWydcIl0vZ2ksXG4gIGR5bmFtb2RiU3RhcjogL1snXCJdXFxzKmR5bmFtb2RiOlxcKlxccypbJ1wiXS9naSxcbiAgbGFtYmRhU3RhcjogL1snXCJdXFxzKmxhbWJkYTpcXCpcXHMqWydcIl0vZ2ksXG4gIGVjMlN0YXI6IC9bJ1wiXVxccyplYzI6XFwqXFxzKlsnXCJdL2dpLFxuICBpYW1TdGFyOiAvWydcIl1cXHMqaWFtOlxcKlxccypbJ1wiXS9naSxcbn1cblxuLy8gQWxsb3dlZCB3aWxkY2FyZCBwYXR0ZXJucyAoWC1SYXksIENsb3VkV2F0Y2ggTG9ncywgZXRjLilcbmNvbnN0IEFMTE9XRURfV0lMRENBUkRTID0gW1xuICAveHJheTpQdXRUcmFjZVNlZ21lbnRzLyxcbiAgL3hyYXk6UHV0VGVsZW1ldHJ5UmVjb3Jkcy8sXG4gIC9sb2dzOkNyZWF0ZUxvZ0dyb3VwLyxcbiAgL2Nsb3Vkd2F0Y2g6UHV0TWV0cmljRGF0YS8sXG5dXG5cbmZ1bmN0aW9uIGF1ZGl0RmlsZShmaWxlUGF0aDogc3RyaW5nKTogUG9saWN5VmlvbGF0aW9uW10ge1xuICBjb25zdCB2aW9sYXRpb25zOiBQb2xpY3lWaW9sYXRpb25bXSA9IFtdXG4gIGNvbnN0IGNvbnRlbnQgPSBmcy5yZWFkRmlsZVN5bmMoZmlsZVBhdGgsIFwidXRmLThcIilcbiAgY29uc3QgbGluZXMgPSBjb250ZW50LnNwbGl0KFwiXFxuXCIpXG5cbiAgbGluZXMuZm9yRWFjaCgobGluZSwgaW5kZXgpID0+IHtcbiAgICBjb25zdCBsaW5lTnVtYmVyID0gaW5kZXggKyAxXG5cbiAgICAvLyBDaGVjayBmb3Igd2lsZGNhcmQgcmVzb3VyY2VzXG4gICAgaWYgKFBBVFRFUk5TLndpbGRjYXJkUmVzb3VyY2UudGVzdChsaW5lKSB8fCBQQVRURVJOUy53aWxkY2FyZFJlc291cmNlQXJyYXkudGVzdChsaW5lKSkge1xuICAgICAgLy8gQ2hlY2sgaWYgaXQncyBpbiBhbiBhbGxvd2VkIGNvbnRleHRcbiAgICAgIGNvbnN0IGlzQWxsb3dlZCA9IEFMTE9XRURfV0lMRENBUkRTLnNvbWUoKHBhdHRlcm4pID0+IHtcbiAgICAgICAgY29uc3QgY29udGV4dCA9IGxpbmVzLnNsaWNlKE1hdGgubWF4KDAsIGluZGV4IC0gMyksIGluZGV4ICsgMykuam9pbihcIlxcblwiKVxuICAgICAgICByZXR1cm4gcGF0dGVybi50ZXN0KGNvbnRleHQpXG4gICAgICB9KVxuXG4gICAgICBpZiAoIWlzQWxsb3dlZCkge1xuICAgICAgICB2aW9sYXRpb25zLnB1c2goe1xuICAgICAgICAgIGZpbGU6IGZpbGVQYXRoLFxuICAgICAgICAgIGxpbmU6IGxpbmVOdW1iZXIsXG4gICAgICAgICAgdHlwZTogXCJ3aWxkY2FyZC1yZXNvdXJjZVwiLFxuICAgICAgICAgIHNldmVyaXR5OiBcImhpZ2hcIixcbiAgICAgICAgICBzbmlwcGV0OiBsaW5lLnRyaW0oKSxcbiAgICAgICAgICBzdWdnZXN0aW9uOiBcIlJlcGxhY2Ugd2lsZGNhcmQgcmVzb3VyY2UgJyonIHdpdGggc3BlY2lmaWMgQVJOc1wiLFxuICAgICAgICB9KVxuICAgICAgfVxuICAgIH1cblxuICAgIC8vIENoZWNrIGZvciBvdmVybHkgYnJvYWQgYWN0aW9uc1xuICAgIGlmIChQQVRURVJOUy5hZG1pbkFjdGlvbi50ZXN0KGxpbmUpKSB7XG4gICAgICB2aW9sYXRpb25zLnB1c2goe1xuICAgICAgICBmaWxlOiBmaWxlUGF0aCxcbiAgICAgICAgbGluZTogbGluZU51bWJlcixcbiAgICAgICAgdHlwZTogXCJvdmVybHktYnJvYWQtYWN0aW9uXCIsXG4gICAgICAgIHNldmVyaXR5OiBcImNyaXRpY2FsXCIsXG4gICAgICAgIHNuaXBwZXQ6IGxpbmUudHJpbSgpLFxuICAgICAgICBzdWdnZXN0aW9uOiBcIlJlcGxhY2UgJyo6Kicgd2l0aCBzcGVjaWZpYyBhY3Rpb25zXCIsXG4gICAgICB9KVxuICAgIH1cblxuICAgIC8vIENoZWNrIGZvciBzZXJ2aWNlLWxldmVsIHdpbGRjYXJkc1xuICAgIE9iamVjdC5lbnRyaWVzKHtcbiAgICAgIHMzU3RhcjogUEFUVEVSTlMuczNTdGFyLFxuICAgICAgZHluYW1vZGJTdGFyOiBQQVRURVJOUy5keW5hbW9kYlN0YXIsXG4gICAgICBsYW1iZGFTdGFyOiBQQVRURVJOUy5sYW1iZGFTdGFyLFxuICAgICAgZWMyU3RhcjogUEFUVEVSTlMuZWMyU3RhcixcbiAgICAgIGlhbVN0YXI6IFBBVFRFUk5TLmlhbVN0YXIsXG4gICAgfSkuZm9yRWFjaCgoW25hbWUsIHBhdHRlcm5dKSA9PiB7XG4gICAgICBpZiAocGF0dGVybi50ZXN0KGxpbmUpKSB7XG4gICAgICAgIHZpb2xhdGlvbnMucHVzaCh7XG4gICAgICAgICAgZmlsZTogZmlsZVBhdGgsXG4gICAgICAgICAgbGluZTogbGluZU51bWJlcixcbiAgICAgICAgICB0eXBlOiBcIm92ZXJseS1icm9hZC1hY3Rpb25cIixcbiAgICAgICAgICBzZXZlcml0eTogbmFtZSA9PT0gXCJpYW1TdGFyXCIgPyBcImNyaXRpY2FsXCIgOiBcImhpZ2hcIixcbiAgICAgICAgICBzbmlwcGV0OiBsaW5lLnRyaW0oKSxcbiAgICAgICAgICBzdWdnZXN0aW9uOiBgUmVwbGFjZSAke25hbWUucmVwbGFjZShcIlN0YXJcIiwgXCI6KlwiKX0gd2l0aCBzcGVjaWZpYyBhY3Rpb25zYCxcbiAgICAgICAgfSlcbiAgICAgIH1cbiAgICB9KVxuICB9KVxuXG4gIHJldHVybiB2aW9sYXRpb25zXG59XG5cbmZ1bmN0aW9uIGdlbmVyYXRlUmVwb3J0KHZpb2xhdGlvbnM6IFBvbGljeVZpb2xhdGlvbltdKTogQXVkaXRSZXBvcnQge1xuICBjb25zdCBieVR5cGU6IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gPSB7fVxuICBjb25zdCBieVNldmVyaXR5OiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+ID0ge31cbiAgY29uc3QgYnlGaWxlOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+ID0ge31cblxuICB2aW9sYXRpb25zLmZvckVhY2goKHYpID0+IHtcbiAgICBieVR5cGVbdi50eXBlXSA9IChieVR5cGVbdi50eXBlXSB8fCAwKSArIDFcbiAgICBieVNldmVyaXR5W3Yuc2V2ZXJpdHldID0gKGJ5U2V2ZXJpdHlbdi5zZXZlcml0eV0gfHwgMCkgKyAxXG4gICAgYnlGaWxlW3YuZmlsZV0gPSAoYnlGaWxlW3YuZmlsZV0gfHwgMCkgKyAxXG4gIH0pXG5cbiAgcmV0dXJuIHtcbiAgICB0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICB0b3RhbEZpbGVzOiBPYmplY3Qua2V5cyhieUZpbGUpLmxlbmd0aCxcbiAgICB2aW9sYXRpb25zRm91bmQ6IHZpb2xhdGlvbnMubGVuZ3RoLFxuICAgIHZpb2xhdGlvbnM6IHZpb2xhdGlvbnMuc29ydCgoYSwgYikgPT4ge1xuICAgICAgLy8gU29ydCBieSBzZXZlcml0eSwgdGhlbiBmaWxlLCB0aGVuIGxpbmVcbiAgICAgIGNvbnN0IHNldmVyaXR5T3JkZXIgPSB7IGNyaXRpY2FsOiAwLCBoaWdoOiAxLCBtZWRpdW06IDIsIGxvdzogMyB9XG4gICAgICBjb25zdCBzZXZlcml0eURpZmYgPSBzZXZlcml0eU9yZGVyW2Euc2V2ZXJpdHldIC0gc2V2ZXJpdHlPcmRlcltiLnNldmVyaXR5XVxuICAgICAgaWYgKHNldmVyaXR5RGlmZiAhPT0gMCkgcmV0dXJuIHNldmVyaXR5RGlmZlxuXG4gICAgICBjb25zdCBmaWxlRGlmZiA9IGEuZmlsZS5sb2NhbGVDb21wYXJlKGIuZmlsZSlcbiAgICAgIGlmIChmaWxlRGlmZiAhPT0gMCkgcmV0dXJuIGZpbGVEaWZmXG5cbiAgICAgIHJldHVybiBhLmxpbmUgLSBiLmxpbmVcbiAgICB9KSxcbiAgICBzdW1tYXJ5OiB7XG4gICAgICBieVR5cGUsXG4gICAgICBieVNldmVyaXR5LFxuICAgICAgYnlGaWxlLFxuICAgIH0sXG4gIH1cbn1cblxuZnVuY3Rpb24gcHJpbnRSZXBvcnQocmVwb3J0OiBBdWRpdFJlcG9ydCk6IHZvaWQge1xuICBjb25zb2xlLmxvZyhcIlxcblwiICsgXCI9XCIucmVwZWF0KDgwKSlcbiAgY29uc29sZS5sb2coXCJJQU0gUE9MSUNZIEFVRElUIFJFUE9SVFwiKVxuICBjb25zb2xlLmxvZyhcIj1cIi5yZXBlYXQoODApKVxuICBjb25zb2xlLmxvZyhgR2VuZXJhdGVkOiAke3JlcG9ydC50aW1lc3RhbXB9YClcbiAgY29uc29sZS5sb2coYEZpbGVzIHNjYW5uZWQ6ICR7cmVwb3J0LnRvdGFsRmlsZXN9YClcbiAgY29uc29sZS5sb2coYFZpb2xhdGlvbnMgZm91bmQ6ICR7cmVwb3J0LnZpb2xhdGlvbnNGb3VuZH1gKVxuICBjb25zb2xlLmxvZygpXG5cbiAgLy8gU3VtbWFyeSBieSBzZXZlcml0eVxuICBjb25zb2xlLmxvZyhcIlZJT0xBVElPTlMgQlkgU0VWRVJJVFk6XCIpXG4gIE9iamVjdC5lbnRyaWVzKHJlcG9ydC5zdW1tYXJ5LmJ5U2V2ZXJpdHkpXG4gICAgLnNvcnQoKGEsIGIpID0+IHtcbiAgICAgIGNvbnN0IG9yZGVyID0geyBjcml0aWNhbDogMCwgaGlnaDogMSwgbWVkaXVtOiAyLCBsb3c6IDMgfVxuICAgICAgcmV0dXJuIG9yZGVyW2FbMF0gYXMga2V5b2YgdHlwZW9mIG9yZGVyXSAtIG9yZGVyW2JbMF0gYXMga2V5b2YgdHlwZW9mIG9yZGVyXVxuICAgIH0pXG4gICAgLmZvckVhY2goKFtzZXZlcml0eSwgY291bnRdKSA9PiB7XG4gICAgICBjb25zdCBpY29uID0gc2V2ZXJpdHkgPT09IFwiY3JpdGljYWxcIiB8fCBzZXZlcml0eSA9PT0gXCJoaWdoXCIgPyBcIuKdjFwiIDogXCLimqDvuI9cIlxuICAgICAgY29uc29sZS5sb2coYCAgJHtpY29ufSAke3NldmVyaXR5LnRvVXBwZXJDYXNlKCl9OiAke2NvdW50fWApXG4gICAgfSlcbiAgY29uc29sZS5sb2coKVxuXG4gIC8vIFN1bW1hcnkgYnkgdHlwZVxuICBjb25zb2xlLmxvZyhcIlZJT0xBVElPTlMgQlkgVFlQRTpcIilcbiAgT2JqZWN0LmVudHJpZXMocmVwb3J0LnN1bW1hcnkuYnlUeXBlKS5mb3JFYWNoKChbdHlwZSwgY291bnRdKSA9PiB7XG4gICAgY29uc29sZS5sb2coYCAg4oCiICR7dHlwZX06ICR7Y291bnR9YClcbiAgfSlcbiAgY29uc29sZS5sb2coKVxuXG4gIC8vIFRvcCB2aW9sYXRpbmcgZmlsZXNcbiAgY29uc29sZS5sb2coXCJUT1AgMTAgRklMRVMgV0lUSCBNT1NUIFZJT0xBVElPTlM6XCIpXG4gIE9iamVjdC5lbnRyaWVzKHJlcG9ydC5zdW1tYXJ5LmJ5RmlsZSlcbiAgICAuc29ydCgoYSwgYikgPT4gYlsxXSAtIGFbMV0pXG4gICAgLnNsaWNlKDAsIDEwKVxuICAgIC5mb3JFYWNoKChbZmlsZSwgY291bnRdKSA9PiB7XG4gICAgICBjb25zdCByZWxQYXRoID0gcGF0aC5yZWxhdGl2ZShwcm9jZXNzLmN3ZCgpLCBmaWxlKVxuICAgICAgY29uc29sZS5sb2coYCAg4oCiICR7cmVsUGF0aH06ICR7Y291bnR9IHZpb2xhdGlvbnNgKVxuICAgIH0pXG4gIGNvbnNvbGUubG9nKClcblxuICAvLyBEZXRhaWxlZCB2aW9sYXRpb25zIChzaG93IGZpcnN0IDIwKVxuICBjb25zb2xlLmxvZyhcIkRFVEFJTEVEIFZJT0xBVElPTlMgKGZpcnN0IDIwKTpcIilcbiAgY29uc29sZS5sb2coXCItXCIucmVwZWF0KDgwKSlcbiAgcmVwb3J0LnZpb2xhdGlvbnMuc2xpY2UoMCwgMjApLmZvckVhY2goKHYsIGluZGV4KSA9PiB7XG4gICAgY29uc3QgcmVsUGF0aCA9IHBhdGgucmVsYXRpdmUocHJvY2Vzcy5jd2QoKSwgdi5maWxlKVxuICAgIGNvbnNvbGUubG9nKGBcXG4ke2luZGV4ICsgMX0uIFske3Yuc2V2ZXJpdHkudG9VcHBlckNhc2UoKX1dICR7cmVsUGF0aH06JHt2LmxpbmV9YClcbiAgICBjb25zb2xlLmxvZyhgICAgVHlwZTogJHt2LnR5cGV9YClcbiAgICBjb25zb2xlLmxvZyhgICAgQ29kZTogJHt2LnNuaXBwZXR9YClcbiAgICBjb25zb2xlLmxvZyhgICAgRml4OiAgJHt2LnN1Z2dlc3Rpb259YClcbiAgfSlcblxuICBpZiAocmVwb3J0LnZpb2xhdGlvbnNGb3VuZCA+IDIwKSB7XG4gICAgY29uc29sZS5sb2coYFxcbi4uLiBhbmQgJHtyZXBvcnQudmlvbGF0aW9uc0ZvdW5kIC0gMjB9IG1vcmUgdmlvbGF0aW9uc2ApXG4gIH1cblxuICBjb25zb2xlLmxvZyhcIlxcblwiICsgXCI9XCIucmVwZWF0KDgwKSlcbiAgY29uc29sZS5sb2coYFRvdGFsIHZpb2xhdGlvbnM6ICR7cmVwb3J0LnZpb2xhdGlvbnNGb3VuZH1gKVxuICBjb25zb2xlLmxvZyhcIj1cIi5yZXBlYXQoODApICsgXCJcXG5cIilcbn1cblxuZnVuY3Rpb24gc2F2ZVJlcG9ydChyZXBvcnQ6IEF1ZGl0UmVwb3J0LCBvdXRwdXRQYXRoOiBzdHJpbmcpOiB2b2lkIHtcbiAgZnMud3JpdGVGaWxlU3luYyhvdXRwdXRQYXRoLCBKU09OLnN0cmluZ2lmeShyZXBvcnQsIG51bGwsIDIpKVxuICBjb25zb2xlLmxvZyhgRnVsbCByZXBvcnQgc2F2ZWQgdG86ICR7b3V0cHV0UGF0aH1gKVxufVxuXG4vLyBNYWluIGV4ZWN1dGlvblxuYXN5bmMgZnVuY3Rpb24gbWFpbigpIHtcbiAgY29uc29sZS5sb2coXCJTdGFydGluZyBJQU0gcG9saWN5IGF1ZGl0Li4uXCIpXG5cbiAgLy8gRmluZCBhbGwgVHlwZVNjcmlwdCBmaWxlcyBpbiB0aGUgaW5mcmEgZGlyZWN0b3J5XG4gIGNvbnN0IGZpbGVzID0gZ2xvYi5zeW5jKFwiaW5mcmEvKiovKi50c1wiLCB7XG4gICAgaWdub3JlOiBbXG4gICAgICBcIioqL25vZGVfbW9kdWxlcy8qKlwiLFxuICAgICAgXCIqKi8qLmQudHNcIixcbiAgICAgIFwiKiovZGlzdC8qKlwiLFxuICAgICAgXCIqKi9jZGsub3V0LyoqXCIsXG4gICAgXSxcbiAgfSlcblxuICBjb25zb2xlLmxvZyhgRm91bmQgJHtmaWxlcy5sZW5ndGh9IGZpbGVzIHRvIGF1ZGl0XFxuYClcblxuICAvLyBBdWRpdCBhbGwgZmlsZXNcbiAgY29uc3QgYWxsVmlvbGF0aW9uczogUG9saWN5VmlvbGF0aW9uW10gPSBbXVxuICBmaWxlcy5mb3JFYWNoKChmaWxlKSA9PiB7XG4gICAgY29uc3QgdmlvbGF0aW9ucyA9IGF1ZGl0RmlsZShmaWxlKVxuICAgIGFsbFZpb2xhdGlvbnMucHVzaCguLi52aW9sYXRpb25zKVxuICB9KVxuXG4gIC8vIEdlbmVyYXRlIGFuZCBwcmludCByZXBvcnRcbiAgY29uc3QgcmVwb3J0ID0gZ2VuZXJhdGVSZXBvcnQoYWxsVmlvbGF0aW9ucylcbiAgcHJpbnRSZXBvcnQocmVwb3J0KVxuXG4gIC8vIFNhdmUgZGV0YWlsZWQgcmVwb3J0XG4gIGNvbnN0IG91dHB1dFBhdGggPSBwYXRoLmpvaW4oX19kaXJuYW1lLCBcIi4uL2F1ZGl0LXJlcG9ydC5qc29uXCIpXG4gIHNhdmVSZXBvcnQocmVwb3J0LCBvdXRwdXRQYXRoKVxuXG4gIC8vIEV4aXQgd2l0aCBlcnJvciBjb2RlIGlmIHZpb2xhdGlvbnMgZm91bmRcbiAgaWYgKHJlcG9ydC52aW9sYXRpb25zRm91bmQgPiAwKSB7XG4gICAgY29uc29sZS5lcnJvcihgXFxu4pqg77iPICBGb3VuZCAke3JlcG9ydC52aW9sYXRpb25zRm91bmR9IHBvbGljeSB2aW9sYXRpb25zIHRoYXQgbmVlZCBhdHRlbnRpb25gKVxuICAgIHByb2Nlc3MuZXhpdCgxKVxuICB9XG5cbiAgY29uc29sZS5sb2coXCJcXG7inIUgTm8gcG9saWN5IHZpb2xhdGlvbnMgZm91bmQhXCIpXG4gIHByb2Nlc3MuZXhpdCgwKVxufVxuXG4vLyBSdW4gdGhlIGF1ZGl0XG5tYWluKCkuY2F0Y2goKGVycm9yKSA9PiB7XG4gIGNvbnNvbGUuZXJyb3IoXCJFcnJvciBydW5uaW5nIGF1ZGl0OlwiLCBlcnJvcilcbiAgcHJvY2Vzcy5leGl0KDEpXG59KVxuIl19