import { readFile } from 'node:fs/promises';
import {
  basename,
  isAbsolute,
  relative,
  resolve,
} from 'node:path';

function isWithin(candidate: string, root: string): boolean {
  const child = relative(root, candidate);
  return child !== '' && !child.startsWith('..') && !isAbsolute(child);
}

export function resolveBundledSchemaPath(
  schemaDirectory: string,
  filename: string
): string {
  if (
    filename === '' ||
    filename === '.' ||
    filename === '..' ||
    basename(filename) !== filename
  ) {
    throw new Error('Schema filename must be a non-empty basename');
  }

  const schemaRoot = resolve(schemaDirectory);
  const schemaPath = resolve(schemaRoot, filename);
  if (!isWithin(schemaPath, schemaRoot)) {
    throw new Error('Schema file must remain inside the bundled schema directory');
  }

  return schemaPath;
}

export async function readBundledSchemaFile(
  schemaDirectory: string,
  filename: string
): Promise<string> {
  const schemaPath = resolveBundledSchemaPath(schemaDirectory, filename);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolveBundledSchemaPath rejects absolute, nested, and traversal inputs before this package-local read.
  return await readFile(schemaPath, 'utf8');
}
