/**
 * Execute a security control whose failure must block downstream processing.
 * The caller supplies sanitized telemetry so this helper remains logger-agnostic.
 */
export async function runRequiredSecurityScan<T>(
  scan: () => Promise<T>,
  onFailure: (error: unknown) => void,
  publicMessage: string,
): Promise<T> {
  try {
    return await scan()
  } catch (error) {
    onFailure(error)
    throw new Error(publicMessage, { cause: error })
  }
}
