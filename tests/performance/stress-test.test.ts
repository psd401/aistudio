/**
 * Stress Testing - Gradual Load Increase
 *
 * Tests system behavior under gradually increasing load to find
 * breaking points and validate graceful degradation.
 */

import { describe, test, expect, beforeAll } from '@jest/globals';
import { StreamClient } from './lib/stream-client';
import { MetricsCollector } from './lib/metrics-collector';
import { ReportGenerator } from './lib/report-generator';
import {
  getTestEnvironment,
  TEST_MODELS,
  TEST_PROMPTS,
  TEST_CONFIG,
} from './config';
import { getAuthToken } from './lib/auth-helper';

// Extended timeout for stress tests
jest.setTimeout(60 * 60 * 1000); // 60 minutes

interface StressTestStep {
  userCount: number;
  successfulRequests: number;
  failedRequests: number;
  errorRate: number;
  avgTtft: number;
  avgResponseTime: number;
  throughput: number;
}

describe('Stress Testing', () => {
  let authToken: string | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    const env = getTestEnvironment();
    baseUrl = env.baseUrl;
    authToken = await getAuthToken();

    console.log(`Running stress tests against: ${baseUrl}`);
  });

  test('Gradual load increase from 1 to 200 users', async () => {
    const model = TEST_MODELS[0];
    const config = TEST_CONFIG.stress;
    const results: StressTestStep[] = [];

    console.log(`\n🔥 Starting stress test: ${config.startUsers} → ${config.maxUsers} users`);
    console.log(`   Increment: ${config.userIncrement} users per step`);
    console.log(`   Step duration: ${config.stepDurationMs / 1000}s`);

    for (
      let userCount = config.startUsers;
      userCount <= config.maxUsers;
      userCount += config.userIncrement
    ) {
      console.log(`\n📊 Testing with ${userCount} concurrent users...`);

      const stepCollector = new MetricsCollector();
      const stepDuration = config.stepDurationMs;
      const startTime = Date.now();
      let requestCounter = 0;

      const activeRequests = new Set<Promise<void>>();

      const launchRequest = async (index: number): Promise<void> => {
        const client = new StreamClient({
          url: `${baseUrl}/api/nexus/chat`,
          body: {
            messages: [
              {
                role: 'user',
                content: TEST_PROMPTS.short,
                id: `stress-${userCount}-${index}`,
              },
            ],
            modelId: model.modelId,
            provider: model.provider,
            conversationId: null,
          },
          authToken,
          timeout: 60000,
          verbose: false,
        });

        try {
          const metrics = await client.execute();
          stepCollector.add(metrics);
        } catch (error) {
          stepCollector.add({
            requestId: `stress-${userCount}-${index}`,
            timeToFirstToken: -1,
            totalResponseTime: Date.now() - startTime,
            tokenCount: 0,
            tokensPerSecond: 0,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            connectionDropped: true,
          });
        }
      };

      // Initial batch
      for (let i = 0; i < userCount; i++) {
        const promise = launchRequest(requestCounter++);
        activeRequests.add(promise);
        promise.finally(() => activeRequests.delete(promise));
      }

      // Maintain load for step duration
      while (Date.now() - startTime < stepDuration) {
        while (activeRequests.size < userCount && Date.now() - startTime < stepDuration) {
          const promise = launchRequest(requestCounter++);
          activeRequests.add(promise);
          promise.finally(() => activeRequests.delete(promise));
        }

        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Wait for remaining requests
      await Promise.all(Array.from(activeRequests));

      const aggregated = stepCollector.getAggregated();

      const stepResult: StressTestStep = {
        userCount,
        successfulRequests: aggregated.successfulRequests,
        failedRequests: aggregated.failedRequests,
        errorRate: aggregated.errorRate,
        avgTtft: aggregated.ttft.mean,
        avgResponseTime: aggregated.responseTime.mean,
        throughput: aggregated.throughput.mean,
      };

      results.push(stepResult);

      console.log(`   Completed: ${aggregated.totalRequests} requests`);
      console.log(`   Success: ${aggregated.successfulRequests} | Failed: ${aggregated.failedRequests}`);
      console.log(`   Error Rate: ${aggregated.errorRate.toFixed(2)}%`);
      console.log(`   Avg TTFT: ${aggregated.ttft.mean.toFixed(2)}ms`);

      // Stop if error rate exceeds 50% (system breaking point)
      if (aggregated.errorRate > 50) {
        console.log(`\n⚠️  Breaking point reached at ${userCount} users (error rate: ${aggregated.errorRate.toFixed(2)}%)`);
        break;
      }
    }

    // Generate summary report
    console.log(`\n📊 Stress Test Results Summary:\n`);
    console.log(`| Users | Requests | Success | Failed | Error Rate | Avg TTFT (ms) | Avg Response (ms) | Throughput (tok/s) |`);
    console.log(`|-------|----------|---------|--------|------------|---------------|-------------------|-------------------|`);

    for (const r of results) {
      const totalRequests = r.successfulRequests + r.failedRequests;
      console.log(
        `| ${r.userCount.toString().padStart(5)} | ${totalRequests.toString().padStart(8)} | ${r.successfulRequests.toString().padStart(7)} | ${r.failedRequests.toString().padStart(6)} | ${r.errorRate.toFixed(2).padStart(10)}% | ${r.avgTtft.toFixed(2).padStart(13)} | ${r.avgResponseTime.toFixed(2).padStart(17)} | ${r.throughput.toFixed(2).padStart(17)} |`
      );
    }

    // Find optimal capacity
    const acceptableResults = results.filter(r => r.errorRate <= 5); // <5% error rate
    const optimalCapacity = acceptableResults.length > 0
      ? acceptableResults[acceptableResults.length - 1].userCount
      : results[0].userCount;

    console.log(`\n✅ Stress test completed!`);
    console.log(`   Optimal capacity: ${optimalCapacity} concurrent users (with <5% error rate)`);
    console.log(`   Max tested: ${results[results.length - 1].userCount} users`);

    // System should handle at least 100 users gracefully
    expect(optimalCapacity).toBeGreaterThanOrEqual(100);
  });

  test('Rapid spike load test (0 to 100 users instantly)', async () => {
    const model = TEST_MODELS[0];
    const spikeUsers = 100;

    console.log(`\n⚡ Rapid spike test: 0 → ${spikeUsers} users instantly`);

    const collector = new MetricsCollector();
    const promises: Array<Promise<void>> = [];

    // Launch all requests simultaneously
    for (let i = 0; i < spikeUsers; i++) {
      const promise = (async () => {
        const client = new StreamClient({
          url: `${baseUrl}/api/nexus/chat`,
          body: {
            messages: [
              {
                role: 'user',
                content: TEST_PROMPTS.short,
                id: `spike-${i}`,
              },
            ],
            modelId: model.modelId,
            provider: model.provider,
            conversationId: null,
          },
          authToken,
          timeout: 120000,
          verbose: false,
        });

        try {
          const metrics = await client.execute();
          collector.add(metrics);
        } catch (error) {
          collector.add({
            requestId: `spike-${i}`,
            timeToFirstToken: -1,
            totalResponseTime: 0,
            tokenCount: 0,
            tokensPerSecond: 0,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            connectionDropped: true,
          });
        }
      })();

      promises.push(promise);
    }

    await Promise.all(promises);

    const aggregated = collector.getAggregated();

    // Generate report
    ReportGenerator.generateAll(aggregated, {
      testName: 'stress-rapid-spike',
      description: `Rapid spike load test: ${spikeUsers} concurrent users launched instantly`,
      environment: process.env.TEST_ENV || 'local',
      modelConfig: {
        modelId: model.modelId,
        provider: model.provider,
      },
    });

    console.log(`\n📊 Rapid Spike Results:`);
    console.log(`   Total: ${aggregated.totalRequests}`);
    console.log(`   Success: ${aggregated.successfulRequests}`);
    console.log(`   Failed: ${aggregated.failedRequests}`);
    console.log(`   Error Rate: ${aggregated.errorRate.toFixed(2)}%`);
    console.log(`   TTFT p95: ${aggregated.ttft.p95.toFixed(2)}ms`);
    console.log(`   TTFT p99: ${aggregated.ttft.p99.toFixed(2)}ms`);

    // System should handle spike gracefully (error rate < 10%)
    expect(aggregated.errorRate).toBeLessThan(10);
    expect(aggregated.successfulRequests).toBeGreaterThanOrEqual(90);

    console.log(`\n✅ Rapid spike test passed - system handled sudden load gracefully`);
  });
});
