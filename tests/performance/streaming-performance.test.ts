/**
 * Streaming Performance Tests - Time-to-First-Token (TTFT) Validation
 *
 * Tests TTFT performance across different models and providers to ensure
 * p95 latency is under 1 second as per issue #311 acceptance criteria.
 */

import { describe, test, expect, beforeAll } from '@jest/globals';
import { StreamClient } from './lib/stream-client';
import { MetricsCollector } from './lib/metrics-collector';
import { ReportGenerator } from './lib/report-generator';
import {
  getTestEnvironment,
  getPerformanceTargets,
  TEST_MODELS,
  TEST_PROMPTS,
} from './config';
import { getAuthToken } from './lib/auth-helper';
import { createSetupValidator, shouldSkipPerformanceTests } from './lib/test-setup-validator';

// Extended timeout for performance tests
jest.setTimeout(10 * 60 * 1000); // 10 minutes

// Skip performance tests in CI unless explicitly enabled
// This prevents CI from hanging on tests that need running server + auth
const describeOrSkip = shouldSkipPerformanceTests() ? describe.skip : describe;

let authToken: string | undefined;
let baseUrl: string;

function defineStreamingPerformanceTTFTValidationSuite1Part1() {



  // Validate test setup before running
  beforeAll(createSetupValidator());

  beforeAll(async () => {
    const env = getTestEnvironment();
    baseUrl = env.baseUrl;
    authToken = await getAuthToken();

    console.log(`Running TTFT tests against: ${baseUrl}`);
  });

  test('TTFT: Short prompts should respond quickly (p95 <1s)', async () => {
    const collector = new MetricsCollector();
    const targets = getPerformanceTargets();
    const iterations = 50; // Run 50 requests for statistical significance

    console.log(`\nRunning ${iterations} requests with short prompts...`);

    // Use GPT-4o-mini for fast, consistent responses
    const model = TEST_MODELS.find(m => m.modelId === 'gpt-4o-mini') || TEST_MODELS[0];

    for (let i = 0; i < iterations; i++) {
      const client = new StreamClient({
        url: `${baseUrl}/api/nexus/chat`,
        body: {
          messages: [
            {
              role: 'user',
              content: TEST_PROMPTS.short,
              id: `msg-${i}`,
            },
          ],
          modelId: model.modelId,
          provider: model.provider,
          conversationId: null,
        },
        authToken,
        timeout: 30000,
      });

      const metrics = await client.execute();
      collector.add(metrics);

      // Log progress every 10 requests
      if ((i + 1) % 10 === 0) {
        console.log(`  Progress: ${i + 1}/${iterations} requests completed`);
      }
    }

    const aggregated = collector.getAggregated();

    // Generate report
    const reportPaths = ReportGenerator.generateAll(aggregated, {
      testName: 'ttft-short-prompts',
      description: 'TTFT validation for short prompts (baseline performance)',
      targets,
      environment: process.env.TEST_ENV || 'local',
      modelConfig: {
        modelId: model.modelId,
        provider: model.provider,
      },
    });

    console.log(`\n✅ Test completed. Reports generated:`);
    console.log(`   Markdown: ${reportPaths.markdown}`);
    console.log(`   JSON: ${reportPaths.json}`);
    console.log(`   CSV: ${reportPaths.csv}`);

    // Display summary
    console.log(`\n📊 Results Summary:`);
    console.log(`   Total Requests: ${aggregated.totalRequests}`);
    console.log(`   Successful: ${aggregated.successfulRequests}`);
    console.log(`   Failed: ${aggregated.failedRequests}`);
    console.log(`   Error Rate: ${aggregated.errorRate.toFixed(2)}%`);
    console.log(`   TTFT p50: ${aggregated.ttft.median.toFixed(2)}ms`);
    console.log(`   TTFT p95: ${aggregated.ttft.p95.toFixed(2)}ms (target: <${targets.ttftP95}ms)`);
    console.log(`   TTFT p99: ${aggregated.ttft.p99.toFixed(2)}ms`);

    // Assertions
    expect(aggregated.errorRate).toBeLessThanOrEqual(targets.maxErrorRate);
    expect(aggregated.ttft.p95).toBeLessThanOrEqual(targets.ttftP95);
  });

  }

function defineStreamingPerformanceTTFTValidationSuite1Part2() {test('TTFT: Medium prompts performance validation', async () => {
    const collector = new MetricsCollector();
    const targets = getPerformanceTargets();
    const iterations = 30;

    console.log(`\nRunning ${iterations} requests with medium prompts...`);

    const model = TEST_MODELS.find(m => m.modelId === 'gpt-4o-mini') || TEST_MODELS[0];

    for (let i = 0; i < iterations; i++) {
      const client = new StreamClient({
        url: `${baseUrl}/api/nexus/chat`,
        body: {
          messages: [
            {
              role: 'user',
              content: TEST_PROMPTS.medium,
              id: `msg-${i}`,
            },
          ],
          modelId: model.modelId,
          provider: model.provider,
          conversationId: null,
        },
        authToken,
        timeout: 60000,
      });

      const metrics = await client.execute();
      collector.add(metrics);

      if ((i + 1) % 10 === 0) {
        console.log(`  Progress: ${i + 1}/${iterations} requests completed`);
      }
    }

    const aggregated = collector.getAggregated();

    // Generate report
    ReportGenerator.generateAll(aggregated, {
      testName: 'ttft-medium-prompts',
      description: 'TTFT validation for medium-length prompts',
      targets,
      environment: process.env.TEST_ENV || 'local',
      modelConfig: {
        modelId: model.modelId,
        provider: model.provider,
      },
    });

    console.log(`\n📊 Medium Prompt Results:`);
    console.log(`   TTFT p95: ${aggregated.ttft.p95.toFixed(2)}ms (target: <${targets.ttftP95}ms)`);
    console.log(`   Error Rate: ${aggregated.errorRate.toFixed(2)}%`);

    expect(aggregated.errorRate).toBeLessThanOrEqual(targets.maxErrorRate);
    expect(aggregated.ttft.p95).toBeLessThanOrEqual(targets.ttftP95);
  });

  test('TTFT: Cross-provider comparison', async () => {
    const results: Array<{
      provider: string;
      modelId: string;
      ttftP95: number;
      ttftMedian: number;
      errorRate: number;
    }> = [];

    console.log(`\nTesting TTFT across multiple providers...`);

    // Test a subset of models (limit to avoid long test times)
    const modelsToTest = TEST_MODELS.slice(0, 2); // Test first 2 models

    for (const model of modelsToTest) {
      console.log(`\n  Testing ${model.provider}/${model.modelId}...`);
      const collector = new MetricsCollector();
      const iterations = 20; // Fewer iterations per provider

      for (let i = 0; i < iterations; i++) {
        const client = new StreamClient({
          url: `${baseUrl}/api/nexus/chat`,
          body: {
            messages: [
              {
                role: 'user',
                content: TEST_PROMPTS.short,
                id: `msg-${i}`,
              },
            ],
            modelId: model.modelId,
            provider: model.provider,
            conversationId: null,
          },
          authToken,
          timeout: 30000,
        });

        const metrics = await client.execute();
        collector.add(metrics);
      }

      const aggregated = collector.getAggregated();
      results.push({
        provider: model.provider,
        modelId: model.modelId,
        ttftP95: aggregated.ttft.p95,
        ttftMedian: aggregated.ttft.median,
        errorRate: aggregated.errorRate,
      });

      console.log(`    TTFT p95: ${aggregated.ttft.p95.toFixed(2)}ms`);
      console.log(`    Error Rate: ${aggregated.errorRate.toFixed(2)}%`);
    }

    // Display comparison table
    console.log(`\n📊 Cross-Provider TTFT Comparison:`);
    console.log(`\n| Provider | Model | TTFT p95 (ms) | TTFT Median (ms) | Error Rate |`);
    console.log(`|----------|-------|---------------|------------------|------------|`);
    for (const r of results) {
      console.log(
        `| ${r.provider.padEnd(8)} | ${r.modelId.padEnd(30)} | ${r.ttftP95.toFixed(2).padStart(13)} | ${r.ttftMedian.toFixed(2).padStart(16)} | ${r.errorRate.toFixed(2)}% |`
      );
    }

    // All providers should meet the target
    const targets = getPerformanceTargets();
    for (const r of results) {
      expect(r.ttftP95).toBeLessThanOrEqual(targets.ttftP95);
    }
  });

  }

function defineStreamingPerformanceTTFTValidationSuite1Part3() {test('TTFT: Response time should be consistent across sequential requests', async () => {
    const collector = new MetricsCollector();
    const iterations = 30;

    console.log(`\nTesting TTFT consistency across ${iterations} sequential requests...`);

    const model = TEST_MODELS[0];

    for (let i = 0; i < iterations; i++) {
      const client = new StreamClient({
        url: `${baseUrl}/api/nexus/chat`,
        body: {
          messages: [
            {
              role: 'user',
              content: TEST_PROMPTS.short,
              id: `msg-${i}`,
            },
          ],
          modelId: model.modelId,
          provider: model.provider,
          conversationId: null,
        },
        authToken,
        timeout: 30000,
      });

      const metrics = await client.execute();
      collector.add(metrics);
    }

    const aggregated = collector.getAggregated();

    // Calculate coefficient of variation (standard deviation / mean)
    const ttftValues = aggregated.requests
      .filter(r => r.success && r.timeToFirstToken > 0)
      .map(r => r.timeToFirstToken);

    const mean = ttftValues.reduce((sum, v) => sum + v, 0) / ttftValues.length;
    const variance =
      ttftValues.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / ttftValues.length;
    const stdDev = Math.sqrt(variance);
    const coefficientOfVariation = (stdDev / mean) * 100;

    console.log(`\n📊 Consistency Metrics:`);
    console.log(`   Mean TTFT: ${mean.toFixed(2)}ms`);
    console.log(`   Std Dev: ${stdDev.toFixed(2)}ms`);
    console.log(`   Coefficient of Variation: ${coefficientOfVariation.toFixed(2)}%`);
    console.log(`   Min TTFT: ${aggregated.ttft.min.toFixed(2)}ms`);
    console.log(`   Max TTFT: ${aggregated.ttft.max.toFixed(2)}ms`);

    // TTFT should be reasonably consistent (CV < 50% indicates acceptable consistency)
    expect(coefficientOfVariation).toBeLessThan(50);
  });
}

const defineStreamingPerformanceTTFTValidationSuite1 = () => {
  defineStreamingPerformanceTTFTValidationSuite1Part1()
  defineStreamingPerformanceTTFTValidationSuite1Part2()
  defineStreamingPerformanceTTFTValidationSuite1Part3()
};

describeOrSkip('Streaming Performance - TTFT Validation', defineStreamingPerformanceTTFTValidationSuite1);
