export interface ArtifactDataE2EProbeContext {
  nodeEnv: string | undefined;
  probeFlag: string | undefined;
  hostname: string;
}

export interface ArtifactDataE2EActionProbeRequest
  extends ArtifactDataE2EProbeContext {
  method: string;
  pathname: string;
  hasNextActionHeader: boolean;
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

export function isArtifactDataE2EProbeEnabled(
  context: ArtifactDataE2EProbeContext,
): boolean {
  return (
    context.nodeEnv !== "production" &&
    context.probeFlag === "true" &&
    isLoopbackHostname(context.hostname)
  );
}

export function isLocalArtifactDataActionProbe(
  request: ArtifactDataE2EActionProbeRequest,
): boolean {
  return (
    isArtifactDataE2EProbeEnabled(request) &&
    request.method === "POST" &&
    request.pathname === "/test-user/artifact-data" &&
    request.hasNextActionHeader
  );
}
