/**
 * Environment Variable Validation
 * Ensures all required environment variables are set before the application starts
 */

// Logger is not imported to maintain compatibility with Edge Runtime and client-side code

interface EnvVar {
  name: string;
  required: boolean;
  description?: string;
}

const ENV_VARS: EnvVar[] = [
  // Authentication
  { name: 'AUTH_URL', required: true, description: 'NextAuth base URL' },
  { name: 'AUTH_SECRET', required: true, description: 'NextAuth secret for JWT signing' },
  { name: 'AUTH_COGNITO_CLIENT_ID', required: true, description: 'AWS Cognito client ID' },
  { name: 'AUTH_COGNITO_CLIENT_SECRET', required: false, description: 'AWS Cognito client secret' },
  { name: 'AUTH_COGNITO_ISSUER', required: true, description: 'AWS Cognito issuer URL' },
  
  // Database - postgres.js driver (Issue #603)
  // Either DATABASE_URL (local dev) OR DB_HOST (AWS ECS) must be configured
  // Validation is done separately below since only one is needed
  { name: 'DATABASE_URL', required: false, description: 'PostgreSQL connection URL (local dev)' },
  { name: 'DB_HOST', required: false, description: 'Database hostname (AWS ECS)' },
  { name: 'DB_USER', required: false, description: 'Database username (AWS ECS)' },
  { name: 'DB_PASSWORD', required: false, description: 'Database password (AWS ECS)' },
  { name: 'DB_NAME', required: false, description: 'Database name (defaults to aistudio)' },
  { name: 'DB_SSL', required: false, description: 'Enable SSL (defaults to true)' },
  
  // AWS Configuration
  { name: 'NEXT_PUBLIC_AWS_REGION', required: true, description: 'AWS region' },
  { name: 'AWS_REGION', required: false, description: 'AWS region (runtime)' },
  { name: 'AWS_DEFAULT_REGION', required: false, description: 'AWS default region (runtime)' },
  
  // S3 Configuration
  { name: 'S3_BUCKET_NAME', required: true, description: 'S3 bucket for document storage' },
  
  // AI Services
  { name: 'ANTHROPIC_API_KEY', required: false, description: 'Anthropic API key for Claude' },
  { name: 'OPENAI_API_KEY', required: false, description: 'OpenAI API key' },
  
  // Application
  { name: 'NODE_ENV', required: false, description: 'Node environment (development/production)' },
];

export class EnvironmentValidationError extends Error {
  constructor(public missingVars: string[], public warnings: string[]) {
    super(`Missing required environment variables: ${missingVars.join(', ')}`);
    this.name = 'EnvironmentValidationError';
  }
}

/**
 * Validates that all required environment variables are set
 * @throws {EnvironmentValidationError} if required variables are missing
 */
export function validateEnv(): { isValid: boolean; missing: string[]; warnings: string[] } {
  const missing: string[] = [];
  const warnings: string[] = [];
  
  for (const envVar of ENV_VARS) {
    const value = process.env[envVar.name];
    
    if (envVar.required && !value) {
      missing.push(envVar.name);
    } else if (!envVar.required && !value) {
      warnings.push(`Optional variable ${envVar.name} is not set${envVar.description ? ` (${envVar.description})` : ''}`);
    }
  }
  
  // Additional validation logic
  if (!process.env.AWS_REGION && !process.env.AWS_DEFAULT_REGION && !process.env.NEXT_PUBLIC_AWS_REGION) {
    missing.push('AWS_REGION or AWS_DEFAULT_REGION or NEXT_PUBLIC_AWS_REGION');
  }

  // Database configuration: Either DATABASE_URL (local) or DB_HOST (AWS) must be set
  const hasDatabaseUrl = !!process.env.DATABASE_URL;
  const hasAwsDbConfig = !!process.env.DB_HOST;
  if (!hasDatabaseUrl && !hasAwsDbConfig) {
    missing.push('DATABASE_URL or DB_HOST (database configuration required)');
  }
  
  // Check for at least one AI API key
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    warnings.push('No AI API keys configured. AI features will not work.');
  }
  
  return {
    isValid: missing.length === 0,
    missing,
    warnings
  };
}

/**
 * Validates environment variables and throws if validation fails
 * Use this in API routes and server components
 */
export function requireValidEnv(): void {
  const { isValid, missing, warnings } = validateEnv();
  
  if (!isValid) {
    throw new EnvironmentValidationError(missing, warnings);
  }
  
  // Console warnings in development (logger not available in Edge Runtime)
  if (process.env.NODE_ENV === 'development' && warnings.length > 0) {
    console.warn('Environment validation warnings:');
    for (const warning of warnings) console.warn(`  - ${warning}`);
  }
}

/**
 * Get a required environment variable or throw
 */
export function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

/**
 * Get an optional environment variable with a default value
 */
export function getOptionalEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}