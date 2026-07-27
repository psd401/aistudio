import { NextResponse } from "next/server"
import { validateDatabaseConnection } from "@/lib/db/drizzle-client"
import { getServerSession } from "@/lib/auth/server-session"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"

interface HealthCheckResult {
  timestamp: string
  status: string
  checks: {
    environment: {
      status: string
      missingVariables?: string[]
      awsRegion?: string
      nodeEnv?: string
      details?: Record<string, unknown>
      error?: string
    }
    authentication: {
      status: string
      hasSession?: boolean
      sessionUser?: string
      authConfigured?: boolean
      error?: string
      hint?: string
    }
    database: {
      status: string
      success?: boolean
      configured?: boolean
      hint?: string
      error?: unknown
      [key: string]: unknown
    }
    oauthSigning: {
      status: string
      configured?: boolean
      activeKid?: string
      verificationKeyCount?: number
      source?: string
      error?: string
      hint?: string
    }
  }
  diagnostics?: {
    hints: string[]
    deploymentChecklist?: string[]
  }
}

type HealthLogger = ReturnType<typeof createLogger>

const REQUIRED_ENVIRONMENT_VARIABLES = [
  "AUTH_URL",
  "AUTH_SECRET",
  "AUTH_COGNITO_CLIENT_ID",
  "AUTH_COGNITO_ISSUER",
  "NEXT_PUBLIC_COGNITO_USER_POOL_ID",
  "NEXT_PUBLIC_COGNITO_CLIENT_ID",
  "NEXT_PUBLIC_COGNITO_DOMAIN",
  "NEXT_PUBLIC_AWS_REGION",
]

function createHealthCheck(): HealthCheckResult {
  return {
    timestamp: new Date().toISOString(),
    status: "checking",
    checks: {
      environment: { status: "pending" },
      authentication: { status: "pending" },
      database: { status: "pending" },
      oauthSigning: { status: "pending" },
    },
  }
}

function awsRegionSource(): string {
  if (process.env.AWS_REGION) return "AWS_REGION (Amplify)"
  if (process.env.AWS_DEFAULT_REGION) return "AWS_DEFAULT_REGION (Amplify)"
  if (process.env.NEXT_PUBLIC_AWS_REGION) {
    return "NEXT_PUBLIC_AWS_REGION (User)"
  }
  return "none"
}

function checkEnvironment(
  healthCheck: HealthCheckResult,
  log: HealthLogger
): void {
  try {
    const missingVariables = REQUIRED_ENVIRONMENT_VARIABLES.filter(
      (variable) => !process.env[variable]
    )
    const region =
      process.env.AWS_REGION ||
      process.env.AWS_DEFAULT_REGION ||
      process.env.NEXT_PUBLIC_AWS_REGION
    log.debug("Environment check completed", {
      missingVars: missingVariables.length,
      hasRegion: Boolean(region),
    })
    healthCheck.checks.environment = {
      status: missingVariables.length === 0 ? "healthy" : "unhealthy",
      missingVariables,
      awsRegion: region || "not configured (AWS Amplify should provide)",
      nodeEnv: process.env.NODE_ENV,
      details: {
        hasAuthUrl: Boolean(process.env.AUTH_URL),
        hasAuthSecret: Boolean(process.env.AUTH_SECRET),
        hasCognitoConfig: Boolean(
          process.env.AUTH_COGNITO_CLIENT_ID &&
            process.env.AUTH_COGNITO_ISSUER
        ),
        hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
        hasDbHost: Boolean(process.env.DB_HOST),
        dbConfigured: Boolean(
          process.env.DATABASE_URL || process.env.DB_HOST
        ),
        hasAwsRegion: Boolean(region),
        hasAwsExecution: Boolean(process.env.AWS_EXECUTION_ENV),
        awsRegionSource: awsRegionSource(),
      },
    }
  } catch (error) {
    log.error("Environment check failed", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    })
    healthCheck.checks.environment = {
      status: "error",
      error: "Environment validation failed",
    }
  }
}

async function checkAuthentication(
  healthCheck: HealthCheckResult,
  log: HealthLogger
): Promise<void> {
  if (!process.env.AUTH_SECRET || !process.env.AUTH_COGNITO_CLIENT_ID) {
    healthCheck.checks.authentication = {
      status: "unhealthy",
      authConfigured: false,
      hint: "Authentication environment variables not set",
    }
    return
  }
  try {
    const session = await getServerSession()
    log.debug("Authentication check completed", {
      hasSession: Boolean(session),
    })
    healthCheck.checks.authentication = {
      status: "healthy",
      hasSession: Boolean(session),
      sessionUser: session?.email || "no session",
      authConfigured: true,
    }
  } catch (error) {
    log.error("Authentication check failed", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    })
    healthCheck.checks.authentication = {
      status: "error",
      error: "Authentication validation failed",
      hint: "Authentication system may not be properly configured",
    }
  }
}

async function checkDatabase(
  healthCheck: HealthCheckResult,
  log: HealthLogger
): Promise<void> {
  if (!process.env.DATABASE_URL && !process.env.DB_HOST) {
    healthCheck.checks.database = {
      status: "unhealthy",
      configured: false,
      hint:
        "Database not configured. Set DATABASE_URL (local dev) or DB_HOST (AWS ECS)",
    }
    return
  }
  try {
    const validation = await validateDatabaseConnection()
    log.debug("Database check completed", { success: validation.success })
    healthCheck.checks.database = {
      status: validation.success ? "healthy" : "unhealthy",
      success: validation.success,
      configured: true,
      ...(validation.success
        ? {}
        : {
            error: "Database connectivity validation failed",
            hint: "Check application logs for the internal failure details",
          }),
    }
  } catch (error) {
    log.error("Database check failed", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    })
    healthCheck.checks.database = {
      status: "error",
      configured: true,
      error: "Database connectivity validation failed",
      hint: "Check application logs for the internal failure details",
    }
  }
}

async function checkOauthSigning(
  healthCheck: HealthCheckResult,
  log: HealthLogger
): Promise<void> {
  try {
    const { getOidcCookieSecret } = await import(
      "@/lib/oauth/oidc-cookie-secret"
    )
    const { getOidcSigningKeySet } = await import(
      "@/lib/oauth/oidc-signing-key-store"
    )
    getOidcCookieSecret()
    const keySet = await getOidcSigningKeySet()
    healthCheck.checks.oauthSigning = {
      status: "healthy",
      configured: true,
      activeKid: keySet.activeKid,
      verificationKeyCount: keySet.publicKeys.length,
      source: keySet.source,
    }
  } catch (error) {
    log.error("OIDC provider cryptographic health check failed", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    })
    healthCheck.checks.oauthSigning = {
      status: "unhealthy",
      configured: Boolean(
        process.env.OIDC_COOKIE_SECRET &&
          process.env.OIDC_SIGNING_JWKS_SECRET_ARN
      ),
      error: "OIDC provider cryptographic configuration is unavailable",
      hint:
        "Check application logs and the deployment's cookie/signing-key configuration.",
    }
  }
}

function addDatabaseDiagnostic(healthCheck: HealthCheckResult): void {
  if (
    healthCheck.checks.database.status === "healthy" ||
    !healthCheck.diagnostics
  ) {
    return
  }
  healthCheck.diagnostics.hints.push(
    healthCheck.checks.database.configured
      ? "Database connectivity issue. Check DATABASE_URL or DB_HOST/DB_USER/DB_PASSWORD values."
      : "Database not configured. Set DATABASE_URL (local dev) or DB_HOST (AWS ECS)."
  )
}

function addDiagnostics(healthCheck: HealthCheckResult): void {
  healthCheck.diagnostics = { hints: [] }
  if (healthCheck.checks.environment.status !== "healthy") {
    healthCheck.diagnostics.hints.push(
      "Missing environment variables. Check AWS Amplify console environment variables configuration."
    )
  }
  addDatabaseDiagnostic(healthCheck)
  if (healthCheck.checks.oauthSigning.status !== "healthy") {
    healthCheck.diagnostics.hints.push(
      "OAuth provider cryptographic configuration is unavailable. Token issuance fails closed until the dedicated cookie secret, shared OIDC key-set secret, and ECS permissions are repaired."
    )
  }
  healthCheck.diagnostics.deploymentChecklist = [
    "1. Set all required environment variables in AWS ECS task definition",
    "2. For AWS: DB_HOST, DB_USER, DB_PASSWORD are injected from Secrets Manager",
    "3. For local dev: Set DATABASE_URL in .env.local",
    "4. Check CloudWatch/container logs for detailed error messages",
    "5. Verify security group allows traffic from ECS to Aurora on port 5432",
  ]
}

function publicHealthResponse(healthCheck: HealthCheckResult) {
  return {
    timestamp: healthCheck.timestamp,
    status: healthCheck.status,
    checks: {
      environment: { status: healthCheck.checks.environment.status },
      authentication: { status: healthCheck.checks.authentication.status },
      database: { status: healthCheck.checks.database.status },
      oauthSigning: { status: healthCheck.checks.oauthSigning.status },
    },
  }
}

/**
 * Health Check API Endpoint
 *
 * Validates:
 * - Environment variable configuration
 * - AWS credentials and region setup
 * - RDS Data API connectivity
 * - Basic database query execution
 *
 * Returns detailed diagnostic information to help troubleshoot deployment issues
 */
export async function GET() {
  const requestId = generateRequestId()
  const timer = startTimer("api.health")
  const log = createLogger({ requestId, route: "api.health" })
  const healthCheck = createHealthCheck()
  log.info("GET /api/health - Health check requested")

  checkEnvironment(healthCheck, log)
  await checkAuthentication(healthCheck, log)
  await checkDatabase(healthCheck, log)
  await checkOauthSigning(healthCheck, log)

  const allHealthy = Object.values(healthCheck.checks).every(
    (check) => check.status === "healthy"
  )
  healthCheck.status = allHealthy ? "healthy" : "unhealthy"

  log.info("Health check completed", {
    status: healthCheck.status,
    environmentStatus: healthCheck.checks.environment.status,
    authStatus: healthCheck.checks.authentication.status,
    databaseStatus: healthCheck.checks.database.status,
  })
  timer({ status: allHealthy ? "success" : "unhealthy" })
  if (!allHealthy) addDiagnostics(healthCheck)

  return NextResponse.json(
    publicHealthResponse(healthCheck),
    {
      status: allHealthy ? 200 : 503,
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Content-Type": "application/json",
        "X-Request-Id": requestId,
      },
    }
  )
}
