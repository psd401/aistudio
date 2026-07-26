-- Migration 141: OneRoster core schema (Epic #1308 / Issue #1309)
--
-- Mirrors the OneRoster 1.2 core rostering collections used by the ClassLink
-- sync. Roster-to-roster references intentionally use sourced-id text columns
-- plus indexes rather than foreign keys so collections can arrive independently.
--
-- This migration is additive and idempotent. It uses only plain statements
-- because the migration runner cannot split PL/pgSQL DO blocks safely.

-- ---------------------------------------------------------------------------
-- Orgs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oneroster_orgs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sourced_id         text NOT NULL,
  name               text,
  type               text,
  identifier         text,
  parent_sourced_id  text,
  status             text CHECK (status IN ('active', 'tobedeleted')),
  is_active          boolean NOT NULL DEFAULT true,
  date_last_modified timestamptz,
  last_synced_at     timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_oneroster_orgs_sourced_id
  ON oneroster_orgs (sourced_id);

CREATE INDEX IF NOT EXISTS idx_oneroster_orgs_parent_sourced_id
  ON oneroster_orgs (parent_sourced_id);

DROP TRIGGER IF EXISTS update_oneroster_orgs_updated_at ON oneroster_orgs;
CREATE TRIGGER update_oneroster_orgs_updated_at
  BEFORE UPDATE ON oneroster_orgs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- Academic sessions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oneroster_academic_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sourced_id         text NOT NULL,
  title              text,
  type               text,
  start_date         date,
  end_date           date,
  parent_sourced_id  text,
  school_year        text,
  status             text CHECK (status IN ('active', 'tobedeleted')),
  is_active          boolean NOT NULL DEFAULT true,
  date_last_modified timestamptz,
  last_synced_at     timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_oneroster_academic_sessions_sourced_id
  ON oneroster_academic_sessions (sourced_id);

CREATE INDEX IF NOT EXISTS idx_oneroster_academic_sessions_parent_sourced_id
  ON oneroster_academic_sessions (parent_sourced_id);

DROP TRIGGER IF EXISTS update_oneroster_academic_sessions_updated_at
  ON oneroster_academic_sessions;
CREATE TRIGGER update_oneroster_academic_sessions_updated_at
  BEFORE UPDATE ON oneroster_academic_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- Courses
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oneroster_courses (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sourced_id         text NOT NULL,
  title              text,
  course_code        text,
  org_sourced_id     text,
  grades             text[],
  status             text CHECK (status IN ('active', 'tobedeleted')),
  is_active          boolean NOT NULL DEFAULT true,
  date_last_modified timestamptz,
  last_synced_at     timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_oneroster_courses_sourced_id
  ON oneroster_courses (sourced_id);

CREATE INDEX IF NOT EXISTS idx_oneroster_courses_org_sourced_id
  ON oneroster_courses (org_sourced_id);

DROP TRIGGER IF EXISTS update_oneroster_courses_updated_at ON oneroster_courses;
CREATE TRIGGER update_oneroster_courses_updated_at
  BEFORE UPDATE ON oneroster_courses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- Classes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oneroster_classes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sourced_id         text NOT NULL,
  title              text,
  class_code         text,
  class_type         text,
  location           text,
  course_sourced_id  text,
  school_sourced_id  text,
  grades             text[],
  subjects           text[],
  periods            text[],
  status             text CHECK (status IN ('active', 'tobedeleted')),
  is_active          boolean NOT NULL DEFAULT true,
  date_last_modified timestamptz,
  last_synced_at     timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_oneroster_classes_sourced_id
  ON oneroster_classes (sourced_id);

CREATE INDEX IF NOT EXISTS idx_oneroster_classes_course_sourced_id
  ON oneroster_classes (course_sourced_id);

CREATE INDEX IF NOT EXISTS idx_oneroster_classes_school_sourced_id
  ON oneroster_classes (school_sourced_id);

DROP TRIGGER IF EXISTS update_oneroster_classes_updated_at ON oneroster_classes;
CREATE TRIGGER update_oneroster_classes_updated_at
  BEFORE UPDATE ON oneroster_classes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- Class terms
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oneroster_class_terms (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_sourced_id   text NOT NULL,
  term_sourced_id    text NOT NULL,
  status             text CHECK (status IN ('active', 'tobedeleted')),
  is_active          boolean NOT NULL DEFAULT true,
  date_last_modified timestamptz,
  last_synced_at     timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_oneroster_class_terms_class_term
  ON oneroster_class_terms (class_sourced_id, term_sourced_id);

CREATE INDEX IF NOT EXISTS idx_oneroster_class_terms_term_sourced_id
  ON oneroster_class_terms (term_sourced_id);

DROP TRIGGER IF EXISTS update_oneroster_class_terms_updated_at
  ON oneroster_class_terms;
CREATE TRIGGER update_oneroster_class_terms_updated_at
  BEFORE UPDATE ON oneroster_class_terms
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oneroster_users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sourced_id         text NOT NULL,
  email              text,
  username           text,
  given_name         text,
  family_name        text,
  role               text,
  enabled_user       boolean,
  grades             text[],
  status             text CHECK (status IN ('active', 'tobedeleted')),
  is_active          boolean NOT NULL DEFAULT true,
  date_last_modified timestamptz,
  last_synced_at     timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_oneroster_users_sourced_id
  ON oneroster_users (sourced_id);

CREATE INDEX IF NOT EXISTS idx_oneroster_users_email
  ON oneroster_users (lower(email));

DROP TRIGGER IF EXISTS update_oneroster_users_updated_at ON oneroster_users;
CREATE TRIGGER update_oneroster_users_updated_at
  BEFORE UPDATE ON oneroster_users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- User roles
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oneroster_user_roles (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_sourced_id    text NOT NULL,
  role               text NOT NULL,
  role_type          text NOT NULL,
  org_sourced_id     text,
  status             text CHECK (status IN ('active', 'tobedeleted')),
  is_active          boolean NOT NULL DEFAULT true,
  date_last_modified timestamptz,
  last_synced_at     timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- PostgreSQL treats NULL values as distinct in ordinary unique indexes.
-- Coalescing the nullable org id ensures only one org-less role tuple exists.
CREATE UNIQUE INDEX IF NOT EXISTS uq_oneroster_user_roles_tuple
  ON oneroster_user_roles (
    user_sourced_id,
    role,
    role_type,
    coalesce(org_sourced_id, '')
  );

CREATE INDEX IF NOT EXISTS idx_oneroster_user_roles_org_sourced_id
  ON oneroster_user_roles (org_sourced_id);

DROP TRIGGER IF EXISTS update_oneroster_user_roles_updated_at
  ON oneroster_user_roles;
CREATE TRIGGER update_oneroster_user_roles_updated_at
  BEFORE UPDATE ON oneroster_user_roles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- Enrollments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oneroster_enrollments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sourced_id         text NOT NULL,
  user_sourced_id    text,
  class_sourced_id   text,
  school_sourced_id  text,
  role               text,
  is_primary         boolean,
  begin_date         date,
  end_date           date,
  status             text CHECK (status IN ('active', 'tobedeleted')),
  is_active          boolean NOT NULL DEFAULT true,
  date_last_modified timestamptz,
  last_synced_at     timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_oneroster_enrollments_sourced_id
  ON oneroster_enrollments (sourced_id);

CREATE INDEX IF NOT EXISTS idx_oneroster_enrollments_class_sourced_id
  ON oneroster_enrollments (class_sourced_id);

CREATE INDEX IF NOT EXISTS idx_oneroster_enrollments_user_sourced_id
  ON oneroster_enrollments (user_sourced_id);

CREATE INDEX IF NOT EXISTS idx_oneroster_enrollments_school_sourced_id
  ON oneroster_enrollments (school_sourced_id);

DROP TRIGGER IF EXISTS update_oneroster_enrollments_updated_at
  ON oneroster_enrollments;
CREATE TRIGGER update_oneroster_enrollments_updated_at
  BEFORE UPDATE ON oneroster_enrollments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ===========================================================================
-- ROLLBACK SQL (for manual rollback if needed)
-- Drop dependents first so this remains safe if foreign keys are added later.
-- ===========================================================================
-- DROP TABLE IF EXISTS oneroster_enrollments;
-- DROP TABLE IF EXISTS oneroster_user_roles;
-- DROP TABLE IF EXISTS oneroster_users;
-- DROP TABLE IF EXISTS oneroster_class_terms;
-- DROP TABLE IF EXISTS oneroster_classes;
-- DROP TABLE IF EXISTS oneroster_courses;
-- DROP TABLE IF EXISTS oneroster_academic_sessions;
-- DROP TABLE IF EXISTS oneroster_orgs;
