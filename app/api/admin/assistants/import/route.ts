import { NextRequest, NextResponse } from "next/server"
import { requireAdmin } from "@/lib/auth/admin-check"
import { getServerSession } from "@/lib/auth/server-session"
import {
  getUserIdByCognitoSubAsNumber,
  createAssistantArchitect,
  createChainPrompt,
  createToolInputField,
} from "@/lib/db/drizzle"
import { validateImportFile, mapModelsForImport, type ExportFormat } from "@/lib/assistant-export-import"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"

export async function POST(request: NextRequest) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.assistants.import");
  const log = createLogger({ requestId, route: "api.admin.assistants.import" });
  
  log.info("POST /api/admin/assistants/import - Importing assistants");

  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }

    // Get session for user ID
    const session = await getServerSession();
    if (!session || !session.sub) {
      return NextResponse.json(
        { isSuccess: false, message: "Session error" },
        { status: 500 }
      )
    }

    // Parse form data to get the file
    const formData = await request.formData()
    const file = formData.get('file') as File

    if (!file) {
      return NextResponse.json(
        { isSuccess: false, message: "No file provided" },
        { status: 400 }
      )
    }

    // Check file size (10MB limit)
    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json(
        { isSuccess: false, message: "File too large. Maximum size is 10MB" },
        { status: 400 }
      )
    }

    // Read and parse file
    const fileContent = await file.text()
    let importData: ExportFormat

    try {
      importData = JSON.parse(fileContent)
    } catch {
      return NextResponse.json(
        { isSuccess: false, message: "Invalid JSON file" },
        { status: 400 }
      )
    }

    // Validate file structure
    const validation = validateImportFile(importData)
    if (!validation.valid) {
      return NextResponse.json(
        { isSuccess: false, message: validation.error },
        { status: 400 }
      )
    }

    log.info("Starting import", { assistantCount: importData.assistants.length })

    // Get user ID from Cognito sub
    const userId = await getUserIdByCognitoSubAsNumber(session.sub)

    if (!userId) {
      return NextResponse.json(
        { isSuccess: false, message: "User not found" },
        { status: 404 }
      )
    }

    // Collect all unique model names for mapping
    const modelNames = new Set<string>()
    for (const assistant of importData.assistants) {
      for (const prompt of assistant.prompts) {
        modelNames.add(prompt.model_name)
      }
    }

    // Map models
    const modelMap = await mapModelsForImport(Array.from(modelNames))

    const importResults = []

    // Import each assistant
    for (const assistant of importData.assistants) {
      try {
        // Create assistant and get the generated ID
        const createdAssistant = await createAssistantArchitect({
          name: assistant.name,
          description: assistant.description || '',
          status: 'pending_approval', // Always import as pending
          imagePath: assistant.image_path,
          isParallel: assistant.is_parallel || false,
          timeoutSeconds: assistant.timeout_seconds,
          userId,
        })

        const assistantId = createdAssistant.id

        // Create prompts
        for (const prompt of assistant.prompts) {
          const modelId = modelMap.get(prompt.model_name)

          if (!modelId) {
            log.warn(`No model mapping found for ${prompt.model_name}, skipping prompt`)
            continue
          }

          await createChainPrompt({
            assistantArchitectId: assistantId,
            name: prompt.name,
            content: prompt.content,
            systemContext: prompt.system_context,
            modelId,
            position: prompt.position,
            parallelGroup: prompt.parallel_group,
            inputMapping: prompt.input_mapping as Record<string, string> || null,
            timeoutSeconds: prompt.timeout_seconds,
          })
        }

        // Create input fields
        for (const field of assistant.input_fields) {
          await createToolInputField({
            assistantArchitectId: assistantId,
            name: field.name,
            label: field.label,
            fieldType: field.field_type as "short_text" | "long_text" | "select" | "multi_select" | "file_upload",
            position: field.position,
            options: field.options || undefined,
          })
        }

        importResults.push({
          name: assistant.name,
          id: assistantId,
          status: 'success'
        })

      } catch (error) {
        log.error(`Error importing assistant ${assistant.name}:`, error)
        importResults.push({
          name: assistant.name,
          status: 'error',
          error: error instanceof Error ? error.message : 'Unknown error'
        })
      }
    }

    // Check if any imports succeeded
    const successCount = importResults.filter(r => r.status === 'success').length
    
    if (successCount === 0) {
      return NextResponse.json(
        { 
          isSuccess: false, 
          message: "Failed to import any assistants",
          details: importResults
        },
        { status: 500 }
      )
    }

    log.info(`Successfully imported ${successCount} out of ${importData.assistants.length} assistants`)

    return NextResponse.json({
      isSuccess: true,
      message: `Successfully imported ${successCount} assistant(s)`,
      data: {
        total: importData.assistants.length,
        successful: successCount,
        failed: importData.assistants.length - successCount,
        results: importResults,
        modelMappings: Array.from(modelMap.entries()).map(([name, id]) => ({ modelName: name, mappedToId: id }))
      }
    })

  } catch (error) {
    log.error('Error importing assistants:', error)

    return NextResponse.json(
      { isSuccess: false, message: 'Failed to import assistants' },
      { status: 500 }
    )
  }
}