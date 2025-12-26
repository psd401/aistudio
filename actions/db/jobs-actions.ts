"use server"

import { ActionState } from "@/types"
import {
  type GenericJob,
  type CreateGenericJobData,
  type UpdateGenericJobData,
  createGenericJob,
  getGenericJobById,
  getGenericJobsByUserId,
  updateGenericJob,
  deleteGenericJob,
} from "@/lib/db/drizzle"
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
  job: Omit<CreateGenericJobData, "userId"> & { userId?: number | string }
): Promise<ActionState<GenericJob>> {
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
    if (Number.isNaN(userIdNum)) {
      log.warn("Invalid userId provided", { userId: job.userId })
      return { isSuccess: false, message: "Invalid userId provided." };
    }

    log.info("Creating job in database", {
      userId: userIdNum,
      jobType: job.type,
      status: job.status ?? 'pending'
    })

    const newJob = await createGenericJob({
      userId: userIdNum,
      type: job.type,
      input: job.input,
      status: job.status,
      output: job.output,
      error: job.error,
    })

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

export async function getJobAction(id: string): Promise<ActionState<GenericJob>> {
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
    if (Number.isNaN(idNum)) {
      log.warn("Invalid job ID provided", { jobId: id })
      return { isSuccess: false, message: "Invalid job ID" };
    }

    log.debug("Fetching job from database", { jobId: idNum })
    const job = await getGenericJobById(idNum)

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

export async function getUserJobsAction(userId: string): Promise<ActionState<GenericJob[]>> {
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
    if (Number.isNaN(userIdNum)) {
      log.warn("Invalid user ID provided", { userId })
      return { isSuccess: false, message: "Invalid user ID" };
    }

    log.debug("Fetching user jobs from database", { userId: userIdNum })
    const result = await getGenericJobsByUserId(userIdNum)

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
  data: UpdateGenericJobData
): Promise<ActionState<GenericJob>> {
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
    if (Number.isNaN(idNum)) {
      log.warn("Invalid job ID provided", { jobId: id })
      return { isSuccess: false, message: "Invalid job ID" };
    }

    const fieldsCount = Object.keys(data).length;
    if (fieldsCount === 0) {
      log.warn("No valid fields provided for update")
      return { isSuccess: false, message: "No valid fields to update" };
    }

    log.info("Updating job in database", {
      jobId: idNum,
      fieldsUpdated: fieldsCount
    })

    const updatedJob = await updateGenericJob(idNum, data)

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
    if (Number.isNaN(idNum)) {
      log.warn("Invalid job ID provided", { jobId: id })
      return { isSuccess: false, message: "Invalid job ID" };
    }

    log.info("Deleting job from database", { jobId: idNum })
    const deleted = await deleteGenericJob(idNum)

    if (!deleted) {
      log.warn("Job not found for deletion", { jobId: idNum })
      throw ErrorFactories.dbRecordNotFound("jobs", idNum)
    }

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