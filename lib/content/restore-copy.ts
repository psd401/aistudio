/**
 * Restore-confirmation copy shared by the artifact canvas and the document
 * version menu. Restoring moves the working head, and a Live page follows its
 * head (`advanceLivePublications`) — so the confirmation must say readers see
 * the restored version immediately, not "after you publish". Dependency-free so
 * it is safe in a client bundle.
 */
export function restoreConfirmMessage(versionNumber: number): string {
  return (
    `Restore v${versionNumber} as the current version? If this page is live, ` +
    `readers will see v${versionNumber} right away (unless its section requires ` +
    `review, or the version changes what live data the page shares).`
  );
}
