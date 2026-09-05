import { describe, expect, it } from 'bun:test';
import {
  createRunTelemetry,
  settleCronFireFailure,
  type RunTelemetryConfig,
  type ScheduledRunRecord,
} from './run-telemetry';

const CONFIG: RunTelemetryConfig = {
  databaseResourceArn: 'arn:aws:rds:us-east-1:1:cluster:agent',
  databaseSecretArn: 'arn:aws:secretsmanager:us-east-1:1:secret:agent',
  databaseName: 'aistudio',
};

const FIRE_KEY = 'schedule-1#2026-09-05T05:45:00Z';

function recordingClient(failOn?: (sql: string) => boolean) {
  const statements: Array<{ sql: string; parameters: unknown }> = [];
  return {
    statements,
    async execute(input: { sql?: string; parameters?: unknown }) {
      const sql = String(input.sql ?? '');
      statements.push({ sql, parameters: input.parameters });
      if (failOn?.(sql)) throw new Error('rds unavailable');
      return {};
    },
  };
}

function logger() {
  const warnings: string[] = [];
  const errors: string[] = [];
  return {
    warnings,
    errors,
    warn: (message: string) => void warnings.push(message),
    error: (message: string) => void errors.push(message),
  };
}

function run(overrides: Partial<ScheduledRunRecord> = {}): ScheduledRunRecord {
  return {
    userEmail: 'owner@psd401.net',
    scheduleId: 'schedule-1',
    scheduleName: 'ParentSquare Daily Summary',
    sessionId: 'session-1',
    inputTokens: 10,
    outputTokens: 20,
    latencyMs: 100,
    status: 'success',
    fireKey: FIRE_KEY,
    ...overrides,
  };
}

function settleStatements(client: ReturnType<typeof recordingClient>) {
  return client.statements.filter((statement) =>
    statement.sql.includes("acknowledged_by = 'system:fire-succeeded'"),
  );
}

describe('settleCronFireFailure', () => {
  it('acknowledges only this fire, and only while it is unacknowledged', async () => {
    const client = recordingClient();

    await settleCronFireFailure(CONFIG, client, { fireKey: FIRE_KEY });

    expect(client.statements).toHaveLength(1);
    const [statement] = client.statements;
    expect(statement.sql).toContain("source = 'cron'");
    expect(statement.sql).toContain('fire_key = :fire_key');
    expect(statement.sql).toContain('acknowledged = FALSE');
    expect(statement.parameters).toEqual([
      { name: 'fire_key', value: { stringValue: FIRE_KEY } },
    ]);
  });

  it('refuses to run without a configured database', async () => {
    await expect(
      settleCronFireFailure(
        { ...CONFIG, databaseResourceArn: '' },
        recordingClient(),
        { fireKey: FIRE_KEY },
      ),
    ).rejects.toThrow('not configured');
  });
});

describe('recordRun contention settling', () => {
  it('settles the fire’s contention row once the fire succeeds', async () => {
    const client = recordingClient();
    const log = logger();

    await createRunTelemetry(CONFIG, client).recordRun(run(), log);

    expect(settleStatements(client)).toHaveLength(1);
    expect(log.warnings).toEqual([]);
  });

  it('leaves unresolved contention visible when the fire itself failed', async () => {
    const client = recordingClient();
    const log = logger();

    await createRunTelemetry(CONFIG, client).recordRun(
      run({
        status: 'error',
        errorMessage:
          'Owner workspace is active for another schedule; retrying this fire',
        failure: { severity: 'warn', context: { phase: 'schedule-fire' } },
      }),
      log,
    );

    expect(settleStatements(client)).toHaveLength(0);
  });

  it('does nothing for a fire with no Scheduler occurrence identity', async () => {
    const client = recordingClient();

    await createRunTelemetry(CONFIG, client).recordRun(
      run({ fireKey: undefined }),
      logger(),
    );

    expect(settleStatements(client)).toHaveLength(0);
  });

  it('never turns a settle failure into a failed run', async () => {
    const client = recordingClient((sql) =>
      sql.includes("acknowledged_by = 'system:fire-succeeded'"),
    );
    const log = logger();

    await createRunTelemetry(CONFIG, client).recordRun(run(), log);

    expect(log.warnings).toEqual([
      'Failed to settle the contention row for a succeeded fire',
    ]);
  });

  it('does not settle a skipped or promoted fire', async () => {
    // Neither status is proof this occurrence did the work: `skipped` is a
    // coalesced fire and `promoted` was handed to the job runner. Settling on
    // either would acknowledge a live contention row for a fire that never ran.
    for (const status of ['skipped', 'promoted'] as const) {
      const client = recordingClient();

      await createRunTelemetry(CONFIG, client).recordRun(
        run({ status }),
        logger(),
      );

      expect(settleStatements(client)).toHaveLength(0);
    }
  });

  it('re-opens a settled row when the same fire later fails for real', async () => {
    // One fire_key can be delivered twice: Scheduler retries while a slow
    // invocation still holds the owner workspace lock. The retry can succeed
    // and settle the row BEFORE the original invocation fails for real. If the
    // upsert then overwrote the row's error text without clearing the
    // acknowledgement, the new failure would be written into a row that stays
    // acknowledged = TRUE and never appears in an unacknowledged-failures view
    // again -- the exact burial the settle path exists to prevent.
    const client = recordingClient();
    const telemetry = createRunTelemetry(CONFIG, client);

    await telemetry.recordRun(run(), logger());
    expect(settleStatements(client)).toHaveLength(1);

    await telemetry.recordRun(
      run({
        status: 'error',
        errorMessage: 'workspace finalization failed',
        failure: { severity: 'error', context: { phase: 'scheduled-run' } },
      }),
      logger(),
    );

    const upserts = client.statements.filter((statement) =>
      statement.sql.includes('ON CONFLICT (source, fire_key)'),
    );
    expect(upserts).not.toHaveLength(0);
    const reopening = upserts.at(-1)!.sql;
    expect(reopening).toContain('acknowledged = FALSE');
    expect(reopening).toContain('acknowledged_by = NULL');
    expect(reopening).toContain('acknowledged_at = NULL');
  });

  it('settles from the strict recorder too', async () => {
    const client = recordingClient();

    await createRunTelemetry(CONFIG, client).recordRunStrict(run(), logger());

    expect(settleStatements(client)).toHaveLength(1);
  });
});
