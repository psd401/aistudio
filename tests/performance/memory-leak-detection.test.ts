/**
 * Memory Leak Detection Tests
 *
 * Tests for memory leaks during extended streaming operations
 * by monitoring heap usage over sustained load periods.
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

// Extended timeout for memory tests
jest.setTimeout(90 * 60 * 1000); // 90 minutes

interface MemorySnapshot {
  timestamp: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  rss: number;
  requestsCompleted: number;
}

describe('Memory Leak Detection', () => {
  let authToken: string | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    const env = getTestEnvironment();
    baseUrl = env.baseUrl;
    authToken = await getAuthToken();

    console.log(`Running memory leak detection tests against: ${baseUrl}`);
    console.log(`⚠️  This test suite may take over 1 hour to complete`);
  });

  test('1-hour sustained load with heap monitoring', async () => {
    const collector = new MetricsCollector();
    const model = TEST_MODELS[0];
    const testDuration = TEST_CONFIG.memoryLeak.durationMs;
    const snapshotInterval = TEST_CONFIG.memoryLeak.snapshotIntervalMs;
    const concurrentStreams = TEST_CONFIG.memoryLeak.concurrentStreams;

    const memorySnapshots: MemorySnapshot[] = [];

    console.log(`\nStarting 1-hour memory leak detection test...`);
    console.log(`   Concurrent streams: ${concurrentStreams}`);
    console.log(`   Snapshot interval: ${snapshotInterval / 1000}s`);
    console.log(`   Test duration: ${testDuration / 60000} minutes`);

    const startTime = Date.now();
    let requestCounter = 0;

    // Initial memory snapshot
    if (global.gc) {
      global.gc();
    }
    memorySnapshots.push({
      timestamp: 0,
      ...process.memoryUsage(),
      requestsCompleted: 0,
    });

    // Snapshot monitoring
    const snapshotTimer = setInterval(() => {
      if (global.gc) {
        global.gc();
      }

      const elapsed = Date.now() - startTime;
      const memory = process.memoryUsage();
      memorySnapshots.push({
        timestamp: elapsed,
        ...memory,
        requestsCompleted: collector.count,
      });

      const minutes = Math.floor(elapsed / 60000);
      const seconds = Math.floor((elapsed % 60000) / 1000);
      console.log(
        `  [${minutes}m ${seconds}s] Heap: ${(memory.heapUsed / 1024 / 1024).toFixed(2)}MB | Requests: ${collector.count}`
      );
    }, snapshotInterval);

    // Maintain concurrent load
    const activeRequests = new Set<Promise<void>>();

    const launchRequest = async (index: number): Promise<void> => {
      const client = new StreamClient({
        url: `${baseUrl}/api/nexus/chat`,
        body: {
          messages: [
            {
              role: 'user',
              content: index % 2 === 0 ? TEST_PROMPTS.short : TEST_PROMPTS.medium,
              id: `memory-test-${index}`,
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
          requestId: `memory-test-${index}`,
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

    // Maintain load
    while (Date.now() - startTime < testDuration) {
      while (activeRequests.size < concurrentStreams && Date.now() - startTime < testDuration) {
        const promise = launchRequest(requestCounter++);
        activeRequests.add(promise);
        promise.finally(() => activeRequests.delete(promise));
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Cleanup
    clearInterval(snapshotTimer);
    await Promise.all(Array.from(activeRequests));

    // Final snapshot
    if (global.gc) {
      global.gc();
    }
    memorySnapshots.push({
      timestamp: Date.now() - startTime,
      ...process.memoryUsage(),
      requestsCompleted: collector.count,
    });

    // Analyze memory growth
    const firstSnapshot = memorySnapshots[0];
    const lastSnapshot = memorySnapshots[memorySnapshots.length - 1];
    const heapGrowth = (lastSnapshot.heapUsed - firstSnapshot.heapUsed) / 1024 / 1024;
    const rssGrowth = (lastSnapshot.rss - firstSnapshot.rss) / 1024 / 1024;
    const durationHours = (lastSnapshot.timestamp - firstSnapshot.timestamp) / 3600000;

    console.log(`\n📊 Memory Leak Analysis:`);
    console.log(`   Test Duration: ${durationHours.toFixed(2)} hours`);
    console.log(`   Total Requests: ${collector.count}`);
    console.log(`   Heap Start: ${(firstSnapshot.heapUsed / 1024 / 1024).toFixed(2)}MB`);
    console.log(`   Heap End: ${(lastSnapshot.heapUsed / 1024 / 1024).toFixed(2)}MB`);
    console.log(`   Heap Growth: ${heapGrowth.toFixed(2)}MB`);
    console.log(`   RSS Growth: ${rssGrowth.toFixed(2)}MB`);
    console.log(`   Growth per Hour: ${(heapGrowth / durationHours).toFixed(2)}MB/hour`);

    // Generate memory usage chart (text-based)
    console.log(`\n📈 Heap Usage Over Time:`);
    for (const [index, snapshot] of memorySnapshots.entries()) {
      if (index % 2 === 0) {
        // Log every other snapshot to avoid clutter
        const minutes = Math.floor(snapshot.timestamp / 60000);
        const heapMB = (snapshot.heapUsed / 1024 / 1024).toFixed(2);
        const bar = '█'.repeat(Math.floor(snapshot.heapUsed / 1024 / 1024 / 10));
        console.log(`   ${minutes.toString().padStart(3)}m: ${heapMB.padStart(8)}MB ${bar}`);
      }
    }

    // Generate aggregated metrics report
    const aggregated = collector.getAggregated();
    ReportGenerator.generateAll(aggregated, {
      testName: 'memory-leak-detection-1hour',
      description: `1-hour sustained load test with memory monitoring (${concurrentStreams} concurrent streams)`,
      environment: process.env.TEST_ENV || 'local',
      modelConfig: {
        modelId: model.modelId,
        provider: model.provider,
      },
    });

    // Assertions
    const targets = getPerformanceTargets();
    const hourlyGrowth = heapGrowth / durationHours;

    expect(aggregated.errorRate).toBeLessThanOrEqual(targets.maxErrorRate);
    expect(hourlyGrowth).toBeLessThan(targets.maxMemoryGrowthMB);
    console.log(`\n✅ Memory leak test passed!`);
    console.log(`   Hourly growth: ${hourlyGrowth.toFixed(2)}MB/hour (target: <${targets.maxMemoryGrowthMB}MB/hour)`);
  });

  test('Burst load followed by idle period (memory cleanup validation)', async () => {
    const collector = new MetricsCollector();
    const model = TEST_MODELS[0];
    const burstCount = 50;

    console.log(`\nTesting memory cleanup after burst load...`);

    // Baseline memory
    if (global.gc) {
      global.gc();
    }
    const baselineMemory = process.memoryUsage().heapUsed;
    console.log(`   Baseline heap: ${(baselineMemory / 1024 / 1024).toFixed(2)}MB`);

    // Burst load
    console.log(`\n   Executing burst of ${burstCount} concurrent requests...`);
    const burstPromises: Array<Promise<void>> = [];

    for (let i = 0; i < burstCount; i++) {
      const promise = (async () => {
        const client = new StreamClient({
          url: `${baseUrl}/api/nexus/chat`,
          body: {
            messages: [
              {
                role: 'user',
                content: TEST_PROMPTS.medium,
                id: `burst-${i}`,
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

        const metrics = await client.execute();
        collector.add(metrics);
      })();

      burstPromises.push(promise);
    }

    await Promise.all(burstPromises);

    const peakMemory = process.memoryUsage().heapUsed;
    console.log(`   Peak heap after burst: ${(peakMemory / 1024 / 1024).toFixed(2)}MB`);

    // Wait and allow garbage collection
    console.log(`\n   Waiting 60 seconds for garbage collection...`);
    await new Promise(resolve => setTimeout(resolve, 60000));

    // Force GC if available
    if (global.gc) {
      global.gc();
      global.gc(); // Run twice for good measure
    }

    await new Promise(resolve => setTimeout(resolve, 5000));

    const cleanupMemory = process.memoryUsage().heapUsed;
    console.log(`   Heap after cleanup: ${(cleanupMemory / 1024 / 1024).toFixed(2)}MB`);

    const memoryReclaimed = (peakMemory - cleanupMemory) / 1024 / 1024;
    const memoryRetained = (cleanupMemory - baselineMemory) / 1024 / 1024;

    console.log(`\n📊 Memory Cleanup Analysis:`);
    console.log(`   Memory reclaimed: ${memoryReclaimed.toFixed(2)}MB`);
    console.log(`   Memory retained: ${memoryRetained.toFixed(2)}MB`);
    console.log(`   Cleanup efficiency: ${((memoryReclaimed / (peakMemory - baselineMemory)) * 100).toFixed(1)}%`);

    // Memory should be mostly reclaimed (at least 50% cleanup efficiency)
    const cleanupEfficiency = memoryReclaimed / (peakMemory - baselineMemory);
    expect(cleanupEfficiency).toBeGreaterThan(0.5);

    console.log(`\n✅ Memory cleanup validation passed!`);
  });
});
