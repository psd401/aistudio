/** Sanitize an option label/value for React text-node rendering and AI prompt substitution.
 * SAFETY SCOPE: output is safe for React text nodes and AI prompt substitution only.
 * Do NOT use in dangerouslySetInnerHTML, href, src, or other HTML attribute positions. */
export function sanitizeOptionLabel(label: string): string {
  if (!label || typeof label !== 'string') return ''
  let result = label
  let prev: string
  do {
    prev = result
    result = result
      .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)[^>]*>/gi, '')
      .replace(/<\/?(?:script|style)\b[^>]*>?/gi, '')
      .replace(/<\/?[a-zA-Z][a-zA-Z0-9]*\b[^>]*>/g, '')
  } while (result !== prev)
  return result
    .replace(/(?:javascript|vbscript|data):/gi, '')
    .replace(/\bon(?:click|dblclick|mouse(?:down|up|over|move|out|enter|leave)|key(?:down|up|press)|load|unload|error|focus|blur|change|submit|reset|select|input|scroll|resize|drag(?:start|end|enter|leave|over|drop)?|touch(?:start|end|move|cancel)?|pointer(?:down|up|move|cancel|over|out|enter|leave)?)\s*=\s*\S*/gi, '')
    .trim()
}
