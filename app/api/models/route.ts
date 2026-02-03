import { withErrorHandling, unauthorized } from '@/lib/api-utils';
import { getServerSession } from '@/lib/auth/server-session';
import { getNexusEnabledModels } from '@/lib/db/drizzle';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';

export async function GET() {
  const requestId = generateRequestId();
  const timer = startTimer("api.models");
  const log = createLogger({ requestId, route: "api.models" });

  log.info("GET /api/models - Fetching AI models");

  const session = await getServerSession();

  if (!session) {
    log.warn("Unauthorized access attempt to models");
    timer({ status: "error", reason: "unauthorized" });
    return unauthorized('User not authenticated');
  }

  log.debug("User authenticated", { userId: session.sub });

  return withErrorHandling(async () => {
    const models = await getNexusEnabledModels();

    log.info("Models retrieved successfully", { count: models.length });
    timer({ status: "success", count: models.length });

    return models;
  });
}