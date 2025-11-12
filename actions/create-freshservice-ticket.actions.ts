"use server"

import { ActionState } from "@/types"
import { Settings } from "@/lib/settings-manager"
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

interface FreshserviceTicketResponse {
  ticket_url: string
  ticket_id: number
}

// Define proper interface for Freshservice API response
// Note: Freshservice API v2 wraps ticket data in a nested structure
interface FreshserviceTicketData {
  id: number | string  // Can be either based on request type (JSON vs multipart)
  display_id?: string | number
  subject?: string
  description?: string
  status?: number
  priority?: number
  created_at?: string
  updated_at?: string
  [key: string]: unknown
}

// Freshservice API v2 wraps the ticket data in a "ticket" property
interface FreshserviceApiResponse {
  ticket: FreshserviceTicketData
}

export async function createFreshserviceTicketAction(
  formData: FormData
): Promise<ActionState<FreshserviceTicketResponse>> {
  const requestId = generateRequestId()
  const timer = startTimer("createFreshserviceTicket")
  const log = createLogger({ requestId, action: "createFreshserviceTicket" })
  
  try {
    // Extract form data
    const title = formData.get('title') as string
    const description = formData.get('description') as string
    const screenshot = formData.get('screenshot') as File | null
    
    log.info("Action started: Creating Freshservice ticket", {
      titleLength: title?.length,
      descriptionLength: description?.length,
      hasScreenshot: !!screenshot
    })
    
    // Validate required fields
    if (!title || !description) {
      log.warn("Missing required fields", { title: !!title, description: !!description })
      const fields = []
      if (!title) fields.push({ field: "title", message: "Title is required" })
      if (!description) fields.push({ field: "description", message: "Description is required" })
      throw ErrorFactories.validationFailed(fields)
    }
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized Freshservice ticket creation attempt")
      throw ErrorFactories.authNoSession()
    }
    
    log.debug("User authenticated", { userId: session.sub })
    
    const settings = await Settings.getFreshservice()
    if (!settings.domain || !settings.apiKey || !settings.departmentId) {
      log.error("Freshservice not configured", { 
        hasDomain: !!settings.domain, 
        hasApiKey: !!settings.apiKey,
        hasDepartmentId: !!settings.departmentId 
      })
      throw ErrorFactories.sysConfigurationError("Freshservice not configured. Please contact your administrator to set up FRESHSERVICE_DOMAIN, FRESHSERVICE_API_KEY, and FRESHSERVICE_DEPARTMENT_ID.")
    }
    
    // Validate domain format to prevent SSRF attacks
    const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]$/
    if (!domainRegex.test(settings.domain)) {
      log.error("Invalid Freshservice domain format", { domain: sanitizeForLogging({ domain: settings.domain }) })
      throw ErrorFactories.validationFailed([
        { field: "domain", message: "Invalid Freshservice domain configuration" }
      ])
    }
    
    // Prepare API request
    const apiUrl = `https://${settings.domain}.freshservice.com/api/v2/tickets`
    const encodedKey = Buffer.from(settings.apiKey + ":X").toString("base64")
    
    let response: Response
    
    // Check if we have a screenshot attachment
    const hasAttachment = screenshot && screenshot.size > 0
    
    if (hasAttachment) {
      // Validate screenshot
      const maxSizeBytes = 10 * 1024 * 1024 // 10MB
      if (screenshot.size > maxSizeBytes) {
        log.warn("Screenshot too large", { size: screenshot.size, maxSize: maxSizeBytes })
        throw ErrorFactories.validationFailed([
          { field: "screenshot", message: "Screenshot must be smaller than 10MB" }
        ])
      }
      
      // Validate file type - explicitly allow only safe image types
      const ALLOWED_IMAGE_TYPES = [
        'image/jpeg',
        'image/jpg', 
        'image/png',
        'image/gif',
        'image/webp'
      ]
      
      if (!ALLOWED_IMAGE_TYPES.includes(screenshot.type)) {
        log.warn("Invalid file type", { type: screenshot.type })
        throw ErrorFactories.validationFailed([
          { field: "screenshot", message: "Only JPEG, PNG, GIF, and WebP images are supported" }
        ])
      }
      
      // Use multipart/form-data for requests with attachments
      const freshserviceFormData = new FormData()
      freshserviceFormData.append('subject', title)
      freshserviceFormData.append('description', description)
      freshserviceFormData.append('email', session.email || 'noreply@psd401.org')
      freshserviceFormData.append('priority', settings.priority)
      freshserviceFormData.append('status', settings.status)
      freshserviceFormData.append('department_id', settings.departmentId)
      freshserviceFormData.append('type', settings.ticketType)
      
      // Add workspace_id for multipart requests
      if (settings.workspaceId) {
        freshserviceFormData.append('workspace_id', settings.workspaceId)
      }
      
      freshserviceFormData.append('attachments[]', screenshot, screenshot.name || 'screenshot.png')
      
      log.info("Calling Freshservice API with attachment", {
        domain: settings.domain,
        titlePreview: title.substring(0, 50),
        priority: settings.priority,
        status: settings.status,
        hasWorkspace: !!settings.workspaceId,
        hasApiKey: !!settings.apiKey
      })
      
      response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${encodedKey}`
          // Note: Don't set Content-Type, fetch will set it with boundary for multipart/form-data
        },
        body: freshserviceFormData
      })
    } else {
      // Use JSON for requests without attachments
      const ticketData: Record<string, string | number> = {
        subject: title,
        description: description,
        email: session.email || 'noreply@psd401.org',
        priority: parseInt(settings.priority),
        status: parseInt(settings.status),
        department_id: parseInt(settings.departmentId),
        type: settings.ticketType
      }
      
      // Add workspace_id for JSON requests
      if (settings.workspaceId) {
        ticketData.workspace_id = parseInt(settings.workspaceId)
      }
      
      log.info("Calling Freshservice API with JSON", {
        domain: settings.domain,
        titlePreview: title.substring(0, 50),
        priority: settings.priority,
        status: settings.status,
        hasWorkspace: !!settings.workspaceId,
        hasApiKey: !!settings.apiKey
      })
      
      response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${encodedKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(ticketData)
      })
    }
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      let errorData
      try {
        errorData = JSON.parse(errorText)
      } catch {
        errorData = { message: errorText || `HTTP ${response.status}` }
      }
      
      log.error("Freshservice API error", {
        status: response.status,
        statusText: response.statusText,
        error: sanitizeForLogging(errorData)
      })
      
      // Handle specific error cases
      if (response.status === 401) {
        throw ErrorFactories.externalServiceError("Freshservice", new Error("Invalid API key or unauthorized"))
      } else if (response.status === 404) {
        throw ErrorFactories.externalServiceError("Freshservice", new Error("Domain not found. Please check FRESHSERVICE_DOMAIN setting"))
      } else if (response.status >= 500) {
        throw ErrorFactories.externalServiceError("Freshservice", new Error("Freshservice server error. Please try again later"))
      }
      
      throw ErrorFactories.externalServiceError("Freshservice", new Error(errorData.message || `API returned ${response.status}`))
    }
    
    const apiResponse: FreshserviceApiResponse = await response.json()

    // Log the response for debugging
    log.debug("Freshservice response received", {
      responseKeys: Object.keys(apiResponse),
      hasTicketProperty: 'ticket' in apiResponse,
      ticketKeys: apiResponse.ticket ? Object.keys(apiResponse.ticket) : [],
      ticketId: apiResponse.ticket?.id,
      ticketIdType: typeof apiResponse.ticket?.id,
      displayId: apiResponse.ticket?.display_id
    })

    // Extract ticket data from nested response
    const ticketData = apiResponse.ticket
    if (!ticketData) {
      log.error("No ticket data in response", {
        responseKeys: Object.keys(apiResponse),
        fullResponse: apiResponse
      })
      throw ErrorFactories.externalServiceError("Freshservice", new Error("Invalid ticket response - no ticket data"))
    }

    // Robust ticket ID validation - handle both string and number formats
    const ticketId = typeof ticketData.id === 'string' ? parseInt(ticketData.id, 10) : ticketData.id
    if (!ticketId || isNaN(ticketId) || ticketId <= 0) {
      log.error("Invalid ticket ID in response", {
        rawTicketId: ticketData.id,
        parsedTicketId: ticketId,
        ticketIdType: typeof ticketData.id,
        ticketKeys: Object.keys(ticketData)
      })
      throw ErrorFactories.externalServiceError("Freshservice", new Error("Invalid ticket response"))
    }
    
    const ticketUrl = `https://${settings.domain}.freshservice.com/support/tickets/${ticketId}`

    log.info("Freshservice ticket created successfully", {
      ticketUrl,
      ticketId: ticketId,
      ticketNumber: ticketData.display_id || ticketId,
      rawTicketId: ticketData.id
    })

    timer({ status: "success", ticketId: ticketId })

    return createSuccess(
      {
        ticket_url: ticketUrl,
        ticket_id: ticketId
      },
      "Ticket created successfully"
    )
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to create ticket. Please try again or contact support.", {
      context: "createFreshserviceTicket",
      requestId,
      operation: "createFreshserviceTicket",
      metadata: { 
        titleLength: formData.get('title')?.toString()?.length,
        hasScreenshot: !!formData.get('screenshot')
      }
    })
  }
}