import * as nodeFs from "node:fs";
import * as nodeFsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve } from "node:path";

type AccessKind = "read" | "write";
type FileSystemTarget = typeof nodeFs | typeof nodeFsPromises;

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

function normalizePath(candidate: unknown): string | null {
  if (typeof candidate === "string") return resolve(candidate);
  if (candidate instanceof URL && candidate.protocol === "file:") {
    return resolve(fileURLToPath(candidate));
  }
  if (Buffer.isBuffer(candidate)) return resolve(candidate.toString());
  // File descriptors are not filenames and are already capability-scoped.
  if (typeof candidate === "number") return null;
  throw new TypeError("Filesystem target must be a path, file URL, or descriptor");
}

function isWithin(candidate: string, root: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function validatePath(candidate: unknown, access: AccessKind): void {
  const normalized = normalizePath(candidate);
  if (normalized === null) return;

  const roots = [resolve(process.cwd()), resolve(tmpdir())];
  if (access === "read") roots.push("/opt");
  if (!roots.some((root) => isWithin(normalized, root))) {
    throw new Error(
      `Refusing ${access} outside the working directory and temporary roots`
    );
  }
}

function validatedProxy<T extends FileSystemTarget>(
  target: T,
  promiseApi = false
): T {
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
        return async (...args: unknown[]) => {
          validatePath(args[0], access);
          return await Reflect.apply(value, object, args);
        };
      }
      return (...args: unknown[]) => {
        validatePath(args[0], access);
        return Reflect.apply(value, object, args);
      };
    },
  });
}

/**
 * Node filesystem facades that reject dynamic paths outside the process
 * workspace (and OS temp directory). Read-only Lambda layer access under
 * `/opt` is allowed; mutations remain confined to writable roots.
 */
export const validatedFs: typeof nodeFs = validatedProxy(nodeFs);
export const validatedFsPromises: typeof nodeFsPromises =
  validatedProxy(nodeFsPromises, true);
