/**
 * Build the account-provisioning request body.
 *
 * Owner identity is carried only by the signed invocation context. Keeping the
 * body selector-free prevents the router from reintroducing a confused-deputy
 * input that the application route intentionally rejects.
 */
export function buildAccountRequestBody(): string {
  return JSON.stringify({});
}
