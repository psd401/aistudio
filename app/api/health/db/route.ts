import { NextResponse } from 'next/server'
import { executeSQL } from '@/lib/streaming/nexus/db-helpers'
import { createLogger, generateRequestId } from '@/lib/logger'

/**
 * GET /api/health/db - Database connectivity health check
 * Tests RDS Data API connectivity and configuration
 */
export async function GET() {
  const requestId = generateRequestId()
  const log = createLogger({ requestId, route: 'health.db' })

  const startTime = Date.now()

  try {
    log.info('Database health check started')

    // Check environment variables
    const hasResourceArn = !!process.env.RDS_RESOURCE_ARN
    const hasSecretArn = !!process.env.RDS_SECRET_ARN
    const hasRegion = !!process.env.AWS_REGION

    if (!hasResourceArn || !hasSecretArn) {
      log.error('Missing required environment variables', {
        hasResourceArn,
        hasSecretArn,
        hasRegion
      })
      return NextResponse.json(
        {
          success: false,
          error: 'Missing RDS configuration',
          config: {
            hasResourceArn,
            hasSecretArn,
            hasRegion
          },
          requestId,
          timestamp: new Date().toISOString()
        },
        { status: 503 }
      )
    }

    // Test database connectivity with simple query
    const result = await executeSQL('SELECT 1 as health_check, current_timestamp as db_time')

    const duration = Date.now() - startTime

    log.info('Database health check passed', {
      duration,
      dbTime: result[0]?.db_time
    })

    return NextResponse.json({
      success: true,
      message: 'Database connection successful',
      config: {
        hasResourceArn,
        hasSecretArn,
        hasRegion,
        region: process.env.AWS_REGION
      },
      test: {
        query: 'SELECT 1 as health_check, current_timestamp as db_time',
        result: result[0],
        duration
      },
      requestId,
      timestamp: new Date().toISOString()
    })
  } catch (error) {
    const duration = Date.now() - startTime

    log.error('Database health check failed', {
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : 'Unknown',
      stack: error instanceof Error ? error.stack : undefined,
      duration
    })

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Database connection failed',
        errorName: error instanceof Error ? error.name : 'Unknown',
        config: {
          hasResourceArn: !!process.env.RDS_RESOURCE_ARN,
          hasSecretArn: !!process.env.RDS_SECRET_ARN,
          hasRegion: !!process.env.AWS_REGION
        },
        duration,
        requestId,
        timestamp: new Date().toISOString()
      },
      { status: 503 }
    )
  }
}
