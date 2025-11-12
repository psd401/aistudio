"use server"

import { InsertJob, SelectJob } from "@/types/db-types"
import { ActionState } from "@/types"
import { executeSQL } from "@/lib/db/data-api-adapter"
import { SqlParameter } from "@aws-sdk/client-rds-data"
import { getServerSession } from "@/lib/auth/server-session"
import { 
  handleError,
  ErrorFactories,
  createSuccess
} from "@/lib/error-utils"
import {
  createLogger,
  generateRequestId,
  startTimer,
  sanitizeForLogging
} from "@/lib/logger"

export async function createJobAction(
  job: Omit<InsertJob, "id" | "createdAt" | "updatedAt">
): Promise<ActionState<SelectJob>> {
  const requestId = generateRequestId()
  const timer = startTimer("createJob")
  const log = createLogger({ requestId, action: "createJob" })
  
  try {
    log.info("Action started: Creating job", {
      jobType: job.type,
      userId: job.userId
    })
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized job creation attempt")
      throw ErrorFactories.authNoSession()
    }
    
    log.debug("User authenticated", { userId: session.sub })
    
    if (!job.userId) {
      log.warn("Missing userId for job creation")
      return { isSuccess: false, message: "A userId must be provided to create a job." };
    }

    // Convert userId to number if it's a string
    const userIdNum = typeof job.userId === 'string' ? Number.parseInt(job.userId, 10) : job.userId;
    if (isNaN(userIdNum)) {
      log.warn("Invalid userId provided", { userId: job.userId })
      return { isSuccess: false, message: "Invalid userId provided." };
    }

    log.info("Creating job in database", {
      userId: userIdNum,
      jobType: job.type,
      status: job.status ?? 'pending'
    })
    
    const result = await executeSQL<SelectJob>(`
      INSERT INTO jobs (user_id, status, type, input, output, error, created_at, updated_at)
      VALUES (:userId, :status::job_status, :type, :input, :output, :error, NOW(), NOW())
      RETURNING *
    `, [
      { name: 'userId', value: { longValue: userIdNum } },
      { name: 'status', value: { stringValue: job.status ?? 'pending' } },
      { name: 'type', value: { stringValue: job.type } },
      { name: 'input', value: { stringValue: job.input } },
      { name: 'output', value: job.output ? { stringValue: job.output } : { isNull: true } },
      { name: 'error', value: job.error ? { stringValue: job.error } : { isNull: true } },
    ]);
    
    const [newJob] = result;
    if (!newJob) {
      log.error("Failed to create job: no record returned")
      throw ErrorFactories.dbQueryFailed("INSERT INTO jobs", new Error("No record returned"))
    }

    log.info("Job created successfully", {
      jobId: newJob.id,
      jobType: newJob.type,
      status: newJob.status
    })
    
    timer({ status: "success", jobId: newJob.id })
    
    return createSuccess(newJob, "Job created successfully")
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to create job. Please try again or contact support.", {
      context: "createJob",
      requestId,
      operation: "createJob",
      metadata: { jobType: job.type }
    })
  }
}

export async function getJobAction(id: string): Promise<ActionState<SelectJob>> {
  const requestId = generateRequestId()
  const timer = startTimer("getJob")
  const log = createLogger({ requestId, action: "getJob" })
  
  try {
    log.info("Action started: Getting job", { jobId: id })
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized job access attempt")
      throw ErrorFactories.authNoSession()
    }
    
    log.debug("User authenticated", { userId: session.sub })
    
    const idNum = Number.parseInt(id, 10);
    if (isNaN(idNum)) {
      log.warn("Invalid job ID provided", { jobId: id })
      return { isSuccess: false, message: "Invalid job ID" };
    }

    log.debug("Fetching job from database", { jobId: idNum })
    const result = await executeSQL<SelectJob>(
      'SELECT * FROM jobs WHERE id = :id',
      [{ name: 'id', value: { longValue: idNum } }]
    );
    const job = result[0];

    if (!job) {
      log.warn("Job not found", { jobId: idNum })
      throw ErrorFactories.dbRecordNotFound("jobs", idNum)
    }

    log.info("Job retrieved successfully", {
      jobId: job.id,
      jobType: job.type,
      status: job.status
    })
    
    timer({ status: "success", jobId: job.id })
    
    return createSuccess(job, "Job retrieved successfully")
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to get job. Please try again or contact support.", {
      context: "getJob",
      requestId,
      operation: "getJob",
      metadata: { jobId: id }
    })
  }
}

export async function getUserJobsAction(userId: string): Promise<ActionState<SelectJob[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getUserJobs")
  const log = createLogger({ requestId, action: "getUserJobs" })
  
  try {
    log.info("Action started: Getting user jobs", { userId })
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized user jobs access attempt")
      throw ErrorFactories.authNoSession()
    }
    
    log.debug("User authenticated", { userId: session.sub })
    
    const userIdNum = Number.parseInt(userId, 10);
    if (isNaN(userIdNum)) {
      log.warn("Invalid user ID provided", { userId })
      return { isSuccess: false, message: "Invalid user ID" };
    }

    log.debug("Fetching user jobs from database", { userId: userIdNum })
    const result = await executeSQL<SelectJob>(
      'SELECT * FROM jobs WHERE user_id = :userId ORDER BY created_at DESC',
      [{ name: 'userId', value: { longValue: userIdNum } }]
    );

    log.info("User jobs retrieved successfully", {
      userId: userIdNum,
      jobCount: result.length
    })
    
    timer({ status: "success", count: result.length })
    
    return createSuccess(result, "Jobs retrieved successfully")
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to get jobs. Please try again or contact support.", {
      context: "getUserJobs",
      requestId,
      operation: "getUserJobs",
      metadata: { userId }
    })
  }
}

export async function updateJobAction(
  id: string,
  data: Partial<Omit<InsertJob, 'id' | 'userId'>>
): Promise<ActionState<SelectJob>> {
  const requestId = generateRequestId()
  const timer = startTimer("updateJob")
  const log = createLogger({ requestId, action: "updateJob" })
  
  try {
    log.info("Action started: Updating job", {
      jobId: id,
      updates: sanitizeForLogging(data)
    })
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized job update attempt")
      throw ErrorFactories.authNoSession()
    }
    
    log.debug("User authenticated", { userId: session.sub })
    
    const idNum = Number.parseInt(id, 10);
    if (isNaN(idNum)) {
      log.warn("Invalid job ID provided", { jobId: id })
      return { isSuccess: false, message: "Invalid job ID" };
    }

    // Define allowed columns to prevent SQL injection
    const ALLOWED_COLUMNS: Record<string, boolean> = {
      'status': true,
      'output': true,
      'error': true,
      'type': true,
      'input': true
    };

    const setClauses = Object.entries(data)
      .filter(([key, _]) => ALLOWED_COLUMNS[key]) // Only allow whitelisted columns
      .map(([key, _value]) => {
        const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
        if (dbKey === 'status') {
          return `${dbKey} = :${key}::job_status`;
        }
        return `${dbKey} = :${key}`;
      })
      .join(', ');
      
    if (!setClauses) {
      log.warn("No valid fields provided for update")
      return { isSuccess: false, message: "No valid fields to update" };
    }

    log.info("Updating job in database", {
      jobId: idNum,
      fieldsUpdated: Object.keys(data).filter(key => ALLOWED_COLUMNS[key]).length
    })
    
    const parameters: SqlParameter[] = Object.entries(data)
      .filter(([key, _]) => ALLOWED_COLUMNS[key]) // Only include whitelisted columns
      .map(([key, value]) => ({
        name: key,
        value: value === null || value === undefined ? { isNull: true } : { stringValue: String(value) }
      }));
    parameters.push({ name: 'id', value: { longValue: idNum } });
    
    const result = await executeSQL<SelectJob>(
      `UPDATE jobs SET ${setClauses}, updated_at = NOW() WHERE id = :id RETURNING *`,
      parameters
    );

    const [updatedJob] = result;

    if (!updatedJob) {
        log.error("Failed to update job or job not found", { jobId: idNum })
        throw ErrorFactories.dbRecordNotFound("jobs", idNum)
    }

    log.info("Job updated successfully", {
      jobId: updatedJob.id,
      status: updatedJob.status
    })
    
    timer({ status: "success", jobId: updatedJob.id })
    
    return createSuccess(updatedJob, "Job updated successfully")
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to update job. Please try again or contact support.", {
      context: "updateJob",
      requestId,
      operation: "updateJob",
      metadata: { jobId: id }
    })
  }
}

export async function deleteJobAction(id: string): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("deleteJob")
  const log = createLogger({ requestId, action: "deleteJob" })
  
  try {
    log.info("Action started: Deleting job", { jobId: id })
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized job deletion attempt")
      throw ErrorFactories.authNoSession()
    }
    
    log.debug("User authenticated", { userId: session.sub })
    
    const idNum = Number.parseInt(id, 10);
    if (isNaN(idNum)) {
      log.warn("Invalid job ID provided", { jobId: id })
      return { isSuccess: false, message: "Invalid job ID" };
    }

    log.info("Deleting job from database", { jobId: idNum })
    await executeSQL(
      'DELETE FROM jobs WHERE id = :id',
      [{ name: 'id', value: { longValue: idNum } }]
    );
    
    log.info("Job deleted successfully", { jobId: idNum })
    
    timer({ status: "success", jobId: idNum })
    
    return createSuccess(undefined, "Job deleted successfully")
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to delete job. Please try again or contact support.", {
      context: "deleteJob",
      requestId,
      operation: "deleteJob",
      metadata: { jobId: id }
    })
  }
} 