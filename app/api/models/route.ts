import { withErrorHandling, unauthorized } from '@/lib/api-utils';
import { getServerSession } from '@/lib/auth/server-session';
import { getNexusEnabledModels } from '@/lib/db/drizzle';
import { getUserIdByCognitoSubAsNumber } from '@/lib/db/drizzle/utils';
import { filterAccessibleResourceIds } from '@/lib/db/drizzle/resource-access';
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

    // Server-side per-resource access enforcement (#1206). The client dropdown's
    // role filter is advisory (and was fail-open); this is the authoritative
    // gate. A model with resource_access_grants is only returned to a user who
    // holds a matching role/group grant; a model with no grants stays available
    // to everyone; administrators see all. Resolve the numeric user id from the
    // Cognito sub; a user with no DB row (should not happen for an authenticated
    // session) fails CLOSED to unrestricted-only via filterAccessibleResourceIds.
    const userId = await getUserIdByCognitoSubAsNumber(session.sub);
    const accessibleIds = await filterAccessibleResourceIds(
      userId ?? -1,
      "model",
      models.map((m) => m.id)
    );
    const visibleModels = models.filter((m) => accessibleIds.has(String(m.id)));

    log.info("Models retrieved successfully", {
      total: models.length,
      visible: visibleModels.length,
    });
    timer({ status: "success", count: visibleModels.length });

    return visibleModels;
  });
}
