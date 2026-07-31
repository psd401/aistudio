export type DeploymentSchemaReadinessStatus =
  | "checking"
  | "ready"
  | "failed"

export interface DeploymentSchemaReadiness {
  status: DeploymentSchemaReadinessStatus
  checkedAt?: string
  error?: string
}

type SchemaReadinessGlobal = typeof globalThis & {
  __aistudioDeploymentSchemaReadiness?: DeploymentSchemaReadiness
}

function readinessGlobal(): SchemaReadinessGlobal {
  return globalThis as SchemaReadinessGlobal
}

function defaultReadiness(): DeploymentSchemaReadiness {
  return process.env.NODE_ENV === "production"
    ? { status: "checking" }
    : { status: "ready" }
}

export function getDeploymentSchemaReadiness(): DeploymentSchemaReadiness {
  const state = readinessGlobal()
  state.__aistudioDeploymentSchemaReadiness ??= defaultReadiness()
  return state.__aistudioDeploymentSchemaReadiness
}

export function setDeploymentSchemaReadiness(
  readiness: DeploymentSchemaReadiness
): void {
  readinessGlobal().__aistudioDeploymentSchemaReadiness = readiness
}
