export interface GoogleContentOAuthState {
  state: string;
  codeVerifier: string;
  repositoryId: number;
  userId: number;
  createdAt: number;
}

export function googleContentOAuthStateCookieName(
  repositoryId: number,
): string {
  return `google_content_oauth_state_${repositoryId}`;
}
