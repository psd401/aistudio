"use client"

import { useEffect } from "react"
import { initializeErrorCapture, cleanupErrorCapture } from "@/lib/error-capture"

export function ErrorCaptureInit() {
  useEffect(() => {
    initializeErrorCapture()
    return () => cleanupErrorCapture()
  }, [])

  return null
}
