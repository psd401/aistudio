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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXVkaXQtaWFtLXBvbGljaWVzLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiYXVkaXQtaWFtLXBvbGljaWVzLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBRUE7Ozs7Ozs7OztHQVNHOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUVILHVDQUF3QjtBQUN4QiwyQ0FBNEI7QUFDNUIsMkNBQTRCO0FBdUI1QixxQkFBcUI7QUFDckIsTUFBTSxRQUFRLEdBQUc7SUFDZixxQkFBcUI7SUFDckIsZ0JBQWdCLEVBQUUsdUNBQXVDO0lBQ3pELHFCQUFxQixFQUFFLGdDQUFnQztJQUV2RCx1QkFBdUI7SUFDdkIsY0FBYyxFQUFFLHdDQUF3QztJQUN4RCxXQUFXLEVBQUUsd0NBQXdDO0lBRXJELHVCQUF1QjtJQUN2QixNQUFNLEVBQUUsdUJBQXVCO0lBQy9CLFlBQVksRUFBRSw2QkFBNkI7SUFDM0MsVUFBVSxFQUFFLDJCQUEyQjtJQUN2QyxPQUFPLEVBQUUsd0JBQXdCO0lBQ2pDLE9BQU8sRUFBRSx3QkFBd0I7Q0FDbEMsQ0FBQTtBQUVELDJEQUEyRDtBQUMzRCxNQUFNLGlCQUFpQixHQUFHO0lBQ3hCLHVCQUF1QjtJQUN2QiwwQkFBMEI7SUFDMUIscUJBQXFCO0lBQ3JCLDBCQUEwQjtDQUMzQixDQUFBO0FBRUQsU0FBUyxTQUFTLENBQUMsUUFBZ0I7SUFDakMsTUFBTSxVQUFVLEdBQXNCLEVBQUUsQ0FBQTtJQUN4QyxNQUFNLE9BQU8sR0FBRyxFQUFFLENBQUMsWUFBWSxDQUFDLFFBQVEsRUFBRSxPQUFPLENBQUMsQ0FBQTtJQUNsRCxNQUFNLEtBQUssR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFBO0lBRWpDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFLEVBQUU7UUFDNUIsTUFBTSxVQUFVLEdBQUcsS0FBSyxHQUFHLENBQUMsQ0FBQTtRQUU1QiwrQkFBK0I7UUFDL0Is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LENBQUMsQ0FBQTtRQUNsQyxhQUFhLENBQUMsSUFBSSxDQUFDLEdBQUcsVUFBVSxDQUFDLENBQUE7SUFDbkMsQ0FBQyxDQUFDLENBQUE7SUFFRiw0QkFBNEI7SUFDNUIsTUFBTSxNQUFNLEdBQUcsY0FBYyxDQUFDLGFBQWEsQ0FBQyxDQUFBO0lBQzVDLFdBQVcsQ0FBQyxNQUFNLENBQUMsQ0FBQTtJQUVuQix1QkFBdUI7SUFDdkIsTUFBTSxVQUFVLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxTQUFTLEVBQUUsc0JBQXNCLENBQUMsQ0FBQTtJQUMvRCxVQUFVLENBQUMsTUFBTSxFQUFFLFVBQVUsQ0FBQyxDQUFBO0lBRTlCLDJDQUEyQztJQUMzQyxJQUFJLE1BQU0sQ0FBQyxlQUFlLEdBQUcsQ0FBQyxFQUFFLENBQUM7UUFDL0IsT0FBTyxDQUFDLEtBQUssQ0FBQyxlQUFlLE1BQU0sQ0FBQyxlQUFlLHdDQUF3QyxDQUFDLENBQUE7UUFDNUYsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQTtJQUNqQixDQUFDO0lBRUQsT0FBTyxDQUFDLEdBQUcsQ0FBQyxpQ0FBaUMsQ0FBQyxDQUFBO0lBQzlDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUE7QUFDakIsQ0FBQztBQUVELGdCQUFnQjtBQUNoQixJQUFJLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRTtJQUNyQixPQUFPLENBQUMsS0FBSyxDQUFDLHNCQUFzQixFQUFFLEtBQUssQ0FBQyxDQUFBO0lBQzVDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUE7QUFDakIsQ0FBQyxDQUFDLENBQUEiLCJzb3VyY2VzQ29udGVudCI6WyIjIS91c3IvYmluL2VudiB0cy1ub2RlXG5cbi8qKlxuICogSUFNIFBvbGljeSBBdWRpdCBTY3JpcHRcbiAqXG4gKiBTY2FucyBDREsgaW5mcmFzdHJ1Y3R1cmUgY29kZSB0byBpZGVudGlmeSBvdmVybHkgcGVybWlzc2l2ZSBJQU0gcG9saWNpZXNcbiAqIHdpdGggd2lsZGNhcmQgcmVzb3VyY2VzLiBUaGlzIHNjcmlwdCBoZWxwcyBpZGVudGlmeSB0aGUgMTE2IHZpb2xhdGlvbnNcbiAqIG1lbnRpb25lZCBpbiBpc3N1ZSAjMzc5LlxuICpcbiAqIFVzYWdlOlxuICogICBucHggdHMtbm9kZSBpbmZyYS9zY3JpcHRzL2F1ZGl0LWlhbS1wb2xpY2llcy50c1xuICovXG5cbmltcG9ydCAqIGFzIGZzIGZyb20gXCJmc1wiXG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gXCJwYXRoXCJcbmltcG9ydCAqIGFzIGdsb2IgZnJvbSBcImdsb2JcIlxuXG5pbnRlcmZhY2UgUG9saWN5VmlvbGF0aW9uIHtcbiAgZmlsZTogc3RyaW5nXG4gIGxpbmU6IG51bWJlclxuICB0eXBlOiBcIndpbGRjYXJkLXJlc291cmNlXCIgfCBcIm92ZXJseS1icm9hZC1hY3Rpb25cIiB8IFwibm8tY29uZGl0aW9uc1wiXG4gIHNldmVyaXR5OiBcImxvd1wiIHwgXCJtZWRpdW1cIiB8IFwiaGlnaFwiIHwgXCJjcml0aWNhbFwiXG4gIHNuaXBwZXQ6IHN0cmluZ1xuICBzdWdnZXN0aW9uOiBzdHJpbmdcbn1cblxuaW50ZXJmYWNlIEF1ZGl0UmVwb3J0IHtcbiAgdGltZXN0YW1wOiBzdHJpbmdcbiAgdG90YWxGaWxlczogbnVtYmVyXG4gIHZpb2xhdGlvbnNGb3VuZDogbnVtYmVyXG4gIHZpb2xhdGlvbnM6IFBvbGljeVZpb2xhdGlvbltdXG4gIHN1bW1hcnk6IHtcbiAgICBieVR5cGU6IFJlY29yZDxzdHJpbmcsIG51bWJlcj5cbiAgICBieVNldmVyaXR5OiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+XG4gICAgYnlGaWxlOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+XG4gIH1cbn1cblxuLy8gUGF0dGVybnMgdG8gZGV0ZWN0XG5jb25zdCBQQVRURVJOUyA9IHtcbiAgLy8gV2lsZGNhcmQgcmVzb3VyY2VzXG4gIHdpbGRjYXJkUmVzb3VyY2U6IC9yZXNvdXJjZXM6XFxzKlxcWz9cXHMqWydcIl1cXCpbJ1wiXVxccypcXF0/L2dpLFxuICB3aWxkY2FyZFJlc291cmNlQXJyYXk6IC9yZXNvdXJjZXM6XFxzKlxcW1xccypbJ1wiXVxcKlsnXCJdL2dpLFxuXG4gIC8vIE92ZXJseSBicm9hZCBhY3Rpb25zXG4gIHdpbGRjYXJkQWN0aW9uOiAvYWN0aW9uczpcXHMqXFxbP1xccypbJ1wiXS4qOlxcKlsnXCJdXFxzKlxcXT8vZ2ksXG4gIGFkbWluQWN0aW9uOiAvYWN0aW9uczpcXHMqXFxbP1xccypbJ1wiXVxcKjpcXCpbJ1wiXVxccypcXF0/L2dpLFxuXG4gIC8vIENvbW1vbiBhbnRpLXBhdHRlcm5zXG4gIHMzU3RhcjogL1snXCJdXFxzKnMzOlxcKlxccypbJ1wiXS9naSxcbiAgZHluYW1vZGJTdGFyOiAvWydcIl1cXHMqZHluYW1vZGI6XFwqXFxzKlsnXCJdL2dpLFxuICBsYW1iZGFTdGFyOiAvWydcIl1cXHMqbGFtYmRhOlxcKlxccypbJ1wiXS9naSxcbiAgZWMyU3RhcjogL1snXCJdXFxzKmVjMjpcXCpcXHMqWydcIl0vZ2ksXG4gIGlhbVN0YXI6IC9bJ1wiXVxccyppYW06XFwqXFxzKlsnXCJdL2dpLFxufVxuXG4vLyBBbGxvd2VkIHdpbGRjYXJkIHBhdHRlcm5zIChYLVJheSwgQ2xvdWRXYXRjaCBMb2dzLCBldGMuKVxuY29uc3QgQUxMT1dFRF9XSUxEQ0FSRFMgPSBbXG4gIC94cmF5OlB1dFRyYWNlU2VnbWVudHMvLFxuICAveHJheTpQdXRUZWxlbWV0cnlSZWNvcmRzLyxcbiAgL2xvZ3M6Q3JlYXRlTG9nR3JvdXAvLFxuICAvY2xvdWR3YXRjaDpQdXRNZXRyaWNEYXRhLyxcbl1cblxuZnVuY3Rpb24gYXVkaXRGaWxlKGZpbGVQYXRoOiBzdHJpbmcpOiBQb2xpY3lWaW9sYXRpb25bXSB7XG4gIGNvbnN0IHZpb2xhdGlvbnM6IFBvbGljeVZpb2xhdGlvbltdID0gW11cbiAgY29uc3QgY29udGVudCA9IGZzLnJlYWRGaWxlU3luYyhmaWxlUGF0aCwgXCJ1dGYtOFwiKVxuICBjb25zdCBsaW5lcyA9IGNvbnRlbnQuc3BsaXQoXCJcXG5cIilcblxuICBsaW5lcy5mb3JFYWNoKChsaW5lLCBpbmRleCkgPT4ge1xuICAgIGNvbnN0IGxpbmVOdW1iZXIgPSBpbmRleCArIDFcblxuICAgIC8vIENoZWNrIGZvciB3aWxkY2FyZCByZXNvdXJjZXNcbiAgICBpZiAoUEFUVEVSTlMud2lsZGNhcmRSZXNvdXJjZS50ZXN0KGxpbmUpIHx8IFBBVFRFUk5TLndpbGRjYXJkUmVzb3VyY2VBcnJheS50ZXN0KGxpbmUpKSB7XG4gICAgICAvLyBDaGVjayBpZiBpdCdzIGluIGFuIGFsbG93ZWQgY29udGV4dFxuICAgICAgY29uc3QgaXNBbGxvd2VkID0gQUxMT1dFRF9XSUxEQ0FSRFMuc29tZSgocGF0dGVybikgPT4ge1xuICAgICAgICBjb25zdCBjb250ZXh0ID0gbGluZXMuc2xpY2UoTWF0aC5tYXgoMCwgaW5kZXggLSAzKSwgaW5kZXggKyAzKS5qb2luKFwiXFxuXCIpXG4gICAgICAgIHJldHVybiBwYXR0ZXJuLnRlc3QoY29udGV4dClcbiAgICAgIH0pXG5cbiAgICAgIGlmICghaXNBbGxvd2VkKSB7XG4gICAgICAgIHZpb2xhdGlvbnMucHVzaCh7XG4gICAgICAgICAgZmlsZTogZmlsZVBhdGgsXG4gICAgICAgICAgbGluZTogbGluZU51bWJlcixcbiAgICAgICAgICB0eXBlOiBcIndpbGRjYXJkLXJlc291cmNlXCIsXG4gICAgICAgICAgc2V2ZXJpdHk6IFwiaGlnaFwiLFxuICAgICAgICAgIHNuaXBwZXQ6IGxpbmUudHJpbSgpLFxuICAgICAgICAgIHN1Z2dlc3Rpb246IFwiUmVwbGFjZSB3aWxkY2FyZCByZXNvdXJjZSAnKicgd2l0aCBzcGVjaWZpYyBBUk5zXCIsXG4gICAgICAgIH0pXG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gQ2hlY2sgZm9yIG92ZXJseSBicm9hZCBhY3Rpb25zXG4gICAgaWYgKFBBVFRFUk5TLmFkbWluQWN0aW9uLnRlc3QobGluZSkpIHtcbiAgICAgIHZpb2xhdGlvbnMucHVzaCh7XG4gICAgICAgIGZpbGU6IGZpbGVQYXRoLFxuICAgICAgICBsaW5lOiBsaW5lTnVtYmVyLFxuICAgICAgICB0eXBlOiBcIm92ZXJseS1icm9hZC1hY3Rpb25cIixcbiAgICAgICAgc2V2ZXJpdHk6IFwiY3JpdGljYWxcIixcbiAgICAgICAgc25pcHBldDogbGluZS50cmltKCksXG4gICAgICAgIHN1Z2dlc3Rpb246IFwiUmVwbGFjZSAnKjoqJyB3aXRoIHNwZWNpZmljIGFjdGlvbnNcIixcbiAgICAgIH0pXG4gICAgfVxuXG4gICAgLy8gQ2hlY2sgZm9yIHNlcnZpY2UtbGV2ZWwgd2lsZGNhcmRzXG4gICAgT2JqZWN0LmVudHJpZXMoe1xuICAgICAgczNTdGFyOiBQQVRURVJOUy5zM1N0YXIsXG4gICAgICBkeW5hbW9kYlN0YXI6IFBBVFRFUk5TLmR5bmFtb2RiU3RhcixcbiAgICAgIGxhbWJkYVN0YXI6IFBBVFRFUk5TLmxhbWJkYVN0YXIsXG4gICAgICBlYzJTdGFyOiBQQVRURVJOUy5lYzJTdGFyLFxuICAgICAgaWFtU3RhcjogUEFUVEVSTlMuaWFtU3RhcixcbiAgICB9KS5mb3JFYWNoKChbbmFtZSwgcGF0dGVybl0pID0+IHtcbiAgICAgIGlmIChwYXR0ZXJuLnRlc3QobGluZSkpIHtcbiAgICAgICAgdmlvbGF0aW9ucy5wdXNoKHtcbiAgICAgICAgICBmaWxlOiBmaWxlUGF0aCxcbiAgICAgICAgICBsaW5lOiBsaW5lTnVtYmVyLFxuICAgICAgICAgIHR5cGU6IFwib3Zlcmx5LWJyb2FkLWFjdGlvblwiLFxuICAgICAgICAgIHNldmVyaXR5OiBuYW1lID09PSBcImlhbVN0YXJcIiA/IFwiY3JpdGljYWxcIiA6IFwiaGlnaFwiLFxuICAgICAgICAgIHNuaXBwZXQ6IGxpbmUudHJpbSgpLFxuICAgICAgICAgIHN1Z2dlc3Rpb246IGBSZXBsYWNlICR7bmFtZS5yZXBsYWNlKFwiU3RhclwiLCBcIjoqXCIpfSB3aXRoIHNwZWNpZmljIGFjdGlvbnNgLFxuICAgICAgICB9KVxuICAgICAgfVxuICAgIH0pXG4gIH0pXG5cbiAgcmV0dXJuIHZpb2xhdGlvbnNcbn1cblxuZnVuY3Rpb24gZ2VuZXJhdGVSZXBvcnQodmlvbGF0aW9uczogUG9saWN5VmlvbGF0aW9uW10pOiBBdWRpdFJlcG9ydCB7XG4gIGNvbnN0IGJ5VHlwZTogUmVjb3JkPHN0cmluZywgbnVtYmVyPiA9IHt9XG4gIGNvbnN0IGJ5U2V2ZXJpdHk6IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gPSB7fVxuICBjb25zdCBieUZpbGU6IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gPSB7fVxuXG4gIHZpb2xhdGlvbnMuZm9yRWFjaCgodikgPT4ge1xuICAgIGJ5VHlwZVt2LnR5cGVdID0gKGJ5VHlwZVt2LnR5cGVdIHx8IDApICsgMVxuICAgIGJ5U2V2ZXJpdHlbdi5zZXZlcml0eV0gPSAoYnlTZXZlcml0eVt2LnNldmVyaXR5XSB8fCAwKSArIDFcbiAgICBieUZpbGVbdi5maWxlXSA9IChieUZpbGVbdi5maWxlXSB8fCAwKSArIDFcbiAgfSlcblxuICByZXR1cm4ge1xuICAgIHRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgIHRvdGFsRmlsZXM6IE9iamVjdC5rZXlzKGJ5RmlsZSkubGVuZ3RoLFxuICAgIHZpb2xhdGlvbnNGb3VuZDogdmlvbGF0aW9ucy5sZW5ndGgsXG4gICAgdmlvbGF0aW9uczogdmlvbGF0aW9ucy5zb3J0KChhLCBiKSA9PiB7XG4gICAgICAvLyBTb3J0IGJ5IHNldmVyaXR5LCB0aGVuIGZpbGUsIHRoZW4gbGluZVxuICAgICAgY29uc3Qgc2V2ZXJpdHlPcmRlciA9IHsgY3JpdGljYWw6IDAsIGhpZ2g6IDEsIG1lZGl1bTogMiwgbG93OiAzIH1cbiAgICAgIGNvbnN0IHNldmVyaXR5RGlmZiA9IHNldmVyaXR5T3JkZXJbYS5zZXZlcml0eV0gLSBzZXZlcml0eU9yZGVyW2Iuc2V2ZXJpdHldXG4gICAgICBpZiAoc2V2ZXJpdHlEaWZmICE9PSAwKSByZXR1cm4gc2V2ZXJpdHlEaWZmXG5cbiAgICAgIGNvbnN0IGZpbGVEaWZmID0gYS5maWxlLmxvY2FsZUNvbXBhcmUoYi5maWxlKVxuICAgICAgaWYgKGZpbGVEaWZmICE9PSAwKSByZXR1cm4gZmlsZURpZmZcblxuICAgICAgcmV0dXJuIGEubGluZSAtIGIubGluZVxuICAgIH0pLFxuICAgIHN1bW1hcnk6IHtcbiAgICAgIGJ5VHlwZSxcbiAgICAgIGJ5U2V2ZXJpdHksXG4gICAgICBieUZpbGUsXG4gICAgfSxcbiAgfVxufVxuXG5mdW5jdGlvbiBwcmludFJlcG9ydChyZXBvcnQ6IEF1ZGl0UmVwb3J0KTogdm9pZCB7XG4gIGNvbnNvbGUubG9nKFwiXFxuXCIgKyBcIj1cIi5yZXBlYXQoODApKVxuICBjb25zb2xlLmxvZyhcIklBTSBQT0xJQ1kgQVVESVQgUkVQT1JUXCIpXG4gIGNvbnNvbGUubG9nKFwiPVwiLnJlcGVhdCg4MCkpXG4gIGNvbnNvbGUubG9nKGBHZW5lcmF0ZWQ6ICR7cmVwb3J0LnRpbWVzdGFtcH1gKVxuICBjb25zb2xlLmxvZyhgRmlsZXMgc2Nhbm5lZDogJHtyZXBvcnQudG90YWxGaWxlc31gKVxuICBjb25zb2xlLmxvZyhgVmlvbGF0aW9ucyBmb3VuZDogJHtyZXBvcnQudmlvbGF0aW9uc0ZvdW5kfWApXG4gIGNvbnNvbGUubG9nKClcblxuICAvLyBTdW1tYXJ5IGJ5IHNldmVyaXR5XG4gIGNvbnNvbGUubG9nKFwiVklPTEFUSU9OUyBCWSBTRVZFUklUWTpcIilcbiAgT2JqZWN0LmVudHJpZXMocmVwb3J0LnN1bW1hcnkuYnlTZXZlcml0eSlcbiAgICAuc29ydCgoYSwgYikgPT4ge1xuICAgICAgY29uc3Qgb3JkZXIgPSB7IGNyaXRpY2FsOiAwLCBoaWdoOiAxLCBtZWRpdW06IDIsIGxvdzogMyB9XG4gICAgICByZXR1cm4gb3JkZXJbYVswXSBhcyBrZXlvZiB0eXBlb2Ygb3JkZXJdIC0gb3JkZXJbYlswXSBhcyBrZXlvZiB0eXBlb2Ygb3JkZXJdXG4gICAgfSlcbiAgICAuZm9yRWFjaCgoW3NldmVyaXR5LCBjb3VudF0pID0+IHtcbiAgICAgIGNvbnN0IGljb24gPSBzZXZlcml0eSA9PT0gXCJjcml0aWNhbFwiIHx8IHNldmVyaXR5ID09PSBcImhpZ2hcIiA/IFwi4p2MXCIgOiBcIuKaoO+4j1wiXG4gICAgICBjb25zb2xlLmxvZyhgICAke2ljb259ICR7c2V2ZXJpdHkudG9VcHBlckNhc2UoKX06ICR7Y291bnR9YClcbiAgICB9KVxuICBjb25zb2xlLmxvZygpXG5cbiAgLy8gU3VtbWFyeSBieSB0eXBlXG4gIGNvbnNvbGUubG9nKFwiVklPTEFUSU9OUyBCWSBUWVBFOlwiKVxuICBPYmplY3QuZW50cmllcyhyZXBvcnQuc3VtbWFyeS5ieVR5cGUpLmZvckVhY2goKFt0eXBlLCBjb3VudF0pID0+IHtcbiAgICBjb25zb2xlLmxvZyhgICDigKIgJHt0eXBlfTogJHtjb3VudH1gKVxuICB9KVxuICBjb25zb2xlLmxvZygpXG5cbiAgLy8gVG9wIHZpb2xhdGluZyBmaWxlc1xuICBjb25zb2xlLmxvZyhcIlRPUCAxMCBGSUxFUyBXSVRIIE1PU1QgVklPTEFUSU9OUzpcIilcbiAgT2JqZWN0LmVudHJpZXMocmVwb3J0LnN1bW1hcnkuYnlGaWxlKVxuICAgIC5zb3J0KChhLCBiKSA9PiBiWzFdIC0gYVsxXSlcbiAgICAuc2xpY2UoMCwgMTApXG4gICAgLmZvckVhY2goKFtmaWxlLCBjb3VudF0pID0+IHtcbiAgICAgIGNvbnN0IHJlbFBhdGggPSBwYXRoLnJlbGF0aXZlKHByb2Nlc3MuY3dkKCksIGZpbGUpXG4gICAgICBjb25zb2xlLmxvZyhgICDigKIgJHtyZWxQYXRofTogJHtjb3VudH0gdmlvbGF0aW9uc2ApXG4gICAgfSlcbiAgY29uc29sZS5sb2coKVxuXG4gIC8vIERldGFpbGVkIHZpb2xhdGlvbnMgKHNob3cgZmlyc3QgMjApXG4gIGNvbnNvbGUubG9nKFwiREVUQUlMRUQgVklPTEFUSU9OUyAoZmlyc3QgMjApOlwiKVxuICBjb25zb2xlLmxvZyhcIi1cIi5yZXBlYXQoODApKVxuICByZXBvcnQudmlvbGF0aW9ucy5zbGljZSgwLCAyMCkuZm9yRWFjaCgodiwgaW5kZXgpID0+IHtcbiAgICBjb25zdCByZWxQYXRoID0gcGF0aC5yZWxhdGl2ZShwcm9jZXNzLmN3ZCgpLCB2LmZpbGUpXG4gICAgY29uc29sZS5sb2coYFxcbiR7aW5kZXggKyAxfS4gWyR7di5zZXZlcml0eS50b1VwcGVyQ2FzZSgpfV0gJHtyZWxQYXRofToke3YubGluZX1gKVxuICAgIGNvbnNvbGUubG9nKGAgICBUeXBlOiAke3YudHlwZX1gKVxuICAgIGNvbnNvbGUubG9nKGAgICBDb2RlOiAke3Yuc25pcHBldH1gKVxuICAgIGNvbnNvbGUubG9nKGAgICBGaXg6ICAke3Yuc3VnZ2VzdGlvbn1gKVxuICB9KVxuXG4gIGlmIChyZXBvcnQudmlvbGF0aW9uc0ZvdW5kID4gMjApIHtcbiAgICBjb25zb2xlLmxvZyhgXFxuLi4uIGFuZCAke3JlcG9ydC52aW9sYXRpb25zRm91bmQgLSAyMH0gbW9yZSB2aW9sYXRpb25zYClcbiAgfVxuXG4gIGNvbnNvbGUubG9nKFwiXFxuXCIgKyBcIj1cIi5yZXBlYXQoODApKVxuICBjb25zb2xlLmxvZyhgVG90YWwgdmlvbGF0aW9uczogJHtyZXBvcnQudmlvbGF0aW9uc0ZvdW5kfWApXG4gIGNvbnNvbGUubG9nKFwiPVwiLnJlcGVhdCg4MCkgKyBcIlxcblwiKVxufVxuXG5mdW5jdGlvbiBzYXZlUmVwb3J0KHJlcG9ydDogQXVkaXRSZXBvcnQsIG91dHB1dFBhdGg6IHN0cmluZyk6IHZvaWQge1xuICBmcy53cml0ZUZpbGVTeW5jKG91dHB1dFBhdGgsIEpTT04uc3RyaW5naWZ5KHJlcG9ydCwgbnVsbCwgMikpXG4gIGNvbnNvbGUubG9nKGBGdWxsIHJlcG9ydCBzYXZlZCB0bzogJHtvdXRwdXRQYXRofWApXG59XG5cbi8vIE1haW4gZXhlY3V0aW9uXG5hc3luYyBmdW5jdGlvbiBtYWluKCkge1xuICBjb25zb2xlLmxvZyhcIlN0YXJ0aW5nIElBTSBwb2xpY3kgYXVkaXQuLi5cIilcblxuICAvLyBGaW5kIGFsbCBUeXBlU2NyaXB0IGZpbGVzIGluIHRoZSBpbmZyYSBkaXJlY3RvcnlcbiAgY29uc3QgZmlsZXMgPSBnbG9iLnN5bmMoXCJpbmZyYS8qKi8qLnRzXCIsIHtcbiAgICBpZ25vcmU6IFtcbiAgICAgIFwiKiovbm9kZV9tb2R1bGVzLyoqXCIsXG4gICAgICBcIioqLyouZC50c1wiLFxuICAgICAgXCIqKi9kaXN0LyoqXCIsXG4gICAgICBcIioqL2Nkay5vdXQvKipcIixcbiAgICBdLFxuICB9KVxuXG4gIGNvbnNvbGUubG9nKGBGb3VuZCAke2ZpbGVzLmxlbmd0aH0gZmlsZXMgdG8gYXVkaXRcXG5gKVxuXG4gIC8vIEF1ZGl0IGFsbCBmaWxlc1xuICBjb25zdCBhbGxWaW9sYXRpb25zOiBQb2xpY3lWaW9sYXRpb25bXSA9IFtdXG4gIGZpbGVzLmZvckVhY2goKGZpbGUpID0+IHtcbiAgICBjb25zdCB2aW9sYXRpb25zID0gYXVkaXRGaWxlKGZpbGUpXG4gICAgYWxsVmlvbGF0aW9ucy5wdXNoKC4uLnZpb2xhdGlvbnMpXG4gIH0pXG5cbiAgLy8gR2VuZXJhdGUgYW5kIHByaW50IHJlcG9ydFxuICBjb25zdCByZXBvcnQgPSBnZW5lcmF0ZVJlcG9ydChhbGxWaW9sYXRpb25zKVxuICBwcmludFJlcG9ydChyZXBvcnQpXG5cbiAgLy8gU2F2ZSBkZXRhaWxlZCByZXBvcnRcbiAgY29uc3Qgb3V0cHV0UGF0aCA9IHBhdGguam9pbihfX2Rpcm5hbWUsIFwiLi4vYXVkaXQtcmVwb3J0Lmpzb25cIilcbiAgc2F2ZVJlcG9ydChyZXBvcnQsIG91dHB1dFBhdGgpXG5cbiAgLy8gRXhpdCB3aXRoIGVycm9yIGNvZGUgaWYgdmlvbGF0aW9ucyBmb3VuZFxuICBpZiAocmVwb3J0LnZpb2xhdGlvbnNGb3VuZCA+IDApIHtcbiAgICBjb25zb2xlLmVycm9yKGBcXG7imqDvuI8gIEZvdW5kICR7cmVwb3J0LnZpb2xhdGlvbnNGb3VuZH0gcG9saWN5IHZpb2xhdGlvbnMgdGhhdCBuZWVkIGF0dGVudGlvbmApXG4gICAgcHJvY2Vzcy5leGl0KDEpXG4gIH1cblxuICBjb25zb2xlLmxvZyhcIlxcbuKchSBObyBwb2xpY3kgdmlvbGF0aW9ucyBmb3VuZCFcIilcbiAgcHJvY2Vzcy5leGl0KDApXG59XG5cbi8vIFJ1biB0aGUgYXVkaXRcbm1haW4oKS5jYXRjaCgoZXJyb3IpID0+IHtcbiAgY29uc29sZS5lcnJvcihcIkVycm9yIHJ1bm5pbmcgYXVkaXQ6XCIsIGVycm9yKVxuICBwcm9jZXNzLmV4aXQoMSlcbn0pXG4iXX0=