import { createHash } from "node:crypto";

const WORKSPACE_APP_URI_NAMESPACE = "ui://localspace/";

export function createWorkspaceAppResourceUri(manifestSource: string): string {
  if (!manifestSource.trim()) {
    throw new Error("Workspace app manifest must not be empty.");
  }

  const buildFingerprint = createHash("sha256")
    .update(manifestSource)
    .digest("hex")
    .slice(0, 16);
  return `${WORKSPACE_APP_URI_NAMESPACE}workspace-app-${buildFingerprint}.html`;
}
