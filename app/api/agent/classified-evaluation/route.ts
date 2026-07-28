/* eslint-disable logging/require-request-id -- This compatibility file only re-exports the fully instrumented workflow handler. */
// One-release compatibility alias for agent images that still call the
// classified-evaluation route. Delete after the psd-workflows image is rolled out.
export { POST } from "@/app/api/agent/workflow-gateway/route"
