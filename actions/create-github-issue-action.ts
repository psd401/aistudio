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

interface CreateGithubIssueInput {
  title: string
  description: string
}

export async function createGithubIssueAction({ title, description }: CreateGithubIssueInput): Promise<ActionState<{ html_url: string }>> {
  const requestId = generateRequestId()
  const timer = startTimer("createGithubIssue")
  const log = createLogger({ requestId, action: "createGithubIssue" })
  
  try {
    log.info("Action started: Creating GitHub issue", {
      titleLength: title?.length,
      descriptionLength: description?.length
    })
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized GitHub issue creation attempt")
      throw ErrorFactories.authNoSession()
    }
    
    log.debug("User authenticated", { userId: session.sub })
    
    const token = await Settings.getGitHub()
    if (!token) {
      log.error("GitHub token not configured")
      return { isSuccess: false, message: "GitHub token not configured. Please set GITHUB_ISSUE_TOKEN in the admin panel." }
    }
    
    log.info("Calling GitHub API to create issue", {
      repo: "psd401/aistudio",
      titlePreview: title.substring(0, 50)
    })

    const res = await fetch("https://api.github.com/repos/psd401/aistudio/issues", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        title,
        body: description,
        labels: ["user-submitted"]
      })
    })
    
    if (!res.ok) {
      const error = await res.json().catch(() => ({}))
      log.error("GitHub API error", {
        status: res.status,
        statusText: res.statusText,
        error: sanitizeForLogging(error)
      })
      
      throw ErrorFactories.externalServiceError("GitHub", new Error(error.message || `GitHub API returned ${res.status}`))
    }
    
    const data = await res.json()
    
    log.info("GitHub issue created successfully", {
      issueUrl: data.html_url,
      issueNumber: data.number
    })
    
    timer({ status: "success", issueNumber: data.number })
    
    return createSuccess({ html_url: data.html_url }, "Issue created")
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to create GitHub issue. Please try again or contact support.", {
      context: "createGithubIssue",
      requestId,
      operation: "createGithubIssue",
      metadata: { titleLength: title?.length }
    })
  }
} 