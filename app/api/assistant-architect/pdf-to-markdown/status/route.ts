import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth/server-session";
import { getGenericJobById, getGenericJobByIdForUser } from "@/lib/db/drizzle";
import { getCurrentUserAction } from "@/actions/db/get-current-user-action";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";
import { legacyContentRetirementResponse } from "@/lib/repositories/content-platform/legacy-retirement-response";

interface JobResult {
  jobId: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  markdown?: string;
  fileName?: string;
  processingTime?: number;
}

type GenericJob = NonNullable<
  Awaited<ReturnType<typeof getGenericJobByIdForUser>>
>;

async function loadOwnedJob(
  jobId: number,
  userId: number,
): Promise<{ job: GenericJob; replicationLag: boolean } | null> {
  const job = await getGenericJobByIdForUser(jobId, userId);
  if (job) return { job, replicationLag: false };

  const anyJob = await getGenericJobById(jobId);
  return anyJob?.userId === userId
    ? { job: anyJob, replicationLag: true }
    : null;
}

function formatJobResult(job: GenericJob): JobResult {
  const result: JobResult = {
    jobId: job.id,
    status: job.status,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
  if (job.status === "completed" && job.output) {
    return {
      ...result,
      ...(JSON.parse(job.output) as Record<string, unknown>),
    };
  }
  if (job.status === "failed") {
    result.error = job.error || "Processing failed";
  }
  return result;
}

export async function GET(req: NextRequest) {
  const requestId = generateRequestId();
  const timer = startTimer("api.assistant-architect.pdf-status");
  const log = createLogger({
    requestId,
    route: "api.assistant-architect.pdf-status",
  });

  log.info(
    "GET /api/assistant-architect/pdf-to-markdown/status - Checking job status",
  );

  const headers = {
    "Content-Type": "application/json",
    "X-Request-Id": requestId,
  };

  const session = await getServerSession();
  if (!session || !session.sub) {
    log.warn("Unauthorized - No session");
    timer({ status: "error", reason: "unauthorized" });
    return new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers,
    });
  }

  // Get the current user's database ID
  const currentUser = await getCurrentUserAction();
  if (!currentUser.isSuccess || !currentUser.data) {
    log.warn("User not found");
    timer({ status: "error", reason: "user_not_found" });
    return new NextResponse(JSON.stringify({ error: "User not found" }), {
      status: 401,
      headers,
    });
  }

  const retired = await legacyContentRetirementResponse();
  if (retired) {
    timer({ status: "success", reason: "legacy_retired" });
    return retired;
  }

  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("jobId");
  if (!jobId) {
    log.warn("Job ID is required");
    timer({ status: "error", reason: "missing_job_id" });
    return new NextResponse(JSON.stringify({ error: "Job ID is required" }), {
      status: 400,
      headers,
    });
  }

  log.debug("Checking job status", { userId: currentUser.data.user.id, jobId });

  try {
    const jobIdNum = Number.parseInt(jobId, 10);
    if (Number.isNaN(jobIdNum)) {
      log.warn("Invalid job ID format", { jobId });
      timer({ status: "error", reason: "invalid_job_id" });
      return new NextResponse(JSON.stringify({ error: "Invalid job ID" }), {
        status: 400,
        headers,
      });
    }

    const loaded = await loadOwnedJob(jobIdNum, currentUser.data.user.id);
    if (!loaded) {
      log.warn("Job not found", { jobId });
      timer({ status: "error", reason: "job_not_found" });
      return new NextResponse(JSON.stringify({ error: "Job not found" }), {
        status: 404,
        headers,
      });
    }
    if (loaded.replicationLag) {
      log.info("Job found with replication lag", {
        jobId,
        status: loaded.job.status,
      });
      timer({ status: "success", jobStatus: loaded.job.status });
      return new NextResponse(
        JSON.stringify({ jobId: jobIdNum, status: loaded.job.status }),
        { status: 200, headers },
      );
    }

    let result: JobResult;
    try {
      result = formatJobResult(loaded.job);
    } catch (error) {
      log.error("Failed to parse job output", error);
      timer({ status: "error", reason: "parse_error" });
      return new NextResponse(
        JSON.stringify({ error: "Failed to parse job result" }),
        { status: 500, headers },
      );
    }

    log.info("Job status retrieved", { jobId, status: result.status });
    timer({ status: "success", jobStatus: result.status });
    return new NextResponse(JSON.stringify(result), { status: 200, headers });
  } catch (error) {
    timer({ status: "error" });
    log.error("Error checking job status", error);
    return new NextResponse(
      JSON.stringify({ error: "Failed to check job status" }),
      { status: 500, headers },
    );
  }
}
