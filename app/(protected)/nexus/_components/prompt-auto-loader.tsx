'use client'

import { useEffect, useRef } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { useComposerRuntime } from '@assistant-ui/react'
import { useAction } from '@/lib/hooks/use-action'
import { getPrompt, trackPromptUse } from '@/actions/prompt-library.actions'
import { toast } from 'sonner'
import { createLogger } from '@/lib/client-logger'

const log = createLogger({ moduleName: 'prompt-auto-loader' })

/**
 * Component that automatically loads and sends a prompt from the Prompt Library
 * when the promptId URL parameter is present.
 *
 * This enables the "Use Prompt" functionality from the Prompt Library.
 */
export function PromptAutoLoader() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const composer = useComposerRuntime()

  // Track which prompts we've already processed to prevent duplicate sends
  const processedPromptsRef = useRef<Set<string>>(new Set())

  const { execute: executeGetPrompt } = useAction(getPrompt, {
    showSuccessToast: false,
    showErrorToast: false
  })

  const { execute: executeTrackUse } = useAction(trackPromptUse, {
    showSuccessToast: false,
    showErrorToast: false
  })

  const promptId = searchParams.get('promptId')
  // `?draft=<text>` — a free-text prompt prefill (Atrium "Create with the agent"
  // deep-links here with the new artifact bound via `?workspace=`). Unlike
  // `promptId`, a draft is PREFILLED only (never auto-sent) so the author reviews
  // it before the agent builds. Composer-only: it never touches the conversation
  // tree (docs/features/nexus-conversation-architecture.md invariants hold).
  const draft = searchParams.get('draft')
  const processedDraftRef = useRef(false)

  useEffect(() => {
    if (!draft) return
    if (processedDraftRef.current) return
    const composerState = composer.getState()
    if (!composerState) return // composer not mounted yet — retry next render
    processedDraftRef.current = true

    // Cap the prefill defensively (a URL param is user-controlled).
    composer.setText(draft.slice(0, 4000))
    log.info('Draft prompt prefilled in composer', { length: draft.length })

    // Strip `draft` from the URL, preserving every other param (workspace/id/…).
    const params = new URLSearchParams(searchParams.toString())
    params.delete('draft')
    const qs = params.toString()
    router.replace(qs ? `/nexus?${qs}` : '/nexus')
  }, [draft, composer, router, searchParams])

  useEffect(() => {
    async function loadAndSendPrompt() {
      if (!promptId) return

      // Don't process the same prompt twice
      if (processedPromptsRef.current.has(promptId)) {
        log.debug('Prompt already processed, skipping', { promptId })
        return
      }

      // Mark as processed IMMEDIATELY to prevent infinite loops on errors
      processedPromptsRef.current.add(promptId)

      // Check if composer is ready
      const composerState = composer.getState()
      if (!composerState) {
        log.warn('Composer not ready yet', { promptId })
        // Remove promptId from URL since we can't process it
        const params = new URLSearchParams(searchParams.toString())
        params.delete('promptId')
        router.replace(`/nexus?${params.toString()}`)
        return
      }

      log.info('Loading prompt from library', { promptId })

      try {
        // Fetch the prompt
        const result = await executeGetPrompt(promptId)

        if (!result?.isSuccess || !result.data) {
          log.error('Failed to load prompt', { promptId, error: result?.message })
          toast.error('Failed to load prompt', {
            description: result?.message || 'Could not load the selected prompt'
          })
          // Remove promptId from URL on error
          const params = new URLSearchParams(searchParams.toString())
          params.delete('promptId')
          router.replace(`/nexus?${params.toString()}`)
          return
        }

        const prompt = result.data
        log.info('Prompt loaded successfully', {
          promptId,
          title: prompt.title,
          contentLength: prompt.content.length
        })

        // Set the prompt content in the composer
        composer.setText(prompt.content)

        log.debug('Prompt text set in composer', { promptId })

        // Small delay to ensure the text is fully set before sending
        setTimeout(async () => {
          // Track prompt use before sending
          await executeTrackUse(promptId)

          // Send the message
          composer.send()

          log.info('Prompt sent to chat', { promptId })

          // Clean up URL by removing promptId parameter
          const params = new URLSearchParams(searchParams.toString())
          params.delete('promptId')
          const newUrl = params.toString() ? `/nexus?${params.toString()}` : '/nexus'
          router.replace(newUrl)

          log.debug('URL cleaned up', { newUrl })
        }, 100)

      } catch (error) {
        log.error('Error loading prompt', {
          promptId,
          error: error instanceof Error ? error.message : String(error)
        })
        toast.error('Error loading prompt', {
          description: 'An unexpected error occurred while loading the prompt'
        })
        // Remove promptId from URL on error
        const params = new URLSearchParams(searchParams.toString())
        params.delete('promptId')
        router.replace(`/nexus?${params.toString()}`)
      }
    }

    loadAndSendPrompt()
  }, [promptId, composer, executeGetPrompt, executeTrackUse, router, searchParams])

  // This component doesn't render anything - it's purely for side effects
  return null
}
