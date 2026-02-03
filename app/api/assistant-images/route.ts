import { NextResponse } from "next/server"
import fs from "node:fs"
import path from "node:path"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"

export async function GET() {
  const requestId = generateRequestId();
  const timer = startTimer("api.assistant-images.list");
  const log = createLogger({ requestId, route: "api.assistant-images" });
  
  log.info("GET /api/assistant-images - Fetching assistant images");

  try {
    const imagesDir = path.join(process.cwd(), "public", "assistant_logos")
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- hardcoded path, not user input
    const files = fs.readdirSync(imagesDir)
    const images = files.filter(file => file.endsWith(".png"))
    
    log.info("Assistant images fetched", { count: images.length });
    timer({ status: "success", count: images.length });
    return NextResponse.json({ images }, { headers: { "X-Request-Id": requestId } })
  } catch (error) {
    timer({ status: "error" });
    log.error("Error reading assistant images", error)
    return NextResponse.json({ error: "Failed to load images" }, { status: 500, headers: { "X-Request-Id": requestId } })
  }
} 