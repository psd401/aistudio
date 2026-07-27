/**
 * Long-Running Streams Tests
 *
 * Tests that very long streaming responses (15-30+ minutes) complete successfully
 * without timeouts or disconnections as per issue #311 acceptance criteria.
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

// Very extended timeout for long-running tests
jest.setTimeout(45 * 60 * 1000); // 45 minutes

let authToken: string | undefined;
let baseUrl: string;

function defineLongRunningStreamsSuite1Part1() {



  beforeAll(async () => {
    const env = getTestEnvironment();
    baseUrl = env.baseUrl;
    authToken = await getAuthToken();

    console.log(`Running long-running stream tests against: ${baseUrl}`);
    console.log(`⚠️  These tests may take 15-30 minutes each`);
  });

  test('15-minute streaming session completes successfully', async () => {
    const collector = new MetricsCollector();
    const model = TEST_MODELS.find(m => m.modelId === 'gpt-4o') || TEST_MODELS[0];
    const minDuration = TEST_CONFIG.longRunning.minDurationMs;

    console.log(`\nStarting 15-minute streaming test with ${model.provider}/${model.modelId}...`);

    // Use a very long prompt that will generate extensive response
    const longPrompt = `${TEST_PROMPTS.veryLong}\n\nAfter completing the above, please provide 20 additional detailed examples of transformer applications across different domains including computer vision, audio processing, robotics, and more. For each example, explain the architecture, training approach, and key innovations.`;

    const client = new StreamClient({
      url: `${baseUrl}/api/nexus/chat`,
      body: {
        messages: [
          {
            role: 'user',
            content: longPrompt,
            id: 'long-running-msg',
          },
        ],
        modelId: model.modelId,
        provider: model.provider,
        conversationId: null,
      },
      authToken,
      timeout: 30 * 60 * 1000, // 30 minute timeout
      verbose: true,
    });

    const startTime = Date.now();

    // Monitor progress during streaming
    const monitorInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const minutes = Math.floor(elapsed / 60000);
      const seconds = Math.floor((elapsed % 60000) / 1000);
      console.log(`  ⏱️  Streaming progress: ${minutes}m ${seconds}s`);
    }, 30000); // Log every 30 seconds

    try {
      const metrics = await client.execute();
      clearInterval(monitorInterval);

      collector.add(metrics);

      const duration = metrics.totalResponseTime;
      const durationMinutes = duration / 60000;

      console.log(`\n✅ Long-running stream completed!`);
      console.log(`   Duration: ${durationMinutes.toFixed(2)} minutes`);
      console.log(`   TTFT: ${metrics.timeToFirstToken}ms`);
      console.log(`   Tokens: ${metrics.tokenCount}`);
      console.log(`   Throughput: ${metrics.tokensPerSecond.toFixed(2)} tokens/sec`);
      console.log(`   Success: ${metrics.success}`);
      console.log(`   Connection Dropped: ${metrics.connectionDropped}`);

      // Generate report
      const aggregated = collector.getAggregated();
      ReportGenerator.generateAll(aggregated, {
        testName: 'long-running-stream-15min',
        description: `Long-running stream test (target: 15+ minutes)`,
        environment: process.env.TEST_ENV || 'local',
        modelConfig: {
          modelId: model.modelId,
          provider: model.provider,
        },
      });

      // Assertions
      expect(metrics.success).toBe(true);
      expect(metrics.connectionDropped).toBe(false);
      expect(metrics.totalResponseTime).toBeGreaterThanOrEqual(minDuration);
      expect(metrics.tokenCount).toBeGreaterThan(0);
    } finally {
      clearInterval(monitorInterval);
    }
  });

  }

function defineLongRunningStreamsSuite1Part2() {test('Multiple long streams handle correctly with memory monitoring', async () => {
    const collector = new MetricsCollector();
    const model = TEST_MODELS[0];
    const iterations = 3; // Run 3 long streams sequentially
    const memorySnapshots: Array<{
      iteration: number;
      before: NodeJS.MemoryUsage;
      after: NodeJS.MemoryUsage;
    }> = [];

    console.log(`\nRunning ${iterations} sequential long-running streams with memory monitoring...`);

    for (let i = 0; i < iterations; i++) {
      console.log(`\n🔄 Starting iteration ${i + 1}/${iterations}...`);

      // Force garbage collection if available (requires --expose-gc flag)
      if (global.gc) {
        global.gc();
      }

      const memoryBefore = process.memoryUsage();

      const client = new StreamClient({
        url: `${baseUrl}/api/nexus/chat`,
        body: {
          messages: [
            {
              role: 'user',
              content: TEST_PROMPTS.long,
              id: `long-stream-${i}`,
            },
          ],
          modelId: model.modelId,
          provider: model.provider,
          conversationId: null,
        },
        authToken,
        timeout: 20 * 60 * 1000, // 20 minutes
        verbose: false,
      });

      const metrics = await client.execute();
      collector.add(metrics);

      const memoryAfter = process.memoryUsage();
      memorySnapshots.push({
        iteration: i + 1,
        before: memoryBefore,
        after: memoryAfter,
      });

      console.log(`   ✅ Iteration ${i + 1} completed`);
      console.log(`      Duration: ${(metrics.totalResponseTime / 1000).toFixed(2)}s`);
      console.log(`      Tokens: ${metrics.tokenCount}`);
      console.log(`      Memory before: ${(memoryBefore.heapUsed / 1024 / 1024).toFixed(2)}MB`);
      console.log(`      Memory after: ${(memoryAfter.heapUsed / 1024 / 1024).toFixed(2)}MB`);
      console.log(`      Memory delta: ${((memoryAfter.heapUsed - memoryBefore.heapUsed) / 1024 / 1024).toFixed(2)}MB`);
    }

    const aggregated = collector.getAggregated();

    // Analyze memory growth
    console.log(`\n📊 Memory Growth Analysis:`);
    console.log(`\n| Iteration | Before (MB) | After (MB) | Delta (MB) |`);
    console.log(`|-----------|-------------|------------|------------|`);
    for (const snapshot of memorySnapshots) {
      const before = snapshot.before.heapUsed / 1024 / 1024;
      const after = snapshot.after.heapUsed / 1024 / 1024;
      const delta = after - before;
      console.log(
        `| ${snapshot.iteration.toString().padStart(9)} | ${before.toFixed(2).padStart(11)} | ${after.toFixed(2).padStart(10)} | ${delta.toFixed(2).padStart(10)} |`
      );
    }

    // Calculate total memory growth
    const firstMemory = memorySnapshots[0].before.heapUsed;
    const lastMemory = memorySnapshots[memorySnapshots.length - 1].after.heapUsed;
    const totalGrowth = (lastMemory - firstMemory) / 1024 / 1024;

    console.log(`\nTotal memory growth: ${totalGrowth.toFixed(2)}MB`);

    // Generate report
    ReportGenerator.generateAll(aggregated, {
      testName: 'long-running-streams-sequential',
      description: `${iterations} sequential long-running streams with memory monitoring`,
      environment: process.env.TEST_ENV || 'local',
      modelConfig: {
        modelId: model.modelId,
        provider: model.provider,
      },
    });

    // All streams should complete successfully
    expect(aggregated.successfulRequests).toBe(iterations);
    expect(aggregated.connectionDrops).toBe(0);
    // Memory growth should be reasonable (< 500MB for 3 long streams)
    expect(totalGrowth).toBeLessThan(500);
  });

  }

function defineLongRunningStreamsSuite1Part3() {test.skip('30-minute extreme duration test', async () => {
    // This test is skipped by default due to its extreme duration
    // Run manually with: npm run test:perf -- --testNamePattern="30-minute"

    const model = TEST_MODELS[0];
    const targetDuration = 30 * 60 * 1000; // 30 minutes

    console.log(`\n⚠️  Starting 30-minute extreme duration test...`);
    console.log(`   This test will take at least 30 minutes to complete`);

    const client = new StreamClient({
      url: `${baseUrl}/api/nexus/chat`,
      body: {
        messages: [
          {
            role: 'user',
            content: `${TEST_PROMPTS.veryLong}\n\nContinue with 50 more detailed examples covering every major domain of AI application. For each, provide comprehensive technical details, code examples, and architectural diagrams described in text.`,
            id: 'extreme-duration-msg',
          },
        ],
        modelId: model.modelId,
        provider: model.provider,
        conversationId: null,
      },
      authToken,
      timeout: 45 * 60 * 1000, // 45 minute timeout
      verbose: true,
    });

    const monitorInterval = setInterval(() => {
      const memory = process.memoryUsage();
      console.log(`  📊 Memory: ${(memory.heapUsed / 1024 / 1024).toFixed(2)}MB`);
    }, 60000); // Log every minute

    try {
      const metrics = await client.execute();
      clearInterval(monitorInterval);

      console.log(`\n✅ 30-minute stream completed!`);
      console.log(`   Duration: ${(metrics.totalResponseTime / 60000).toFixed(2)} minutes`);
      console.log(`   Success: ${metrics.success}`);
      console.log(`   Tokens: ${metrics.tokenCount}`);

      expect(metrics.success).toBe(true);
      expect(metrics.totalResponseTime).toBeGreaterThanOrEqual(targetDuration);
    } finally {
      clearInterval(monitorInterval);
    }
  });
}

const defineLongRunningStreamsSuite1 = () => {
  defineLongRunningStreamsSuite1Part1()
  defineLongRunningStreamsSuite1Part2()
  defineLongRunningStreamsSuite1Part3()
};

describe('Long-Running Streams', defineLongRunningStreamsSuite1);
