import { NextResponse } from "next/server"
import { validateDatabaseConnection } from "@/lib/db/drizzle-client"
import { getServerSession } from "@/lib/auth/server-session"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
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
  const requestId = generateRequestId();
  const timer = startTimer("api.health");
  const log = createLogger({ requestId, route: "api.health" });
  
  log.info("GET /api/health - Health check requested");
  
  // For production, you may want to add authentication or IP restriction
  // For now, we'll allow access but you can uncomment the following to restrict:
  /*
  const session = await getServerSession()
  if (!session) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    )
  }
  */

  interface HealthCheckResult {
    timestamp: string;
    status: string;
    checks: {
      environment: {
        status: string;
        missingVariables?: string[];
        awsRegion?: string;
        nodeEnv?: string;
        details?: Record<string, unknown>;
        error?: string;
      };
      authentication: {
        status: string;
        hasSession?: boolean;
        sessionUser?: string;
        authConfigured?: boolean;
        error?: string;
        hint?: string;
      };
      database: {
        status: string;
        success?: boolean;
        configured?: boolean;
        hint?: string;
        error?: unknown;
        [key: string]: unknown;
      };
      oauthSigning: {
        status: string;
        configured?: boolean;
        activeKid?: string;
        verificationKeyCount?: number;
        source?: string;
        error?: string;
        hint?: string;
      };
    };
    diagnostics?: {
      hints: string[];
      deploymentChecklist?: string[];
    };
  }

  const healthCheck: HealthCheckResult = {
    timestamp: new Date().toISOString(),
    status: "checking",
    checks: {
      environment: { status: "pending" },
      authentication: { status: "pending" },
      database: { status: "pending" },
      oauthSigning: { status: "pending" }
    }
  }

  // 1. Check environment variables
  try {
    const requiredEnvVars = [
      'AUTH_URL',
      'AUTH_SECRET',
      'AUTH_COGNITO_CLIENT_ID',
      'AUTH_COGNITO_ISSUER',
      'NEXT_PUBLIC_COGNITO_USER_POOL_ID',
      'NEXT_PUBLIC_COGNITO_CLIENT_ID',
      'NEXT_PUBLIC_COGNITO_DOMAIN',
      'NEXT_PUBLIC_AWS_REGION'
      // Database config checked separately: DATABASE_URL (local) or DB_HOST (AWS)
    ]

    const missingVars = requiredEnvVars.filter(varName => !process.env[varName])
    // AWS Amplify provides AWS_REGION and AWS_DEFAULT_REGION at runtime
    const region = process.env.AWS_REGION || 
                   process.env.AWS_DEFAULT_REGION || 
                   process.env.NEXT_PUBLIC_AWS_REGION

    log.debug("Environment check completed", { 
      missingVars: missingVars.length,
      hasRegion: !!region 
    });
    
    healthCheck.checks.environment = {
      status: missingVars.length === 0 ? "healthy" : "unhealthy",
      missingVariables: missingVars,
      awsRegion: region || "not configured (AWS Amplify should provide)",
      nodeEnv: process.env.NODE_ENV,
      details: {
        hasAuthUrl: !!process.env.AUTH_URL,
        hasAuthSecret: !!process.env.AUTH_SECRET,
        hasCognitoConfig: !!process.env.AUTH_COGNITO_CLIENT_ID && !!process.env.AUTH_COGNITO_ISSUER,
        // Database: postgres.js driver (Issue #603)
        hasDatabaseUrl: !!process.env.DATABASE_URL,
        hasDbHost: !!process.env.DB_HOST,
        dbConfigured: !!process.env.DATABASE_URL || !!process.env.DB_HOST,
        hasAwsRegion: !!region,
        hasAwsExecution: !!process.env.AWS_EXECUTION_ENV,
        awsRegionSource: process.env.AWS_REGION ? 'AWS_REGION (Amplify)' :
                        process.env.AWS_DEFAULT_REGION ? 'AWS_DEFAULT_REGION (Amplify)' :
                        process.env.NEXT_PUBLIC_AWS_REGION ? 'NEXT_PUBLIC_AWS_REGION (User)' :
                        'none'
      }
    }
  } catch (error) {
    log.error("Environment check failed", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    healthCheck.checks.environment = {
      status: "error",
      error: "Environment validation failed"
    }
  }

  // 2. Check authentication (skip if missing auth config to avoid errors)
  if (process.env.AUTH_SECRET && process.env.AUTH_COGNITO_CLIENT_ID) {
    try {
      const session = await getServerSession()
      log.debug("Authentication check completed", { hasSession: !!session });
      healthCheck.checks.authentication = {
        status: "healthy",
        hasSession: !!session,
        sessionUser: session?.email || "no session",
        authConfigured: true
      }
    } catch (error) {
      log.error("Authentication check failed", {
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      healthCheck.checks.authentication = {
        status: "error",
        error: "Authentication validation failed",
        hint: "Authentication system may not be properly configured"
      }
    }
  } else {
    healthCheck.checks.authentication = {
      status: "unhealthy",
      authConfigured: false,
      hint: "Authentication environment variables not set"
    }
  }

  // 3. Check database connectivity (postgres.js driver - Issue #603)
  // Either DATABASE_URL (local dev) or DB_HOST (AWS ECS) must be configured
  const hasDatabaseUrl = !!process.env.DATABASE_URL;
  const hasAwsDbConfig = !!process.env.DB_HOST;

  if (hasDatabaseUrl || hasAwsDbConfig) {
    try {
      const dbValidation = await validateDatabaseConnection()
      log.debug("Database check completed", { success: dbValidation.success });
      healthCheck.checks.database = {
        status: dbValidation.success ? "healthy" : "unhealthy",
        success: dbValidation.success,
        configured: true,
        ...(dbValidation.success
          ? {}
          : {
              error: "Database connectivity validation failed",
              hint: "Check application logs for the internal failure details",
            }),
      }
    } catch (error) {
      log.error("Database check failed", {
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      healthCheck.checks.database = {
        status: "error",
        configured: true,
        error: "Database connectivity validation failed",
        hint: "Check application logs for the internal failure details",
      }
    }
  } else {
    healthCheck.checks.database = {
      status: "unhealthy",
      configured: false,
      hint: "Database not configured. Set DATABASE_URL (local dev) or DB_HOST (AWS ECS)"
    }
  }

  // 4. Verify that every task has the dedicated production cookie secret and
  // can load the shared OIDC signing key set. The check reports metadata only;
  // private key material, secret values, and secret ARNs are never included in
  // the response or logs.
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

  // 5. Overall health status
  const allHealthy = Object.values(healthCheck.checks).every(
    (check) => check.status === "healthy"
  )
  
  healthCheck.status = allHealthy ? "healthy" : "unhealthy"
  
  log.info("Health check completed", { 
    status: healthCheck.status,
    environmentStatus: healthCheck.checks.environment.status,
    authStatus: healthCheck.checks.authentication.status,
    databaseStatus: healthCheck.checks.database.status
  });
  
  timer({ status: allHealthy ? "success" : "unhealthy" });
  
  // 6. Add diagnostic hints if unhealthy
  if (!allHealthy) {
    healthCheck.diagnostics = {
      hints: []
    }
    
    if (healthCheck.checks.environment.status !== "healthy") {
      healthCheck.diagnostics.hints.push(
        "Missing environment variables. Check AWS Amplify console environment variables configuration."
      )
    }
    
    if (healthCheck.checks.database.status !== "healthy") {
      if (!healthCheck.checks.database.configured) {
        healthCheck.diagnostics.hints.push(
          "Database not configured. Set DATABASE_URL (local dev) or DB_HOST (AWS ECS)."
        )
      } else {
        healthCheck.diagnostics.hints.push(
          "Database connectivity issue. Check DATABASE_URL or DB_HOST/DB_USER/DB_PASSWORD values."
        )
      }
    }

    if (healthCheck.checks.oauthSigning.status !== "healthy") {
      healthCheck.diagnostics.hints.push(
        "OAuth provider cryptographic configuration is unavailable. Token issuance fails closed until the dedicated cookie secret, shared OIDC key-set secret, and ECS permissions are repaired."
      )
    }
    
    // Add deployment checklist
    healthCheck.diagnostics.deploymentChecklist = [
      "1. Set all required environment variables in AWS ECS task definition",
      "2. For AWS: DB_HOST, DB_USER, DB_PASSWORD are injected from Secrets Manager",
      "3. For local dev: Set DATABASE_URL in .env.local",
      "4. Check CloudWatch/container logs for detailed error messages",
      "5. Verify security group allows traffic from ECS to Aurora on port 5432"
    ]
  }

  // This route is intentionally unauthenticated for readiness probes. Expose
  // only health states; configuration values, session identity, key ids,
  // resource sources, SDK messages, and deployment hints remain internal.
  const publicHealthCheck = {
    timestamp: healthCheck.timestamp,
    status: healthCheck.status,
    checks: {
      environment: { status: healthCheck.checks.environment.status },
      authentication: { status: healthCheck.checks.authentication.status },
      database: { status: healthCheck.checks.database.status },
      oauthSigning: { status: healthCheck.checks.oauthSigning.status },
    },
  }

  return NextResponse.json(
    publicHealthCheck,
    { 
      status: allHealthy ? 200 : 503,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Content-Type': 'application/json',
        'X-Request-Id': requestId
      }
    }
  )
}
