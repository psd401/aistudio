/**
 * OAuth application and redirect URI policy.
 *
 * Registration and provider loading both use this module so a row inserted
 * outside the admin action cannot bypass the security boundary.
 *
 * Issue #1289; RFC 8252 sections 7.1-7.3.
 */

import { isIP } from "node:net"

export const OAUTH_APPLICATION_TYPES = [
  "web",
  "browser_extension",
  "native",
] as const

export type OAuthApplicationType =
  (typeof OAUTH_APPLICATION_TYPES)[number]

export function isOAuthApplicationType(
  value: unknown
): value is OAuthApplicationType {
  return (
    typeof value === "string" &&
    (OAUTH_APPLICATION_TYPES as readonly string[]).includes(value)
  )
}

export interface RedirectUriValidation {
  valid: boolean
  normalizedUris: string[]
  errors: string[]
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"])
const CHROMIUM_REDIRECT_HOST = /^[a-p]{32}\.chromiumapp\.org$/
const MAX_REDIRECT_URIS = 20
const MAX_REDIRECT_URI_LENGTH = 2048

function hasFixedPath(uri: URL): boolean {
  return uri.pathname.length > 1 && uri.pathname.startsWith("/")
}

function isAsciiLowercaseLetter(value: string): boolean {
  return value >= "a" && value <= "z"
}

function isAsciiDigit(value: string): boolean {
  return value >= "0" && value <= "9"
}

function isReverseDomainScheme(protocol: string): boolean {
  const scheme = protocol.endsWith(":") ? protocol.slice(0, -1) : protocol
  const segments = scheme.split(".")
  if (segments.length < 2) return false

  return segments.every((segment, segmentIndex) => {
    if (segment.length === 0) return false
    if (
      (segmentIndex === 0 &&
        !isAsciiLowercaseLetter(segment[0] ?? "")) ||
      (segmentIndex > 0 &&
        !isAsciiLowercaseLetter(segment[0] ?? "") &&
        !isAsciiDigit(segment[0] ?? ""))
    ) {
      return false
    }
    if (segment.endsWith("-")) return false
    return [...segment].every(
      (character) =>
        isAsciiLowercaseLetter(character) ||
        isAsciiDigit(character) ||
        character === "-"
    )
  })
}

function validateCommon(uri: string, parsed: URL): string | null {
  if (uri !== uri.trim()) return "must not have leading or trailing whitespace"
  if (uri.length > MAX_REDIRECT_URI_LENGTH) {
    return `must not exceed ${MAX_REDIRECT_URI_LENGTH} characters`
  }
  if (uri.includes("*")) return "must not contain wildcards"
  if (parsed.hash) return "must not contain a fragment"
  if (parsed.username || parsed.password) return "must not contain userinfo"
  return null
}

function validateWebUri(parsed: URL): string | null {
  if (parsed.protocol !== "https:") {
    return "web applications must use HTTPS redirect URIs"
  }
  if (!parsed.hostname) return "web redirect URIs must include a hostname"
  if (
    parsed.hostname === "localhost" ||
    LOOPBACK_HOSTS.has(parsed.hostname)
  ) {
    return "web applications must not use localhost or loopback redirect URIs"
  }
  return null
}

function validateBrowserExtensionUri(parsed: URL): string | null {
  if (parsed.protocol !== "https:") {
    return "browser extensions must use HTTPS redirect URIs"
  }
  if (!CHROMIUM_REDIRECT_HOST.test(parsed.hostname)) {
    return "browser extensions must use their exact <extension-id>.chromiumapp.org host"
  }
  if (parsed.port) return "browser extension redirect URIs must not specify a port"
  if (!hasFixedPath(parsed)) {
    return "browser extension redirect URIs must include a fixed callback path"
  }
  if (parsed.search) {
    return "browser extension redirect URIs must not include a query string"
  }
  return null
}

function validateNativeUri(parsed: URL): string | null {
  if (!hasFixedPath(parsed)) {
    return "native redirect URIs must include a fixed callback path"
  }

  if (parsed.protocol === "http:") {
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
      return "native HTTP redirect URIs must use literal 127.0.0.1 or [::1]"
    }
    return null
  }

  if (parsed.protocol === "https:") {
    const ipCandidate =
      parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
        ? parsed.hostname.slice(1, -1)
        : parsed.hostname
    if (
      !parsed.hostname ||
      parsed.hostname === "localhost" ||
      LOOPBACK_HOSTS.has(parsed.hostname) ||
      isIP(ipCandidate) !== 0
    ) {
      return "native claimed HTTPS redirect URIs must use a non-loopback DNS hostname"
    }
    if (parsed.port) {
      return "native claimed HTTPS redirect URIs must not specify a port"
    }
    return null
  }

  if (!isReverseDomainScheme(parsed.protocol)) {
    return "native private-use schemes must be reverse-domain based"
  }
  if (parsed.hostname) {
    return "native private-use redirect URIs must use a single-slash fixed path"
  }
  if (parsed.search) {
    return "native private-use redirect URIs must not include a query string"
  }
  return null
}

function validateForApplicationType(
  applicationType: OAuthApplicationType,
  parsed: URL
): string | null {
  switch (applicationType) {
    case "web":
      return validateWebUri(parsed)
    case "browser_extension":
      return validateBrowserExtensionUri(parsed)
    case "native":
      return validateNativeUri(parsed)
  }
}

export function validateOAuthRedirectUris(
  applicationType: OAuthApplicationType,
  uris: string[]
): RedirectUriValidation {
  if (uris.length === 0) {
    return {
      valid: false,
      normalizedUris: [],
      errors: ["At least one redirect URI is required"],
    }
  }
  if (uris.length > MAX_REDIRECT_URIS) {
    return {
      valid: false,
      normalizedUris: [],
      errors: [`No more than ${MAX_REDIRECT_URIS} redirect URIs are allowed`],
    }
  }

  const errors: string[] = []
  const normalizedUris: string[] = []
  const seen = new Set<string>()

  for (const uri of uris) {
    let parsed: URL
    try {
      parsed = new URL(uri)
    } catch {
      errors.push(`Invalid redirect URI: ${uri}`)
      continue
    }

    const commonError = validateCommon(uri, parsed)
    const typeError =
      commonError ?? validateForApplicationType(applicationType, parsed)
    if (typeError) {
      errors.push(`${uri}: ${typeError}`)
      continue
    }

    const normalized = parsed.href
    if (seen.has(normalized)) {
      errors.push(`${uri}: duplicate redirect URI`)
      continue
    }
    seen.add(normalized)
    normalizedUris.push(normalized)
  }

  return {
    valid: errors.length === 0,
    normalizedUris,
    errors,
  }
}

export function oidcApplicationType(
  applicationType: OAuthApplicationType
): "web" | "native" {
  return applicationType === "native" ? "native" : "web"
}

export function isPublicApplicationType(
  applicationType: OAuthApplicationType
): boolean {
  return (
    applicationType === "native" ||
    applicationType === "browser_extension"
  )
}
