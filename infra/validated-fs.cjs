"use strict";

const nodeFs = require("node:fs");
const nodeFsPromises = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { fileURLToPath } = require("node:url");
const { isAbsolute, relative, resolve } = require("node:path");

const READ_METHODS = new Set([
  "access",
  "exists",
  "existsSync",
  "lstat",
  "lstatSync",
  "open",
  "readFile",
  "readFileSync",
  "readdir",
  "readdirSync",
  "stat",
  "statSync",
]);
const WRITE_METHODS = new Set([
  "appendFile",
  "appendFileSync",
  "chmod",
  "chmodSync",
  "mkdir",
  "mkdirSync",
  "rename",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "truncate",
  "truncateSync",
  "unlink",
  "unlinkSync",
  "writeFile",
  "writeFileSync",
]);

function normalizePath(candidate) {
  if (typeof candidate === "string") return resolve(candidate);
  if (candidate instanceof URL && candidate.protocol === "file:") {
    return resolve(fileURLToPath(candidate));
  }
  if (Buffer.isBuffer(candidate)) return resolve(candidate.toString());
  if (typeof candidate === "number") return null;
  throw new TypeError("Filesystem target must be a path, file URL, or descriptor");
}

function isWithin(candidate, root) {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function validatePath(candidate, access) {
  const normalized = normalizePath(candidate);
  if (normalized === null) return;
  // The agent's own OpenClaw workspace is always in scope, not just whichever
  // directory a skill happened to be launched from.
  //
  // Skills read and write the workspace by absolute path — psd-morning-brief
  // takes --config/--data_file/--synthesis_file under ~/.openclaw — so with
  // only cwd on this list the exact same command succeeded when the process
  // was started inside the workspace and failed with "Refusing read outside
  // the working directory and temporary roots" when it was not. That is how
  // two users lost their morning brief on consecutive days with an identical
  // message and no other difference (agent_failures: hellwichj 2026-08-12,
  // yellowleesj 2026-08-13).
  //
  // This widens the guard by exactly the directory the agent already owns and
  // is expected to persist its memory in; everything outside workspace, cwd,
  // temp and /opt stays refused.
  const workspace = process.env.OPENCLAW_HOME || "/home/node/.openclaw";
  const roots = [
    resolve(process.cwd()),
    resolve(tmpdir()),
    resolve(workspace),
  ];
  if (access === "read") roots.push("/opt");
  if (!roots.some((root) => isWithin(normalized, root))) {
    throw new Error(
      `Refusing ${access} outside the working directory and temporary roots`
    );
  }
}

function validatedProxy(target, promiseApi = false) {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof property !== "string" || typeof value !== "function") {
        return value;
      }
      const access = READ_METHODS.has(property)
        ? "read"
        : WRITE_METHODS.has(property)
          ? "write"
          : null;
      if (!access) return value.bind(object);
      if (promiseApi) {
        return async (...args) => {
          validatePath(args[0], access);
          return await Reflect.apply(value, object, args);
        };
      }
      return (...args) => {
        validatePath(args[0], access);
        return Reflect.apply(value, object, args);
      };
    },
  });
}

module.exports = {
  validatedFs: validatedProxy(nodeFs),
  validatedFsPromises: validatedProxy(nodeFsPromises, true),
};
