import { resolve } from 'node:path';
import {
  readBundledSchemaFile,
  resolveBundledSchemaPath,
} from '../../infra/database/lambda/schema-file-reader';
import { validatedFsPromises } from '@/lib/filesystem/validated-fs';

describe('database initializer schema file boundary', () => {
  let schemaDirectory: string;

  beforeEach(async () => {
    schemaDirectory = await validatedFsPromises.mkdtemp(
      '/tmp/aistudio-db-schema-'
    );
  });

  afterEach(async () => {
    await validatedFsPromises.rm(schemaDirectory, {
      force: true,
      recursive: true,
    });
  });

  it('resolves a migration basename inside the bundled schema directory', () => {
    expect(resolveBundledSchemaPath(schemaDirectory, '010-example.sql')).toBe(
      resolve(schemaDirectory, '010-example.sql')
    );
  });

  it.each([
    '',
    '..',
    '../secret.sql',
    'nested/secret.sql',
    '/tmp/secret.sql',
  ])('rejects an unsafe schema filename: %p', (filename) => {
    expect(() => resolveBundledSchemaPath(schemaDirectory, filename)).toThrow(
      'Schema filename must be a non-empty basename'
    );
  });

  it('reads only after resolving the validated bundled path', async () => {
    await validatedFsPromises.mkdir(schemaDirectory, { recursive: true });
    await validatedFsPromises.writeFile(
      resolve(schemaDirectory, '010-example.sql'),
      'SELECT 1;',
      'utf8'
    );

    await expect(
      readBundledSchemaFile(schemaDirectory, '010-example.sql')
    ).resolves.toBe('SELECT 1;');
  });
});
