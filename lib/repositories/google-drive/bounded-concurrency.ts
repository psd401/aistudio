/**
 * Preserve input order while bounding concurrent provider work.
 *
 * Google Drive selection verification may require a second lookup for a
 * shortcut target, so callers must keep this limit small even when the input
 * schema already caps the number of selections.
 */
export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new Error("Concurrency must be a positive safe integer");
  }
  if (values.length === 0) return [];

  const results = Array.from({ length: values.length }) as R[];
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index] as T, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () =>
      worker(),
    ),
  );
  return results;
}
