import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const OPENCLAW_DIST = "/app/dist";
const OPENCLAW_HOME = "/home/node/.openclaw";
const exportName = "migrateOpenClawAgentDatabaseForMaintenance";

const moduleNames = (await readdir(OPENCLAW_DIST))
  .filter((name) => /^openclaw-agent-db-.*\.js$/u.test(name))
  .sort();

let migrate;
for (const moduleName of moduleNames) {
  const moduleUrl = pathToFileURL(path.join(OPENCLAW_DIST, moduleName)).href;
  const candidate = await import(moduleUrl);
  if (typeof candidate[exportName] === "function") {
    migrate = candidate[exportName];
    break;
  }
}

if (typeof migrate !== "function") {
  throw new TypeError(
    `Pinned OpenClaw host does not export ${exportName}`,
  );
}

const agentsDirectory = path.join(OPENCLAW_HOME, "agents");
let agentIds = [];
try {
  agentIds = (await readdir(agentsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw error;
  }
}

let migrated = 0;
for (const agentId of agentIds) {
  const pathname = path.join(
    agentsDirectory,
    agentId,
    "agent",
    "openclaw-agent.sqlite",
  );
  try {
    // agentId is a directory entry read from the fixed OpenClaw agents root.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const metadata = await stat(pathname);
    if (!metadata.isFile()) {
      continue;
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      continue;
    }
    throw error;
  }
  await migrate({ agentId, pathname });
  migrated += 1;
}

process.stdout.write(
  `${JSON.stringify({ migratedAgentDatabases: migrated })}\n`,
);
