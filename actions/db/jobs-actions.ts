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
import { getCurrentUserAction } from "@/actions/db/get-current-user-action"
import { hasRole } from "@/utils/roles"
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

/**
 * Resolve the caller's numeric user id + admin flag for ownership checks
 * (REV-COR-038). Every job action authorizes against the OWNING user, not just
 * session presence, so a logged-in user cannot read/tamper/delete other users'
 * jobs by iterating the integer id, nor attribute a created job to someone else.
 */
async function resolveJobCaller(): Promise<{ userId: number; isAdmin: boolean }> {
  const currentUser = await getCurrentUserAction()
  if (!currentUser.isSuccess || !currentUser.data) {
    throw ErrorFactories.authNoSession()
  }
  const isAdmin = await hasRole("administrator")
  return { userId: currentUser.data.user.id, isAdmin }
}

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

    // Attribute the job to the caller. A caller-supplied userId is honored only
    // for administrators (create-on-behalf-of); everyone else is pinned to their
    // own id, so a job can never be framed as another user (REV-COR-038).
    //
    // The trusted, session-derived `isAdmin` flag is the leading condition on
    // every branch that can assign a caller-supplied value to `userIdNum` — the
    // tainted `job.userId` never determines by itself whether an override is
    // permitted (CodeQL js/user-controlled-bypass).
    const { userId: callerId, isAdmin } = await resolveJobCaller()
    const hasRequestedUserId = job.userId !== undefined && job.userId !== null && job.userId !== ''
    let userIdNum: number
    if (isAdmin && hasRequestedUserId) {
      const requested = typeof job.userId === 'string' ? Number.parseInt(job.userId, 10) : job.userId
      if (typeof requested !== 'number' || Number.isNaN(requested)) {
        log.warn("Invalid userId provided", { userId: job.userId })
        return { isSuccess: false, message: "Invalid userId provided." };
      }
      userIdNum = requested
    } else if (!isAdmin && hasRequestedUserId) {
      const requested = typeof job.userId === 'string' ? Number.parseInt(job.userId, 10) : job.userId
      if (typeof requested !== 'number' || Number.isNaN(requested)) {
        log.warn("Invalid userId provided", { userId: job.userId })
        return { isSuccess: false, message: "Invalid userId provided." };
      }
      if (requested !== callerId) {
        log.warn("Non-admin attempted to attribute a job to another user", { requested })
        throw ErrorFactories.authzInsufficientPermissions("create jobs for other users")
      }
      // Assign the trusted, session-derived callerId rather than the
      // tainted `requested` value — the equality check above proves they're
      // the same number, but reusing `requested` here is what CodeQL's
      // js/user-controlled-bypass rule keeps flagging (a user-controlled
      // value reaching the sink, regardless of the preceding guard).
      userIdNum = callerId
    } else {
      userIdNum = callerId
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

    // Ownership check: a non-owner (non-admin) gets not-found, not the job
    // (REV-COR-038 — prevents IDOR read + existence disclosure).
    const { userId: callerId, isAdmin } = await resolveJobCaller()
    if (job.userId !== callerId && !isAdmin) {
      log.warn("Job access denied (not owner)", { jobId: idNum })
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

    // A caller may only list their own jobs unless they are an administrator
    // (REV-COR-038).
    const { userId: callerId, isAdmin } = await resolveJobCaller()
    if (userIdNum !== callerId && !isAdmin) {
      log.warn("User jobs access denied (not self)", { requested: userIdNum })
      throw ErrorFactories.authzInsufficientPermissions("view other users' jobs")
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

    // Ownership check before mutating (REV-COR-038): non-owner → not-found.
    const existingForUpdate = await getGenericJobById(idNum)
    if (!existingForUpdate) {
      throw ErrorFactories.dbRecordNotFound("jobs", idNum)
    }
    const updateCaller = await resolveJobCaller()
    if (existingForUpdate.userId !== updateCaller.userId && !updateCaller.isAdmin) {
      log.warn("Job update denied (not owner)", { jobId: idNum })
      throw ErrorFactories.dbRecordNotFound("jobs", idNum)
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

    // Ownership check before deleting (REV-COR-038): non-owner → not-found.
    const existingForDelete = await getGenericJobById(idNum)
    if (!existingForDelete) {
      throw ErrorFactories.dbRecordNotFound("jobs", idNum)
    }
    const deleteCaller = await resolveJobCaller()
    if (existingForDelete.userId !== deleteCaller.userId && !deleteCaller.isAdmin) {
      log.warn("Job deletion denied (not owner)", { jobId: idNum })
      throw ErrorFactories.dbRecordNotFound("jobs", idNum)
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