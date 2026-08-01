const REPOSITORY_PUBLICATION_CONTENTION_MESSAGE =
  /lock timeout|could not obtain lock|deadlock detected/i;

interface ErrorLike {
  cause?: unknown;
  code?: unknown;
  message?: unknown;
}

function isErrorLike(error: unknown): error is ErrorLike {
  return typeof error === "object" && error !== null;
}

/** A bounded repository publication lock wait expired and may be retried. */
export class RepositoryPublicationContentionError extends Error {
  readonly name = "RepositoryPublicationContentionError";

  constructor(cause: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : "Repository publication lock contention",
      { cause }
    );
  }
}

/**
 * Identify only PostgreSQL lock acquisition failures, including errors wrapped
 * by Drizzle. Pool-capacity deadlines deliberately do not match this policy.
 */
export function isRepositoryPublicationContention(error: unknown): boolean {
  const visited = new Set<unknown>();
  let candidate: unknown = error;

  while (isErrorLike(candidate) && !visited.has(candidate)) {
    if (candidate instanceof RepositoryPublicationContentionError) return true;
    if (candidate.code === "55P03") return true;
    if (
      typeof candidate.message === "string" &&
      REPOSITORY_PUBLICATION_CONTENTION_MESSAGE.test(candidate.message)
    ) {
      return true;
    }
    visited.add(candidate);
    candidate = candidate.cause;
  }

  return false;
}
