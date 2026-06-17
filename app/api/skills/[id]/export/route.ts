import { NextRequest, NextResponse } from "next/server"
import JSZip from "jszip"
import { and, eq } from "drizzle-orm"
import { getServerSession } from "@/lib/auth/server-session"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { ErrorFactories, handleError } from "@/lib/error-utils"
import { executeQuery } from "@/lib/db/drizzle-client"
import { psdAgentSkills } from "@/lib/db/schema/tables/agent-skills"
import { downloadSkillFolder } from "@/lib/skills/skill-publish-pipeline"

/**
 * Zip export of an approved skill's SKILL.md folder (Issue #925, AC#7).
 *
 * Streams the authored skill folder (SKILL.md + any bundled files, excluding the
 * scan pipeline's node_modules) as a .zip so it can be dropped into Claude Code /
 * Desktop. Only APPROVED skills (scope = 'shared', scanStatus = 'clean') are
 * exportable, to any authenticated user.
 *
 * Runs on the Node.js runtime (AWS SDK + JSZip).
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SAFE_FILENAME_RE = /[^a-zA-Z0-9_.-]/g

async function getHandler(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = generateRequestId()
  const timer = startTimer("GET /api/skills/[id]/export")
  const log = createLogger({ requestId, endpoint: "GET /api/skills/[id]/export" })

  try {
    const { id } = await params
    if (!UUID_RE.test(id)) {
      throw ErrorFactories.invalidInput("id", id, "must be a UUID")
    }

    const session = await getServerSession()
    if (!session?.sub) {
      log.warn("Unauthorized skill export attempt")
      throw ErrorFactories.authNoSession()
    }

    const [skill] = await executeQuery(
      (db) =>
        db
          .select({
            name: psdAgentSkills.name,
            s3Key: psdAgentSkills.s3Key,
          })
          .from(psdAgentSkills)
          .where(
            and(
              eq(psdAgentSkills.id, id),
              eq(psdAgentSkills.scope, "shared"),
              eq(psdAgentSkills.scanStatus, "clean")
            )
          )
          .limit(1),
      "skillsExport.lookup"
    )

    if (!skill) {
      return NextResponse.json({ error: "Skill not found" }, { status: 404 })
    }

    const files = await downloadSkillFolder(skill.s3Key)
    if (files.length === 0) {
      log.warn("No skill artifacts to export", { skillId: id })
      return NextResponse.json(
        { error: "Skill artifacts are not available for export" },
        { status: 404 }
      )
    }

    const zip = new JSZip()
    const folder = zip.folder(skill.name) ?? zip
    for (const file of files) {
      folder.file(file.path, file.content)
    }
    const buffer = await zip.generateAsync({ type: "nodebuffer" })

    const safeName = skill.name.replace(SAFE_FILENAME_RE, "-") || "skill"

    timer({ status: "success" })
    log.info("Exported skill as zip", { skillId: id, fileCount: files.length })

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${safeName}.zip"`,
        "Content-Length": String(buffer.length),
        "Cache-Control": "no-store",
      },
    })
  } catch (error) {
    timer({ status: "error" })
    const result = handleError(error, "Failed to export skill", {
      context: "skillsExport",
      requestId,
      operation: "GET /api/skills/[id]/export",
    })
    return NextResponse.json(
      { error: result.message },
      { status: 500 }
    )
  }
}

export { getHandler as GET }
