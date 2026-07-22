export interface ScheduledMaintenanceTask {
  name: string;
  run: () => Promise<void>;
}

/**
 * Run every independent recovery stage even when an earlier provider is down.
 * The aggregate error still fails the EventBridge invocation so AWS retries it,
 * while unrelated queues and durable outboxes continue making progress.
 */
export async function runScheduledMaintenance(
  tasks: ScheduledMaintenanceTask[],
  onError: (taskName: string, error: unknown) => void
): Promise<void> {
  const failures: Error[] = [];
  for (const task of tasks) {
    try {
      await task.run();
    } catch (error) {
      onError(task.name, error);
      const detail = error instanceof Error ? error.message : String(error);
      failures.push(new Error(`${task.name}: ${detail}`, { cause: error }));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} unified-content maintenance stage(s) failed`
    );
  }
}
