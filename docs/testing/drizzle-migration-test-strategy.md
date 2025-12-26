# Test Strategy: Drizzle-Kit Integration (Issue #539)

## Overview

Test strategy for integrating drizzle-kit migration generation with the existing Lambda-based migration system. Focus on testing helper scripts, drizzle config validation, and npm script workflows - NOT the Lambda handler itself (already covered).

## System Analysis

### Current Migration System
- **Migration tracking**: `migration_log` table tracks execution history
- **Migration files**: Array-based (MIGRATION_FILES in db-init-handler.js)
- **Immutable files**: 001-005 (initial setup)
- **Active migrations**: 010+ (numbered, must be added to MIGRATION_FILES array)
- **Lambda constraints**:
  - No CONCURRENTLY support (incompatible with RDS Data API)
  - Statement-level execution (no multi-transaction operations)
  - Validation checks before execution

### Integration Points
1. **Schema source**: Drizzle schema in `/lib/db/schema/` (54 table files)
2. **Migration output**: `drizzle/migrations/` directory
3. **Target format**: Lambda-compatible SQL (no CONCURRENTLY, IF NOT EXISTS preferred)
4. **Numbering**: Next available number (currently 043)
5. **Registration**: Manual addition to MIGRATION_FILES array

## Test Coverage Map

### Unit Tests (60-70% of effort)

#### 1. Migration Numbering Logic
**File**: `scripts/drizzle-helpers/get-next-migration-number.test.ts`

```typescript
describe('getNextMigrationNumber', () => {
  // Test data setup
  beforeEach(() => {
    // Mock fs.readFileSync for MIGRATION_FILES
    // Mock fs.readdirSync for schema directory
  });

  describe('MIGRATION_FILES array parsing', () => {
    it('should extract highest number from array', () => {
      // Given: MIGRATION_FILES with 042 as highest
      // When: getNextMigrationNumber()
      // Then: returns 043
    });

    it('should handle non-sequential numbers', () => {
      // Given: [010, 011, 015, 042] (missing 012-014)
      // Then: returns 043 (highest + 1)
    });

    it('should handle legacy format (11_textract)', () => {
      // Given: Mix of 010-style and 11_style
      // Then: correctly identifies highest number
    });
  });

  describe('Schema directory validation', () => {
    it('should skip rollback files', () => {
      // Given: 028-nexus-schema.sql and 028-nexus-schema-rollback.sql
      // Then: only counts 028 once
    });

    it('should skip test data directory', () => {
      // Given: Files in test-data/ subfolder
      // Then: excludes them from numbering
    });
  });

  describe('Error handling', () => {
    it('should error if MIGRATION_FILES not found', () => {
      // Given: db-init-handler.js missing or corrupt
      // Then: throws descriptive error
    });

    it('should error if schema directory missing', () => {
      // Given: /infra/database/schema/ does not exist
      // Then: throws descriptive error
    });
  });

  describe('Edge cases', () => {
    it('should handle empty MIGRATION_FILES', () => {
      // Given: const MIGRATION_FILES = []
      // Then: returns 010 (first migration number)
    });

    it('should pad numbers correctly', () => {
      // Given: Current highest is 099
      // Then: returns '100' (no padding after 3 digits)
    });
  });
});
```

**Coverage Goals**: >90% branch coverage, all edge cases

---

#### 2. SQL Validation (CONCURRENTLY Detection)
**File**: `scripts/drizzle-helpers/validate-sql.test.ts`

```typescript
describe('validateDrizzleSQL', () => {
  describe('CONCURRENTLY detection', () => {
    it('should detect CREATE INDEX CONCURRENTLY', () => {
      const sql = 'CREATE INDEX CONCURRENTLY idx_name ON table (col);';
      expect(() => validateDrizzleSQL(sql)).toThrow(/CONCURRENTLY.*incompatible/i);
    });

    it('should detect DROP INDEX CONCURRENTLY', () => {
      const sql = 'DROP INDEX CONCURRENTLY idx_name;';
      expect(() => validateDrizzleSQL(sql)).toThrow(/CONCURRENTLY/i);
    });

    it('should detect REINDEX CONCURRENTLY', () => {
      const sql = 'REINDEX INDEX CONCURRENTLY idx_name;';
      expect(() => validateDrizzleSQL(sql)).toThrow(/CONCURRENTLY/i);
    });

    it('should ignore CONCURRENTLY in comments', () => {
      const sql = `
        -- NOTE: Do NOT use CONCURRENTLY with Lambda
        CREATE INDEX IF NOT EXISTS idx_name ON table (col);
      `;
      expect(() => validateDrizzleSQL(sql)).not.toThrow();
    });

    it('should ignore CONCURRENTLY in string literals', () => {
      const sql = `INSERT INTO docs VALUES ('Use CONCURRENTLY for zero-downtime');`;
      expect(() => validateDrizzleSQL(sql)).not.toThrow();
    });

    it('should be case-insensitive', () => {
      const sql = 'create index concurrently idx_name on table (col);';
      expect(() => validateDrizzleSQL(sql)).toThrow(/CONCURRENTLY/i);
    });
  });

  describe('Lambda-compatible patterns', () => {
    it('should accept CREATE INDEX IF NOT EXISTS', () => {
      const sql = 'CREATE INDEX IF NOT EXISTS idx_name ON table (col);';
      expect(() => validateDrizzleSQL(sql)).not.toThrow();
    });

    it('should accept CREATE TABLE IF NOT EXISTS', () => {
      const sql = 'CREATE TABLE IF NOT EXISTS tbl (id SERIAL PRIMARY KEY);';
      expect(() => validateDrizzleSQL(sql)).not.toThrow();
    });

    it('should accept ALTER TABLE ADD COLUMN IF NOT EXISTS', () => {
      const sql = 'ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;';
      expect(() => validateDrizzleSQL(sql)).not.toThrow();
    });
  });

  describe('Multi-statement SQL', () => {
    it('should validate all statements', () => {
      const sql = `
        CREATE TABLE test (id SERIAL);
        CREATE INDEX CONCURRENTLY idx_test ON test (id);
        INSERT INTO test VALUES (1);
      `;
      expect(() => validateDrizzleSQL(sql)).toThrow(/statement 2.*CONCURRENTLY/i);
    });

    it('should report line numbers in errors', () => {
      const sql = `
        CREATE TABLE test (id SERIAL);
        CREATE INDEX CONCURRENTLY idx_test ON test (id);
      `;
      expect(() => validateDrizzleSQL(sql)).toThrow(/line 3/i);
    });
  });

  describe('Drizzle-generated patterns', () => {
    it('should validate actual drizzle-kit output', async () => {
      // Load real drizzle-generated SQL from test fixture
      const sql = await fs.readFile('fixtures/drizzle-generated.sql', 'utf-8');
      expect(() => validateDrizzleSQL(sql)).not.toThrow();
    });
  });
});
```

**Coverage Goals**: >95% (critical validation logic)

---

#### 3. Migration File Formatter
**File**: `scripts/drizzle-helpers/format-migration.test.ts`

```typescript
describe('formatMigrationFile', () => {
  describe('Header generation', () => {
    it('should add migration number and description', () => {
      const sql = 'CREATE TABLE test (id SERIAL);';
      const result = formatMigrationFile(sql, 43, 'Add test table');

      expect(result).toContain('-- Migration 043: Add test table');
      expect(result).toContain('-- Generated by drizzle-kit on');
      expect(result).toContain(new Date().toISOString().split('T')[0]);
    });

    it('should add rollback procedure', () => {
      const sql = 'ALTER TABLE users ADD COLUMN email TEXT;';
      const result = formatMigrationFile(sql, 43, 'Add email column');

      expect(result).toContain('-- ROLLBACK PROCEDURE');
      expect(result).toContain('ALTER TABLE users DROP COLUMN email;');
    });

    it('should add IF NOT EXISTS recommendations', () => {
      const sql = 'CREATE INDEX idx_name ON table (col);';
      const result = formatMigrationFile(sql, 43, 'Add index');

      expect(result).toContain('NOTE:');
      expect(result).toContain('IF NOT EXISTS');
    });
  });

  describe('SQL preservation', () => {
    it('should preserve original SQL exactly', () => {
      const sql = `
        CREATE TABLE complex (
          id SERIAL PRIMARY KEY,
          data JSONB NOT NULL
        );
        CREATE INDEX idx_data ON complex USING GIN (data);
      `;
      const result = formatMigrationFile(sql, 43, 'Complex migration');

      expect(result).toContain(sql.trim());
    });

    it('should preserve comments in original SQL', () => {
      const sql = '-- This is important\nCREATE TABLE test (id SERIAL);';
      const result = formatMigrationFile(sql, 43, 'Test');

      expect(result).toContain('-- This is important');
    });
  });

  describe('Filename generation', () => {
    it('should generate numbered filename', () => {
      const filename = generateFilename(43, 'Add test table');
      expect(filename).toBe('043-add-test-table.sql');
    });

    it('should sanitize description for filename', () => {
      const filename = generateFilename(43, 'Add "user" table & indexes!');
      expect(filename).toBe('043-add-user-table-indexes.sql');
    });

    it('should handle long descriptions', () => {
      const desc = 'Add very long description that exceeds reasonable length';
      const filename = generateFilename(43, desc);
      expect(filename.length).toBeLessThan(100);
    });
  });
});
```

**Coverage Goals**: >85%, validate formatting consistency

---

### Integration Tests (20-30% of effort)

#### 4. Drizzle-Kit Generate Workflow
**File**: `scripts/drizzle-helpers/__tests__/integration.test.ts`

```typescript
describe('drizzle-kit generate integration', () => {
  let testDbArn: string;
  let testSecretArn: string;
  let tempDir: string;

  beforeAll(async () => {
    // Setup test database with RDS Data API
    testDbArn = process.env.TEST_RDS_RESOURCE_ARN!;
    testSecretArn = process.env.TEST_RDS_SECRET_ARN!;
    tempDir = await fs.mkdtemp('/tmp/drizzle-test-');
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true });
  });

  describe('Schema change detection', () => {
    it('should detect new table addition', async () => {
      // Given: Add new table to schema/tables/test-table.ts
      const newTable = `
        export const testTable = pgTable('test_table', {
          id: serial('id').primaryKey(),
          name: text('name').notNull(),
        });
      `;
      await fs.writeFile(`${tempDir}/test-table.ts`, newTable);

      // When: Run drizzle-kit generate
      const { stdout } = await execAsync('npm run drizzle:generate');

      // Then: Migration file created
      expect(stdout).toContain('Migration generated');
      const migrations = await fs.readdir('drizzle/migrations');
      expect(migrations.length).toBeGreaterThan(0);
    });

    it('should detect column addition', async () => {
      // Given: Add column to existing table
      // When: Generate migration
      // Then: SQL contains ALTER TABLE ADD COLUMN
    });

    it('should detect index addition', async () => {
      // Given: Add index to existing table
      // When: Generate migration
      // Then: SQL contains CREATE INDEX
    });
  });

  describe('Generated SQL validation', () => {
    it('should generate Lambda-compatible SQL', async () => {
      // Given: Schema change that requires index
      // When: Generate migration
      const migrationFile = await getLatestMigration();
      const sql = await fs.readFile(migrationFile, 'utf-8');

      // Then: No CONCURRENTLY keyword
      expect(sql).not.toMatch(/\bCONCURRENTLY\b/i);
    });

    it('should use IF NOT EXISTS for idempotency', async () => {
      // Given: Schema with new table
      // When: Generate migration
      const sql = await getLatestMigrationSQL();

      // Then: Contains IF NOT EXISTS
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS/i);
    });

    it('should split into valid statements', async () => {
      // Given: Complex migration with multiple operations
      // When: Generate migration
      const sql = await getLatestMigrationSQL();
      const statements = splitSqlStatements(sql);

      // Then: Each statement is valid SQL
      for (const stmt of statements) {
        expect(() => validateSQL(stmt)).not.toThrow();
      }
    });
  });

  describe('Migration file structure', () => {
    it('should create snapshot.json metadata', async () => {
      await execAsync('npm run drizzle:generate');

      const snapshot = await fs.readFile('drizzle/migrations/meta/_journal.json');
      const data = JSON.parse(snapshot);

      expect(data.version).toBeDefined();
      expect(data.dialect).toBe('postgresql');
    });

    it('should create .sql file with statements', async () => {
      await execAsync('npm run drizzle:generate');

      const migrations = await fs.readdir('drizzle/migrations');
      const sqlFiles = migrations.filter(f => f.endsWith('.sql'));

      expect(sqlFiles.length).toBeGreaterThan(0);
    });
  });

  describe('Error handling', () => {
    it('should error on missing RDS credentials', async () => {
      delete process.env.RDS_RESOURCE_ARN;

      await expect(execAsync('npm run drizzle:generate'))
        .rejects.toThrow(/RDS_RESOURCE_ARN/);
    });

    it('should error on invalid schema syntax', async () => {
      // Given: Schema with TypeScript error
      const badSchema = 'export const bad = pgTable("bad", { invalid syntax });';
      await fs.writeFile('lib/db/schema/tables/bad.ts', badSchema);

      // When/Then: Generate fails with clear error
      await expect(execAsync('npm run drizzle:generate'))
        .rejects.toThrow(/syntax error/i);
    });

    it('should error if database unreachable', async () => {
      process.env.RDS_RESOURCE_ARN = 'arn:aws:rds:us-east-1:123:cluster:fake';

      await expect(execAsync('npm run drizzle:generate'))
        .rejects.toThrow(/connection/i);
    });
  });
});
```

**Coverage Goals**: >80%, focus on real drizzle-kit behavior

---

### E2E Tests (5-10% of effort)

#### 5. Full Migration Workflow Test
**File**: `scripts/drizzle-helpers/__tests__/e2e-workflow.test.ts`

```typescript
describe('Complete drizzle-kit to Lambda workflow', () => {
  let originalMigrationFiles: string[];

  beforeAll(async () => {
    // Backup current MIGRATION_FILES array
    originalMigrationFiles = await readMigrationFiles();
  });

  afterAll(async () => {
    // Restore original state
    await restoreMigrationFiles(originalMigrationFiles);
  });

  it('should complete full workflow: generate → validate → number → register', async () => {
    // 1. GENERATE: Create schema change and generate migration
    const testTable = `
      export const e2eTest = pgTable('e2e_test', {
        id: serial('id').primaryKey(),
        created: timestamp('created').defaultNow(),
      });
    `;
    await fs.writeFile('lib/db/schema/tables/e2e-test.ts', testTable);
    await execAsync('npm run drizzle:generate');

    // 2. VALIDATE: Check generated SQL is Lambda-compatible
    const drizzleSQL = await getLatestDrizzleMigration();
    expect(() => validateDrizzleSQL(drizzleSQL)).not.toThrow();
    expect(drizzleSQL).not.toMatch(/CONCURRENTLY/i);

    // 3. NUMBER: Get next migration number
    const nextNum = await getNextMigrationNumber();
    expect(nextNum).toBe(43); // Assuming current is 042

    // 4. FORMAT: Format with proper header
    const formatted = formatMigrationFile(drizzleSQL, nextNum, 'Add e2e test table');
    const filename = `043-add-e2e-test-table.sql`;

    // 5. COPY: Move to schema directory
    await fs.writeFile(`infra/database/schema/${filename}`, formatted);

    // 6. REGISTER: Add to MIGRATION_FILES array
    await addToMigrationFiles(filename);

    // 7. VERIFY: Confirm registration
    const updated = await readMigrationFiles();
    expect(updated).toContain(filename);

    // 8. EXECUTE: Run Lambda migration (simulated)
    const lambda = new LambdaMigrationRunner();
    const result = await lambda.runMigration(filename);
    expect(result.status).toBe('SUCCESS');

    // 9. VERIFY DB: Confirm table exists
    const tableExists = await checkTableExists('e2e_test');
    expect(tableExists).toBe(true);

    // 10. VERIFY TRACKING: Confirm migration logged
    const logged = await checkMigrationLogged(filename);
    expect(logged).toBe(true);
  });

  it('should handle migration failure and rollback', async () => {
    // Given: Schema change that will fail (duplicate column, etc)
    // When: Run workflow
    // Then: Error reported, migration_log shows failure, no partial changes
  });

  it('should prevent duplicate migration numbers', async () => {
    // Given: Migration 043 already exists
    // When: Try to create another 043
    // Then: Error thrown with helpful message
  });
});
```

**Coverage Goals**: >75%, focus on real workflow steps

---

## Test Data & Fixtures

### Required Test Fixtures

1. **Valid Drizzle Output** (`fixtures/drizzle-valid.sql`)
```sql
CREATE TABLE IF NOT EXISTS "test_table" (
  "id" SERIAL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "created_at" TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_test_name" ON "test_table" ("name");
```

2. **Invalid Drizzle Output** (`fixtures/drizzle-invalid.sql`)
```sql
CREATE TABLE "test_table" (
  "id" SERIAL PRIMARY KEY
);

CREATE INDEX CONCURRENTLY "idx_test_id" ON "test_table" ("id");
```

3. **Complex Migration** (`fixtures/drizzle-complex.sql`)
```sql
-- Multiple operations
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE (email);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
```

4. **Mock MIGRATION_FILES** (`fixtures/mock-db-init-handler.js`)
```javascript
const MIGRATION_FILES = [
  '010-knowledge-repositories.sql',
  '011_textract_jobs.sql',
  '042-ai-streaming-jobs-pending-index.sql'
];
```

---

## CI/CD Integration

### GitHub Actions Workflow

```yaml
name: Drizzle Migration Tests

on:
  pull_request:
    paths:
      - 'lib/db/schema/**'
      - 'scripts/drizzle-helpers/**'
      - 'drizzle.config.ts'

jobs:
  test-drizzle-helpers:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 20
          cache: npm

      - run: npm ci

      # Unit tests
      - run: npm run test:drizzle:unit

      # Integration tests (requires test DB)
      - run: npm run test:drizzle:integration
        env:
          RDS_RESOURCE_ARN: ${{ secrets.TEST_RDS_ARN }}
          RDS_SECRET_ARN: ${{ secrets.TEST_SECRET_ARN }}
          RDS_DATABASE_NAME: aistudio_test

      # E2E workflow test
      - run: npm run test:drizzle:e2e

      # Coverage check
      - run: npx jest --coverage --testMatch='**/drizzle-helpers/**/*.test.ts'
        env:
          COVERAGE_THRESHOLD: 80
```

### Package.json Scripts

```json
{
  "scripts": {
    "test:drizzle:unit": "jest scripts/drizzle-helpers --testPathIgnorePatterns=integration,e2e",
    "test:drizzle:integration": "jest scripts/drizzle-helpers/__tests__/integration.test.ts",
    "test:drizzle:e2e": "jest scripts/drizzle-helpers/__tests__/e2e-workflow.test.ts",
    "test:drizzle": "npm run test:drizzle:unit && npm run test:drizzle:integration"
  }
}
```

---

## Test Pyramid Summary

```
         /\
        /E2E\          E2E Workflow Test (5-10%)
       /    \          - Full generate → Lambda cycle
      /------\         - Real DB integration
     /        \        - 1-2 critical path tests
    /Integration\      Integration Tests (20-30%)
   /    Tests    \     - drizzle-kit generate
  /--------------\     - SQL validation with real output
 /                \    - File system operations
/   Unit Tests     \   Unit Tests (60-70%)
/___________________\  - Migration numbering logic
                       - SQL pattern validation
                       - File formatting
                       - Error handling
```

## Coverage Goals

| Component | Target Coverage | Priority |
|-----------|----------------|----------|
| Migration numbering | >90% | HIGH |
| SQL validation | >95% | CRITICAL |
| File formatter | >85% | MEDIUM |
| Integration workflow | >80% | HIGH |
| E2E workflow | >75% | MEDIUM |

---

## Test Execution Strategy

### Pre-Commit Hooks
```bash
# Run unit tests before allowing commit
npm run test:drizzle:unit
```

### PR Requirements
- All unit tests passing
- Integration tests passing (with test DB)
- Coverage >80% for new code
- No CONCURRENTLY patterns in generated SQL

### Manual Testing Checklist
- [ ] Generate migration from schema change
- [ ] Validate SQL output (no CONCURRENTLY)
- [ ] Get next migration number
- [ ] Format and copy to schema directory
- [ ] Add to MIGRATION_FILES array
- [ ] Deploy and verify Lambda execution
- [ ] Confirm migration_log entry
- [ ] Verify schema change in database

---

## Edge Cases & Validation

### Critical Validation Checks

1. **CONCURRENTLY Detection**
   - Case-insensitive matching
   - Ignore in comments
   - Ignore in string literals
   - Report line numbers

2. **Migration Numbering**
   - Handle gaps in sequence
   - Skip rollback files
   - Handle legacy format (11_textract)
   - Pad numbers correctly

3. **File Registration**
   - Prevent duplicates
   - Maintain array order
   - Validate syntax after addition

4. **SQL Compatibility**
   - No multi-transaction operations
   - Prefer IF NOT EXISTS
   - Valid statement splitting
   - Proper semicolon handling

---

## Success Criteria

### Tests Pass When:
- ✅ Migration numbering correctly identifies next number
- ✅ SQL validation catches CONCURRENTLY patterns
- ✅ SQL validation ignores false positives (comments, strings)
- ✅ drizzle-kit generates Lambda-compatible SQL
- ✅ Generated SQL can be executed by Lambda handler
- ✅ Migration tracking works end-to-end
- ✅ Error messages are clear and actionable

### Tests Fail When:
- ❌ CONCURRENTLY pattern not detected
- ❌ Migration number collision occurs
- ❌ Generated SQL incompatible with Lambda
- ❌ MIGRATION_FILES array syntax broken
- ❌ Migration runs twice (not idempotent)

---

## Monitoring & Metrics

### Test Metrics to Track
- **Execution time**: Unit tests <5s, integration <30s, E2E <2min
- **Coverage**: Maintain >80% overall
- **Flakiness**: <1% flaky test rate
- **False positives**: Zero false CONCURRENTLY detections

### Production Metrics
- **Migration success rate**: 100% on valid SQL
- **CONCURRENTLY detection rate**: 100% (no false negatives)
- **Average migration time**: <30 seconds per file

---

## Implementation Files

### File Structure
```
/Users/hagelk/non-ic-code/aistudio/
├── scripts/
│   └── drizzle-helpers/
│       ├── get-next-migration-number.ts
│       ├── get-next-migration-number.test.ts
│       ├── validate-sql.ts
│       ├── validate-sql.test.ts
│       ├── format-migration.ts
│       ├── format-migration.test.ts
│       ├── add-to-migration-files.ts
│       ├── add-to-migration-files.test.ts
│       └── __tests__/
│           ├── integration.test.ts
│           └── e2e-workflow.test.ts
├── fixtures/
│   └── drizzle-helpers/
│       ├── drizzle-valid.sql
│       ├── drizzle-invalid.sql
│       ├── drizzle-complex.sql
│       └── mock-db-init-handler.js
└── docs/
    └── testing/
        └── drizzle-migration-test-strategy.md (this file)
```

---

## Appendix: Lambda Constraints Reference

### What Lambda Migration System CANNOT Handle

1. **CONCURRENTLY operations** (require autocommit mode)
   ```sql
   -- ❌ FAILS in Lambda
   CREATE INDEX CONCURRENTLY idx_name ON table (col);

   -- ✅ WORKS in Lambda
   CREATE INDEX IF NOT EXISTS idx_name ON table (col);
   ```

2. **Multi-transaction operations**
   ```sql
   -- ❌ FAILS (requires separate transactions)
   BEGIN;
   CREATE TABLE t1 (id SERIAL);
   COMMIT;
   BEGIN;
   CREATE TABLE t2 (id SERIAL);
   COMMIT;
   ```

3. **Transaction control in migration files**
   ```sql
   -- ❌ FAILS (Lambda wraps in own transaction)
   BEGIN;
   ALTER TABLE users ADD COLUMN email TEXT;
   COMMIT;
   ```

### What Lambda Migration System REQUIRES

1. **Idempotent operations** (IF NOT EXISTS, IF EXISTS)
2. **Single-statement execution** (semicolon-separated)
3. **No autocommit dependencies**
4. **PostgreSQL Data API compatible syntax**

---

*Last Updated: 2025-12-26*
*Related: Issue #539, Epic #526*
*Owner: Test Specialist Agent*
