/** S3 key allowlist for the legacy repository file processor. */

const REPOSITORY_KEY =
  /^repositories\/\d+\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[^/]+$/i;
const LEGACY_USER_KEY = /^\d+\/\d+-[\w.-]+$/;

export function validateRepositoryProcessingKey(key: string): boolean {
  if (key.includes("../") || key.includes("..\\") || key.startsWith("/")) {
    return false;
  }
  return REPOSITORY_KEY.test(key) || LEGACY_USER_KEY.test(key);
}
