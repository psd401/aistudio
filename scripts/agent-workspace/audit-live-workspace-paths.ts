import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  DynamoDBClient,
  ScanCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb"
import {
  paginateListObjectsV2,
  S3Client,
} from "@aws-sdk/client-s3"
import {
  isCheckpointManagedWorkspacePath,
  workspaceRelativePathRejectionReason,
  type WorkspacePathRejectionReason,
} from "@/lib/agent-workspace/path-policy"
import {
  workspaceGenerationFromEntries,
  type WorkspaceGenerationEntry,
} from "@/lib/agent-workspace/storage-broker"

type AuditOptions = {
  bucket: string
  environment: string
  region: string
}

type PathFailure = {
  ownerHash: string
  pathHash: string
  reason: WorkspacePathRejectionReason
}

type WorkspaceAudit = {
  ownerHash: string
  objects: number
  checkpointManagedObjects: number
  excludedObjects: number
  maxPathBytes: number
  maxDepth: number
  failures: PathFailure[]
  conflicts: Array<{ ownerHash: string; pathHash: string }>
  entries: Array<
    WorkspaceGenerationEntry & {
      expectedReason: WorkspacePathRejectionReason | null
      expectedManaged: boolean
    }
  >
}

type PythonParityResult = {
  classificationMismatches: string[]
  generationMismatches: string[]
}

type CheckpointControlAudit = {
  objects: number
  currentVersionObjects: number
  legacyV1ObjectHashes: string[]
  unknownObjectHashes: string[]
}

function parseArgs(argv: readonly string[]): AuditOptions {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(
        "Usage: audit-live-workspace-paths.ts --bucket <name> --environment <name> [--region <region>]",
      )
    }
    values.set(flag, value)
  }
  const bucket = values.get("--bucket")
  const environment = values.get("--environment")
  const region = values.get("--region") ?? process.env.AWS_REGION ?? "us-east-1"
  if (!bucket || !environment) {
    throw new Error("Both --bucket and --environment are required")
  }
  return { bucket, environment, region }
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16)
}

function workspacePrefixFromItem(
  item: Record<string, AttributeValue>,
): string | null {
  const value = item.workspacePrefix
  return value && "S" in value && typeof value.S === "string" && value.S
    ? value.S
    : null
}

async function registeredWorkspacePrefixes(
  environment: string,
  region: string,
): Promise<string[]> {
  const client = new DynamoDBClient({ region })
  const tableName = `psd-agent-users-${environment}`
  const prefixes = new Set<string>()
  let exclusiveStartKey: Record<string, AttributeValue> | undefined
  do {
    const page = await client.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: "workspacePrefix",
        ExclusiveStartKey: exclusiveStartKey,
      }),
    )
    for (const item of page.Items ?? []) {
      const prefix = workspacePrefixFromItem(item)
      if (prefix) prefixes.add(prefix)
    }
    exclusiveStartKey = page.LastEvaluatedKey
  } while (exclusiveStartKey)
  if (prefixes.size === 0) {
    throw new Error(`No registered workspace prefixes found in ${tableName}`)
  }
  return [...prefixes].sort()
}

function findPrefixConflict(paths: ReadonlySet<string>): string | null {
  for (const path of paths) {
    const segments = path.split("/")
    for (let index = 1; index < segments.length; index += 1) {
      if (paths.has(segments.slice(0, index).join("/"))) return path
    }
  }
  return null
}

async function auditCheckpointControlNamespace(
  client: S3Client,
  bucket: string,
): Promise<CheckpointControlAudit> {
  const prefix = ".workspace-checkpoints/"
  let objects = 0
  let currentVersionObjects = 0
  const legacyV1ObjectHashes: string[] = []
  const unknownObjectHashes: string[] = []
  for await (const page of paginateListObjectsV2(
    { client, pageSize: 1_000 },
    { Bucket: bucket, Prefix: prefix },
  )) {
    for (const object of page.Contents ?? []) {
      const key = object.Key
      if (!key?.startsWith(prefix)) continue
      objects += 1
      if (key.startsWith(`${prefix}v2/`)) {
        currentVersionObjects += 1
      } else if (key.startsWith(`${prefix}v1/`)) {
        legacyV1ObjectHashes.push(shortHash(key))
      } else {
        unknownObjectHashes.push(shortHash(key))
      }
    }
  }
  return {
    objects,
    currentVersionObjects,
    legacyV1ObjectHashes,
    unknownObjectHashes,
  }
}

async function auditWorkspace(
  client: S3Client,
  bucket: string,
  workspacePrefix: string,
): Promise<WorkspaceAudit> {
  const paths = new Set<string>()
  const entries = new Map<string, WorkspaceAudit["entries"][number]>()
  const failures: PathFailure[] = []
  const ownerHash = shortHash(workspacePrefix)
  let checkpointManagedObjects = 0
  let excludedObjects = 0
  let maxPathBytes = 0
  let maxDepth = 0
  for await (const page of paginateListObjectsV2(
    { client, pageSize: 1_000 },
    { Bucket: bucket, Prefix: `${workspacePrefix}/` },
  )) {
    for (const object of page.Contents ?? []) {
      if (!object.Key?.startsWith(`${workspacePrefix}/`)) continue
      const relativePath = object.Key.slice(workspacePrefix.length + 1)
      if (!relativePath) continue
      paths.add(relativePath)
      maxPathBytes = Math.max(
        maxPathBytes,
        Buffer.byteLength(relativePath, "utf8"),
      )
      maxDepth = Math.max(maxDepth, relativePath.split("/").length)
      const expectedReason = workspaceRelativePathRejectionReason(relativePath)
      const expectedManaged = isCheckpointManagedWorkspacePath(relativePath)
      entries.set(relativePath, {
        path: relativePath,
        size: object.Size ?? 0,
        eTag: object.ETag ?? "",
        expectedReason,
        expectedManaged,
      })
      if (expectedManaged) {
        checkpointManagedObjects += 1
        if (expectedReason) {
          failures.push({
            ownerHash,
            pathHash: shortHash(relativePath),
            reason: expectedReason,
          })
        }
      } else {
        excludedObjects += 1
      }
    }
  }
  const conflict = findPrefixConflict(paths)
  return {
    ownerHash,
    objects: paths.size,
    checkpointManagedObjects,
    excludedObjects,
    maxPathBytes,
    maxDepth,
    failures,
    conflicts: conflict
      ? [{ ownerHash, pathHash: shortHash(conflict) }]
      : [],
    entries: [...entries.values()],
  }
}

function parsePythonParityResult(output: string): PythonParityResult {
  const parsed: unknown = JSON.parse(output)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Python workspace policy probe returned invalid output")
  }
  const candidate = parsed as Record<string, unknown>
  const classificationMismatches = candidate.classificationMismatches
  const generationMismatches = candidate.generationMismatches
  if (
    !Array.isArray(classificationMismatches) ||
    !classificationMismatches.every((value) => typeof value === "string") ||
    !Array.isArray(generationMismatches) ||
    !generationMismatches.every((value) => typeof value === "string")
  ) {
    throw new Error("Python workspace policy probe returned invalid output")
  }
  return { classificationMismatches, generationMismatches }
}

function verifyPythonRuntimeParity(
  audits: readonly WorkspaceAudit[],
): PythonParityResult {
  const probePath = fileURLToPath(
    new URL("./workspace-policy-probe.py", import.meta.url),
  )
  const workspaces = audits.map((audit) => ({
    ownerHash: audit.ownerHash,
    expectedGeneration: workspaceGenerationFromEntries(audit.entries),
    entries: audit.entries,
  }))
  const result = spawnSync(
    process.env.PYTHON ?? "python3",
    [probePath],
    {
      input: JSON.stringify({ workspaces }),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  )
  if (result.error || result.status !== 0) {
    throw new Error("Python workspace policy probe failed")
  }
  return parsePythonParityResult(result.stdout)
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = Array.from({ length: values.length }) as U[]
  let nextIndex = 0
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (true) {
        const index = nextIndex
        nextIndex += 1
        if (index >= values.length) return
        results[index] = await operation(values[index]!)
      }
    },
  )
  await Promise.all(workers)
  return results
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const prefixes = await registeredWorkspacePrefixes(
    options.environment,
    options.region,
  )
  const client = new S3Client({ region: options.region })
  const [controlAudit, audits] = await Promise.all([
    auditCheckpointControlNamespace(client, options.bucket),
    mapWithConcurrency(prefixes, 8, (prefix) =>
      auditWorkspace(client, options.bucket, prefix),
    ),
  ])
  const populated = audits.filter((audit) => audit.objects > 0)
  const failures = audits.flatMap((audit) => audit.failures)
  const conflicts = audits.flatMap((audit) => audit.conflicts)
  const parity =
    failures.length === 0 && conflicts.length === 0
      ? verifyPythonRuntimeParity(audits)
      : {
          classificationMismatches: [],
          generationMismatches: [],
        }
  const summary = {
    environment: options.environment,
    registeredWorkspaces: prefixes.length,
    populatedWorkspaces: populated.length,
    objects: audits.reduce((sum, audit) => sum + audit.objects, 0),
    checkpointManagedObjects: audits.reduce(
      (sum, audit) => sum + audit.checkpointManagedObjects,
      0,
    ),
    excludedObjects: audits.reduce(
      (sum, audit) => sum + audit.excludedObjects,
      0,
    ),
    largestWorkspaceObjects: Math.max(
      0,
      ...audits.map((audit) => audit.objects),
    ),
    largestWorkspaceCheckpointObjects: Math.max(
      0,
      ...audits.map((audit) => audit.checkpointManagedObjects),
    ),
    maxPathBytes: Math.max(0, ...audits.map((audit) => audit.maxPathBytes)),
    maxDepth: Math.max(0, ...audits.map((audit) => audit.maxDepth)),
    checkpointControlObjects: controlAudit.objects,
    currentV2CheckpointControlObjects: controlAudit.currentVersionObjects,
    legacyV1CheckpointObjectHashes: controlAudit.legacyV1ObjectHashes,
    unknownCheckpointObjectHashes: controlAudit.unknownObjectHashes,
    incompatiblePaths: failures,
    fileDescendantConflicts: conflicts,
    pythonClassificationMismatches: parity.classificationMismatches,
    pythonGenerationMismatches: parity.generationMismatches,
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  if (
    failures.length > 0 ||
    conflicts.length > 0 ||
    parity.classificationMismatches.length > 0 ||
    parity.generationMismatches.length > 0 ||
    controlAudit.legacyV1ObjectHashes.length > 0 ||
    controlAudit.unknownObjectHashes.length > 0
  ) {
    process.exitCode = 1
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Workspace compatibility audit failed: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exitCode = 1
})
