# Security Policy

## Supported Versions

We release patches for security vulnerabilities. Currently supported versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report them via email to **aistudio@psd401.net**.

You should receive a response within 48 hours. If for some reason you do not, please follow up via email to ensure we received your original message.

Please include the requested information listed below (as much as you can provide) to help us better understand the nature and scope of the possible issue:

* **Type of issue** (e.g. buffer overflow, SQL injection, cross-site scripting, etc.)
* **Full paths of source file(s)** related to the manifestation of the issue
* **The location of the affected source code** (tag/branch/commit or direct URL)
* **Any special configuration required** to reproduce the issue
* **Step-by-step instructions to reproduce the issue**
* **Proof-of-concept or exploit code** (if possible)
* **Impact of the issue**, including how an attacker might exploit the issue

This information will help us triage your report more quickly.

## Preferred Languages

We prefer all communications to be in English.

## Security Best Practices

When deploying AI Studio, we recommend:

### Infrastructure Security
- Deploy in private VPC with restricted security groups
- Use AWS Secrets Manager for all sensitive configuration
- Enable VPC Flow Logs for network monitoring
- Configure CloudWatch alarms for suspicious activity
- Use IAM roles with least privilege (tag-based policies included)

### Application Security
- Keep all dependencies up to date (automated via Dependabot)
- Use strong authentication (Cognito with Google SSO)
- Implement role-based access control (RBAC)
- Enable audit logging for all sensitive operations
- Sanitize all user inputs (see `/lib/validation.ts`)

### Data Security
- All data stored encrypted at rest (Aurora encryption enabled)
- Data in transit encrypted via TLS 1.2+
- Student data protected per FERPA requirements
- No PII logged (use `sanitizeForLogging()` from `/lib/logger.ts`)

### Operational Security
- Regular security updates via CI/CD pipeline
- CodeQL static analysis enabled (see `.github/workflows/codeql.yml`)
- Security scanning for dependencies
- Infrastructure as Code security validation (CDK Nag)

## Security Features

AI Studio includes the following security features:

- **Tag-based IAM policies**: Cross-environment access blocked at IAM level
- **Parameterized SQL queries**: Prevents SQL injection
- **Input validation**: Server and client-side validation
- **Session security**: Secure JWT sessions with NextAuth v5
- **Rate limiting**: Protection against abuse (future enhancement)
- **Audit logging**: All sensitive operations logged

## Disclosure Policy

When we receive a security bug report, we will:

1. **Confirm the problem** and determine the affected versions
2. **Audit code** to find any similar problems
3. **Prepare fixes** for all supported releases
4. **Release patched versions** as soon as possible

We follow the principle of [Responsible Disclosure](https://en.wikipedia.org/wiki/Responsible_disclosure).

## Comments on this Policy

If you have suggestions on how this process could be improved, please submit a pull request.

## Attribution

This security policy is based on the template from [CONTRIBUTING.md](https://contributing.md) and adapted for K-12 education compliance (FERPA, COPPA).
