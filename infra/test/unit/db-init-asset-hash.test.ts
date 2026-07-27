import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeDbInitAssetHash } from '../../lib/database-stack';

/**
 * The db-init Lambda uses assetHashType CUSTOM, which fully replaces CDK's
 * default source hash. Any bundling input missing from the custom hash can
 * change without the Lambda asset being rebuilt or redeployed — a handler-only
 * fix would then silently never reach deployed environments. These tests pin
 * the full input surface of the hash.
 */
describe('computeDbInitAssetHash', () => {
  let databaseDir: string;

  const write = (rel: string, content: string) => {
    const abs = path.join(databaseDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };

  beforeEach(() => {
    databaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-init-hash-'));
    write('lambda/db-init-handler.ts', 'export const handler = () => 1;');
    write('lambda/index.ts', "export { handler } from './db-init-handler';");
    write('lambda/package.json', '{"name":"db-init-lambda"}');
    write('lambda/tsconfig.json', '{"compilerOptions":{}}');
    write('migrations.json', '{"migrationFiles":["010-example.sql"]}');
    write('schema/001-initial.sql', 'CREATE TABLE users (id SERIAL);');
  });

  afterEach(() => {
    fs.rmSync(databaseDir, { recursive: true, force: true });
  });

  it('is deterministic for identical inputs', () => {
    const first = computeDbInitAssetHash(databaseDir);
    const second = computeDbInitAssetHash(databaseDir);
    expect(second).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes when the Lambda handler source changes', () => {
    const before = computeDbInitAssetHash(databaseDir);
    write('lambda/db-init-handler.ts', 'export const handler = () => 2;');
    expect(computeDbInitAssetHash(databaseDir)).not.toBe(before);
  });

  it('changes when a new Lambda source file is added', () => {
    const before = computeDbInitAssetHash(databaseDir);
    write('lambda/helpers.ts', 'export const helper = true;');
    expect(computeDbInitAssetHash(databaseDir)).not.toBe(before);
  });

  it('changes when the Lambda package.json changes', () => {
    const before = computeDbInitAssetHash(databaseDir);
    write('lambda/package.json', '{"name":"db-init-lambda","version":"2.0.0"}');
    expect(computeDbInitAssetHash(databaseDir)).not.toBe(before);
  });

  it('changes when the Lambda tsconfig.json changes', () => {
    const before = computeDbInitAssetHash(databaseDir);
    write('lambda/tsconfig.json', '{"compilerOptions":{"target":"ES2022"}}');
    expect(computeDbInitAssetHash(databaseDir)).not.toBe(before);
  });

  it('changes when migrations.json changes', () => {
    const before = computeDbInitAssetHash(databaseDir);
    write('migrations.json', '{"migrationFiles":["010-example.sql","011-next.sql"]}');
    expect(computeDbInitAssetHash(databaseDir)).not.toBe(before);
  });

  it('changes when a schema file changes', () => {
    const before = computeDbInitAssetHash(databaseDir);
    write('schema/001-initial.sql', 'CREATE TABLE users (id SERIAL, email TEXT);');
    expect(computeDbInitAssetHash(databaseDir)).not.toBe(before);
  });

  it('changes when a schema file is added', () => {
    const before = computeDbInitAssetHash(databaseDir);
    write('schema/010-example.sql', 'ALTER TABLE users ADD COLUMN name TEXT;');
    expect(computeDbInitAssetHash(databaseDir)).not.toBe(before);
  });

  it('ignores generated artifacts and local install state', () => {
    const before = computeDbInitAssetHash(databaseDir);
    write('lambda/db-init-handler.js', '"use strict"; // compiled twin');
    write('lambda/db-init-handler.d.ts', 'export declare const handler: () => number;');
    write('lambda/bun.lock', '{}');
    write('lambda/node_modules/some-dep/index.js', 'module.exports = {};');
    write('lambda/dist/db-init-handler.js', '"use strict";');
    expect(computeDbInitAssetHash(databaseDir)).toBe(before);
  });
});
