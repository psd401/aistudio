/**
 * Next.js resolves `server-only` as a poison-package marker. Standalone Bun
 * smoke scripts need a no-op module so they can load the same server services.
 */
import { mock } from "bun:test";

mock.module("server-only", () => ({}));
