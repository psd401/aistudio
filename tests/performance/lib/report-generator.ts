/**
 * Report Generator for Performance Testing
 *
 * Generates human-readable and machine-readable reports from aggregated metrics.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AggregatedMetrics } from './metrics-collector';
import type { PerformanceTargets } from '../config';

export interface ReportOptions {
  /** Test name */
  testName: string;
  /** Test description */
  description?: string;
  /** Performance targets for comparison */
  targets?: PerformanceTargets;
  /** Output directory */
  outputDir?: string;
  /** Environment tested */
  environment?: string;
  /** Model configuration */
  modelConfig?: {
    modelId: string;
    provider: string;
  };
}

export class ReportGenerator {
  /**
   * Generate a markdown report from aggregated metrics
   */
  static generateMarkdown(
    metrics: AggregatedMetrics,
    options: ReportOptions
  ): string {
    const { testName, description, targets, environment, modelConfig } = options;
    const timestamp = new Date().toISOString();

    let report = `# Performance Test Report: ${testName}\n\n`;
    report += `**Generated:** ${timestamp}\n\n`;

    if (description) {
      report += `${description}\n\n`;
    }

    if (environment) {
      report += `**Environment:** ${environment}\n\n`;
    }

    if (modelConfig) {
      report += `**Model:** ${modelConfig.provider}/${modelConfig.modelId}\n\n`;
    }

    // Summary section
    report += `## Summary\n\n`;
    report += `| Metric | Value |\n`;
    report += `|--------|-------|\n`;
    report += `| Total Requests | ${metrics.totalRequests} |\n`;
    report += `| Successful | ${metrics.successfulRequests} |\n`;
    report += `| Failed | ${metrics.failedRequests} |\n`;
    report += `| Error Rate | ${metrics.errorRate.toFixed(2)}% |\n`;
    report += `| Connection Drops | ${metrics.connectionDrops} |\n`;
    report += `| Test Duration | ${(metrics.duration.totalMs / 1000).toFixed(2)}s |\n\n`;

    // Time-to-First-Token section
    report += `## Time-to-First-Token (TTFT)\n\n`;
    report += `| Metric | Value (ms) | Target | Status |\n`;
    report += `|--------|------------|--------|--------|\n`;
    report += `| Mean | ${metrics.ttft.mean.toFixed(2)} | - | - |\n`;
    report += `| Median (p50) | ${metrics.ttft.median.toFixed(2)} | - | - |\n`;
    report += `| p95 | ${metrics.ttft.p95.toFixed(2)} | ${targets?.ttftP95 || '-'} | ${
      targets ? this.getStatus(metrics.ttft.p95, targets.ttftP95, true) : '-'
    } |\n`;
    report += `| p99 | ${metrics.ttft.p99.toFixed(2)} | ${targets?.ttftP99 || '-'} | ${
      targets ? this.getStatus(metrics.ttft.p99, targets.ttftP99, true) : '-'
    } |\n`;
    report += `| Min | ${metrics.ttft.min.toFixed(2)} | - | - |\n`;
    report += `| Max | ${metrics.ttft.max.toFixed(2)} | - | - |\n\n`;

    // Response Time section
    report += `## Total Response Time\n\n`;
    report += `| Metric | Value (ms) |\n`;
    report += `|--------|------------|\n`;
    report += `| Mean | ${metrics.responseTime.mean.toFixed(2)} |\n`;
    report += `| Median | ${metrics.responseTime.median.toFixed(2)} |\n`;
    report += `| p95 | ${metrics.responseTime.p95.toFixed(2)} |\n`;
    report += `| p99 | ${metrics.responseTime.p99.toFixed(2)} |\n`;
    report += `| Min | ${metrics.responseTime.min.toFixed(2)} |\n`;
    report += `| Max | ${metrics.responseTime.max.toFixed(2)} |\n\n`;

    // Throughput section
    report += `## Throughput (Tokens/Second)\n\n`;
    report += `| Metric | Value |\n`;
    report += `|--------|-------|\n`;
    report += `| Mean | ${metrics.throughput.mean.toFixed(2)} |\n`;
    report += `| Median | ${metrics.throughput.median.toFixed(2)} |\n`;
    report += `| Min | ${metrics.throughput.min.toFixed(2)} |\n`;
    report += `| Max | ${metrics.throughput.max.toFixed(2)} |\n\n`;

    // Token statistics
    report += `## Token Statistics\n\n`;
    report += `| Metric | Value |\n`;
    report += `|--------|-------|\n`;
    report += `| Total Tokens | ${metrics.tokens.total} |\n`;
    report += `| Mean Tokens/Request | ${metrics.tokens.mean.toFixed(2)} |\n`;
    report += `| Min Tokens | ${metrics.tokens.min} |\n`;
    report += `| Max Tokens | ${metrics.tokens.max} |\n\n`;

    // Memory usage
    report += `## Memory Usage\n\n`;
    report += `| Metric | Value (MB) |\n`;
    report += `|--------|------------|\n`;
    report += `| Start Mean | ${(metrics.memory.startMean / 1024 / 1024).toFixed(2)} |\n`;
    report += `| End Mean | ${(metrics.memory.endMean / 1024 / 1024).toFixed(2)} |\n`;
    report += `| Growth | ${(metrics.memory.growth / 1024 / 1024).toFixed(2)} |\n\n`;

    // Pass/Fail summary if targets provided
    if (targets) {
      report += `## Target Validation\n\n`;
      report += `| Target | Expected | Actual | Status |\n`;
      report += `|--------|----------|--------|--------|\n`;
      report += `| TTFT p95 | <${targets.ttftP95}ms | ${metrics.ttft.p95.toFixed(2)}ms | ${
        this.getStatus(metrics.ttft.p95, targets.ttftP95, true)
      } |\n`;
      report += `| Error Rate | <${targets.maxErrorRate}% | ${metrics.errorRate.toFixed(2)}% | ${
        this.getStatus(metrics.errorRate, targets.maxErrorRate, true)
      } |\n`;

      const overallPass =
        metrics.ttft.p95 <= targets.ttftP95 &&
        metrics.errorRate <= targets.maxErrorRate;

      report += `\n**Overall Result:** ${overallPass ? '✅ PASS' : '❌ FAIL'}\n\n`;
    }

    return report;
  }

  /**
   * Get status indicator (pass/fail)
   */
  private static getStatus(
    actual: number,
    target: number,
    lowerIsBetter: boolean
  ): string {
    const passed = lowerIsBetter ? actual <= target : actual >= target;
    return passed ? '✅ PASS' : '❌ FAIL';
  }

  /**
   * Save report to file
   */
  static saveReport(
    content: string,
    filename: string,
    outputDir: string = join(process.cwd(), 'tests/performance/reports')
  ): string {
    const filepath = join(outputDir, filename);
    writeFileSync(filepath, content, 'utf-8');
    return filepath;
  }

  /**
   * Generate and save all report formats
   */
  static generateAll(
    metrics: AggregatedMetrics,
    options: ReportOptions
  ): {
    markdown: string;
    json: string;
    csv: string;
  } {
    const timestamp = new Date().toISOString().replace(/[.:]/g, '-');
    const baseName = `${options.testName}_${timestamp}`;

    // Generate markdown report
    const markdownContent = this.generateMarkdown(metrics, options);
    const markdownPath = this.saveReport(
      markdownContent,
      `${baseName}.md`,
      options.outputDir
    );

    // Generate JSON report
    const jsonContent = JSON.stringify(metrics, null, 2);
    const jsonPath = this.saveReport(
      jsonContent,
      `${baseName}.json`,
      options.outputDir
    );

    // Generate CSV report (individual requests)
    const csvHeaders = [
      'requestId',
      'success',
      'timeToFirstToken',
      'totalResponseTime',
      'tokenCount',
      'tokensPerSecond',
      'connectionDropped',
      'error',
    ].join(',');

    const csvRows = metrics.requests.map(r =>
      [
        r.requestId,
        r.success,
        r.timeToFirstToken,
        r.totalResponseTime,
        r.tokenCount,
        r.tokensPerSecond.toFixed(2),
        r.connectionDropped,
        r.error ? `"${r.error.replace(/"/g, '""')}"` : '',
      ].join(',')
    );

    const csvContent = [csvHeaders, ...csvRows].join('\n');
    const csvPath = this.saveReport(
      csvContent,
      `${baseName}.csv`,
      options.outputDir
    );

    return {
      markdown: markdownPath,
      json: jsonPath,
      csv: csvPath,
    };
  }
}
