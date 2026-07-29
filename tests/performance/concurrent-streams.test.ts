/**
 * Concurrent Streaming Tests
 *
 * Tests the system's ability to handle 100+ concurrent streaming sessions
 * with acceptable error rates and performance as per issue #311.
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
  TEST_CONFIG,
} from './config';
import { getAuthToken } from './lib/auth-helper';

// Extended timeout for concurrent tests
jest.setTimeout(15 * 60 * 1000); // 15 minutes

let authToken: string | undefined;
let baseUrl: string;

function defineConcurrentStreamingPerformanceSuite1Part1() {



  beforeAll(async () => {
    const env = getTestEnvironment();
    baseUrl = env.baseUrl;
    authToken = await getAuthToken();

    console.log(`Running concurrent streaming tests against: ${baseUrl}`);
  });

  }

function defineConcurrentStreamingPerformanceSuite1Part2() {test('100 concurrent streams with acceptable error rate (<0.5%)', async () => {
    const collector = new MetricsCollector();
    const targets = getPerformanceTargets();
    const concurrentCount = TEST_CONFIG.concurrent.streamCount;
    const model = TEST_MODELS.find(m => m.modelId === 'gpt-4o-mini') || TEST_MODELS[0];

    console.log(`\nStarting ${concurrentCount} concurrent streaming sessions...`);
    console.log(`Model: ${model.provider}/${model.modelId}`);

    // Create array of stream clients
    const streamPromises: Array<Promise<void>> = [];

    const startTime = Date.now();

    for (let i = 0; i < concurrentCount; i++) {
      // Vary the prompts to simulate real usage
      const prompts = [TEST_PROMPTS.short, TEST_PROMPTS.medium];
      const prompt = prompts[i % prompts.length];

      const streamPromise = (async (index: number) => {
        const client = new StreamClient({
          url: `${baseUrl}/api/nexus/chat`,
          body: {
            messages: [
              {
                role: 'user',
                content: prompt,
                id: `concurrent-msg-${index}`,
              },
            ],
            modelId: model.modelId,
            provider: model.provider,
            conversationId: null,
          },
          authToken,
          timeout: 120000, // 2 minutes per request
          verbose: false,
        });

        try {
          const metrics = await client.execute();
          collector.add(metrics);

          // Log progress every 10 requests launched (avoid race condition with collector.count)
          if ((index + 1) % 10 === 0) {
            console.log(`  Progress: ${index + 1}/${concurrentCount} requests launched`);
          }
        } catch (error) {
          console.error(`  Stream ${index} failed:`, error);
          // Add failed metric
          collector.add({
            requestId: `concurrent-${index}`,
            timeToFirstToken: -1,
            totalResponseTime: Date.now() - startTime,
            tokenCount: 0,
            tokensPerSecond: 0,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            connectionDropped: true,
          });
        }
      })(i);

      streamPromises.push(streamPromise);
    }

    // Wait for all streams to complete
    console.log(`\nWaiting for all ${concurrentCount} streams to complete...`);
    await Promise.all(streamPromises);

    const aggregated = collector.getAggregated();
    const totalTime = Date.now() - startTime;

    // Generate report
    const reportPaths = ReportGenerator.generateAll(aggregated, {
      testName: 'concurrent-streams-100',
      description: `${concurrentCount} concurrent streaming sessions`,
      targets,
      environment: process.env.TEST_ENV || 'local',
      modelConfig: {
        modelId: model.modelId,
        provider: model.provider,
      },
    });

    console.log(`\n✅ Concurrent streaming test completed in ${(totalTime / 1000).toFixed(2)}s`);
    console.log(`   Reports generated:`);
    console.log(`   Markdown: ${reportPaths.markdown}`);

    // Display results
    console.log(`\n📊 Concurrent Streaming Results:`);
    console.log(`   Total Streams: ${aggregated.totalRequests}`);
    console.log(`   Successful: ${aggregated.successfulRequests}`);
    console.log(`   Failed: ${aggregated.failedRequests}`);
    console.log(`   Error Rate: ${aggregated.errorRate.toFixed(2)}% (target: <${targets.maxErrorRate}%)`);
    console.log(`   Connection Drops: ${aggregated.connectionDrops}`);
    console.log(`   TTFT p95: ${aggregated.ttft.p95.toFixed(2)}ms`);
    console.log(`   TTFT p99: ${aggregated.ttft.p99.toFixed(2)}ms`);
    console.log(`   Throughput Mean: ${aggregated.throughput.mean.toFixed(2)} tokens/sec`);
    console.log(`   Total Test Duration: ${(totalTime / 1000).toFixed(2)}s`);

    // Assertions
    expect(aggregated.totalRequests).toBe(concurrentCount);
    expect(aggregated.errorRate).toBeLessThanOrEqual(targets.maxErrorRate);
    expect(aggregated.successfulRequests).toBeGreaterThanOrEqual(
      Math.floor(concurrentCount * (1 - targets.maxErrorRate / 100))
    );
  });

  }

function defineConcurrentStreamingPerformanceSuite1Part3() {test('200 concurrent streams stress test', async () => {
    const collector = new MetricsCollector();
    const concurrentCount = 200;
    const model = TEST_MODELS[0];

    console.log(`\n🔥 Stress test: ${concurrentCount} concurrent streams...`);

    const streamPromises: Array<Promise<void>> = [];
    const startTime = Date.now();

    for (let i = 0; i < concurrentCount; i++) {
      const streamPromise = (async (index: number) => {
        const client = new StreamClient({
          url: `${baseUrl}/api/nexus/chat`,
          body: {
            messages: [
              {
                role: 'user',
                content: TEST_PROMPTS.short,
                id: `stress-msg-${index}`,
              },
            ],
            modelId: model.modelId,
            provider: model.provider,
            conversationId: null,
          },
          authToken,
          timeout: 180000, // 3 minutes
          verbose: false,
        });

        try {
          const metrics = await client.execute();
          collector.add(metrics);

          if ((index + 1) % 20 === 0) {
            console.log(`  Progress: ${collector.count}/${concurrentCount} streams completed`);
          }
        } catch (error) {
          collector.add({
            requestId: `stress-${index}`,
            timeToFirstToken: -1,
            totalResponseTime: Date.now() - startTime,
            tokenCount: 0,
            tokensPerSecond: 0,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            connectionDropped: true,
          });
        }
      })(i);

      streamPromises.push(streamPromise);
    }

    await Promise.all(streamPromises);

    const aggregated = collector.getAggregated();
    const totalTime = Date.now() - startTime;

    ReportGenerator.generateAll(aggregated, {
      testName: 'concurrent-streams-200-stress',
      description: `Stress test with ${concurrentCount} concurrent streams`,
      environment: process.env.TEST_ENV || 'local',
      modelConfig: {
        modelId: model.modelId,
        provider: model.provider,
      },
    });

    console.log(`\n📊 Stress Test Results (${concurrentCount} streams):`);
    console.log(`   Successful: ${aggregated.successfulRequests}/${aggregated.totalRequests}`);
    console.log(`   Error Rate: ${aggregated.errorRate.toFixed(2)}%`);
    console.log(`   Connection Drops: ${aggregated.connectionDrops}`);
    console.log(`   Test Duration: ${(totalTime / 1000).toFixed(2)}s`);

    // For stress test, we expect some degradation but should still handle gracefully
    // Error rate may be higher but system shouldn't crash
    expect(aggregated.totalRequests).toBe(concurrentCount);
    // System should handle at least 80% successfully even under extreme load
    expect(aggregated.successfulRequests).toBeGreaterThanOrEqual(Math.floor(concurrentCount * 0.8));
  });

  }

function defineConcurrentStreamingPerformanceSuite1Part4() {test('Sustained concurrent load for 1 minute', async () => {
    const collector = new MetricsCollector();
    const duration = 60000; // 1 minute
    const concurrentStreams = 50;
    const model = TEST_MODELS[0];

    console.log(`\nSustained load test: ${concurrentStreams} concurrent streams for 60 seconds...`);

    const startTime = Date.now();
    let requestCounter = 0;

    // Keep launching new requests as old ones complete
    const activeRequests = new Set<Promise<void>>();

    const launchRequest = async (index: number): Promise<void> => {
      const client = new StreamClient({
        url: `${baseUrl}/api/nexus/chat`,
        body: {
          messages: [
            {
              role: 'user',
              content: TEST_PROMPTS.short,
              id: `sustained-msg-${index}`,
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
        collector.add(metrics);
      } catch (error) {
        collector.add({
          requestId: `sustained-${index}`,
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
    for (let i = 0; i < concurrentStreams; i++) {
      const promise = launchRequest(requestCounter++);
      activeRequests.add(promise);
      promise.finally(() => activeRequests.delete(promise));
    }

    // Keep launching requests to maintain concurrency level
    while (Date.now() - startTime < duration) {
      // If we're below the concurrency target, launch more
      while (activeRequests.size < concurrentStreams && Date.now() - startTime < duration) {
        const promise = launchRequest(requestCounter++);
        activeRequests.add(promise);
        promise.finally(() => activeRequests.delete(promise));
      }

      // Brief pause to avoid tight loop
      await new Promise(resolve => setTimeout(resolve, 100));

      // Log progress
      if (requestCounter % 20 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`  Time: ${elapsed}s | Completed: ${collector.count} | Active: ${activeRequests.size}`);
      }
    }

    // Wait for remaining requests to complete
    console.log(`\nWaiting for remaining ${activeRequests.size} requests to complete...`);
    await Promise.all(Array.from(activeRequests));

    const aggregated = collector.getAggregated();
    const totalTime = Date.now() - startTime;

    ReportGenerator.generateAll(aggregated, {
      testName: 'sustained-concurrent-load',
      description: `Sustained concurrent load (${concurrentStreams} streams, ${duration / 1000}s duration)`,
      environment: process.env.TEST_ENV || 'local',
      modelConfig: {
        modelId: model.modelId,
        provider: model.provider,
      },
    });

    console.log(`\n📊 Sustained Load Results:`);
    console.log(`   Total Requests: ${aggregated.totalRequests}`);
    console.log(`   Successful: ${aggregated.successfulRequests}`);
    console.log(`   Error Rate: ${aggregated.errorRate.toFixed(2)}%`);
    console.log(`   Requests/Second: ${(aggregated.totalRequests / (totalTime / 1000)).toFixed(2)}`);
    console.log(`   TTFT p95: ${aggregated.ttft.p95.toFixed(2)}ms`);

    const targets = getPerformanceTargets();
    expect(aggregated.errorRate).toBeLessThanOrEqual(targets.maxErrorRate);
  });
}

const defineConcurrentStreamingPerformanceSuite1 = () => {
  defineConcurrentStreamingPerformanceSuite1Part1()
  defineConcurrentStreamingPerformanceSuite1Part2()
  defineConcurrentStreamingPerformanceSuite1Part3()
  defineConcurrentStreamingPerformanceSuite1Part4()
};

describe('Concurrent Streaming Performance', defineConcurrentStreamingPerformanceSuite1);
