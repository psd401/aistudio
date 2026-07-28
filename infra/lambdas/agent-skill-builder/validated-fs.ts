/**
 * Package-local filesystem boundary for the independently bundled skill
 * builder Lambda. The CDK asset contains only this directory, so runtime
 * helpers must remain inside the package rather than import repository code.
 */
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve } from "node:path";

type AccessKind = "read" | "write";

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
  if (typeof candidate === "number") return null;
  throw new TypeError("Filesystem target must be a path, file URL, or descriptor");
}

function isWithin(candidate: string, root: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function allowedRoots(access: AccessKind): string[] {
  const tempRoot = resolve(tmpdir());
  const roots = [resolve(process.cwd()), tempRoot, "/tmp", "/private/tmp"];
  if (tempRoot === "/tmp" || tempRoot.startsWith("/var/")) {
    roots.push(`/private${tempRoot}`);
  }
  if (access === "read") roots.push("/opt");
  return roots;
}

function validatePath(candidate: unknown, access: AccessKind): void {
  const normalized = normalizePath(candidate);
  if (normalized === null) return;

  if (!allowedRoots(access).some((root) => isWithin(normalized, root))) {
    throw new Error(
      `Refusing ${access} outside the working directory and temporary roots`,
    );
  }
}

function validatedProxy(target: typeof nodeFs): typeof nodeFs {
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

      return (...args: unknown[]) => {
        validatePath(args[0], access);
        return Reflect.apply(value, object, args);
      };
    },
  });
}

export const validatedFs: typeof nodeFs = validatedProxy(nodeFs);
