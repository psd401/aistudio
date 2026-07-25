export interface GoogleContentOAuthState {
  state: string;
  codeVerifier: string;
  repositoryId: number;
  userId: number;
  createdAt: number;
}

export const GOOGLE_CONTENT_OAUTH_STATE_COOKIE_PREFIX =
  "google_content_oauth_state_";

export function googleContentOAuthStateCookieName(
  repositoryId: number,
): string {
  return `${GOOGLE_CONTENT_OAUTH_STATE_COOKIE_PREFIX}${repositoryId}`;
}
