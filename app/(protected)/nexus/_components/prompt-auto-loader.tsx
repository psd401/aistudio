'use client'

import { useEffect, useRef } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { useComposerRuntime } from '@assistant-ui/react'
import { useAction } from '@/lib/hooks/use-action'
import { getPrompt, trackPromptUse } from '@/actions/prompt-library.actions'
import { toast } from 'sonner'
import { createLogger } from '@/lib/client-logger'
import {
  consumeDraftAutoSend,
  DRAFT_AUTO_SEND_PARAM,
} from '@/lib/nexus/draft-auto-send'

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
  // `?draft=<text>` — a free-text prompt prefill (Atrium "Build it for me" and
  // the artifact Ask card deep-link here with the object bound via
  // `?workspace=`). Unlike `promptId`, a draft is PREFILLED only unless the
  // one-shot handshake below says this tab asked for it to be sent. Composer-only: it never touches the conversation
  // tree (docs/features/nexus-conversation-architecture.md invariants hold).
  const draft = searchParams.get('draft')
  // #1791 finding 2: a draft is still PREFILL-ONLY by default. The one
  // exception is a draft this same tab armed immediately before navigating —
  // the Atrium "Ask the agent" card, whose button said "Ask" but only filled a
  // box on another page. `consumeDraftAutoSend` returns true only when this
  // tab's sessionStorage holds this nonce for this exact draft text, so a
  // `?send=` a link carries from outside the app is inert and the draft simply
  // prefills. It returns true at most once: the entry is deleted on read, so a
  // reload or a Back navigation re-prefills rather than sending again.
  const autoSendNonce = searchParams.get(DRAFT_AUTO_SEND_PARAM)
  const processedDraftRef = useRef(false)
  // Unmount-only cancellation for the delayed auto-send. The effect's own
  // cleanup cannot be used: stripping `draft` from the URL changes
  // `searchParams`, re-running the effect and cancelling its own pending send.
  const unmountedRef = useRef(false)
  useEffect(() => {
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
    }
  }, [])

  useEffect(() => {
    if (!draft) return
    if (processedDraftRef.current) return

    // The composer may not be mounted on this effect's first run. Poll briefly
    // (bounded, ~5s) so the prefill is never silently lost — an early return with
    // no dep change would otherwise strand the draft. Cleaned up on unmount.
    let active = true
    let attempts = 0
    const fill = () => {
      if (!active || processedDraftRef.current) return
      const composerState = composer.getState()
      if (!composerState) {
        if (attempts++ < 50) {
          setTimeout(fill, 100)
          return
        }
        // Budget exhausted: say so, and burn the auto-send handshake so it
        // cannot outlive this navigation. `draft` stays in the URL, so a reload
        // still recovers the prefill.
        consumeDraftAutoSend(autoSendNonce, draft)
        log.warn('Composer never became ready; draft not prefilled', {
          length: draft.length,
        })
        return
      }
      processedDraftRef.current = true

      // Cap the prefill defensively (a URL param is user-controlled).
      const text = draft.slice(0, 4000)
      composer.setText(text)
      // Consume BEFORE the URL rewrite below: the rewrite re-runs this effect
      // with the params gone, and a handshake left unconsumed would outlive the
      // navigation it was armed for.
      const autoSend = consumeDraftAutoSend(autoSendNonce, draft)
      log.info('Draft prompt prefilled in composer', {
        length: draft.length,
        autoSend,
      })

      // Strip `draft` (and the handshake nonce) from the URL, preserving every
      // other param (workspace/id/…).
      const stripDraftFromUrl = () => {
        const params = new URLSearchParams(searchParams.toString())
        params.delete('draft')
        params.delete(DRAFT_AUTO_SEND_PARAM)
        const qs = params.toString()
        router.replace(qs ? `/nexus?${qs}` : '/nexus')
      }

      if (!autoSend) {
        stripDraftFromUrl()
        return
      }
      // Same one-tick delay the promptId path uses: `setText` must settle into
      // the composer before `send` reads it, or an empty message is dispatched.
      // The URL is stripped only AFTER sending — stripping first re-ran this
      // effect, whose cleanup then cancelled the send (prefill only).
      setTimeout(() => {
        if (unmountedRef.current) return
        composer.send()
        log.info('Draft prompt auto-sent from an in-app ask', {
          length: text.length,
        })
        stripDraftFromUrl()
      }, 100)
    }
    fill()
    return () => {
      active = false
    }
  }, [draft, autoSendNonce, composer, router, searchParams])

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
