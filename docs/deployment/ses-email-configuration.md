# SES Email Configuration Guide

This guide covers setting up Amazon SES (Simple Email Service) for email notifications in AI Studio deployments.

## Overview

AI Studio uses SES to send email notifications for scheduled execution results. SES requires verified identities (email addresses or domains) before it can send emails.

## Verification Options

### Option 1: Domain Verification (Recommended)
Verify an entire domain (e.g., `psd401.net`) to allow any email address from that domain to send emails.

### Option 2: Individual Email Verification
Verify specific email addresses individually. Less scalable but simpler for single-user setups.

## Domain Verification Process

### 1. Generate Verification Token

```bash
aws ses verify-domain-identity --domain yourdomain.com --region us-east-1
```

**Example Response:**
```json
{
    "VerificationToken": "p+oMp/tK13qO6orWrChhNzsIvjlIk85gsFZsjO/NQCU="
}
```

### 2. Add DNS Record

Add a TXT record to your domain's DNS:

- **Name:** `_amazonses.yourdomain.com`
- **Type:** `TXT`
- **Value:** `[verification token from step 1]`

**Example for psd401.net:**
```
Name: _amazonses.psd401.net
Type: TXT
Value: p+oMp/tK13qO6orWrChhNzsIvjlIk85gsFZsjO/NQCU=
```

### 3. Wait for Verification

DNS propagation typically takes 5-15 minutes. Check status:

```bash
aws ses get-identity-verification-attributes --identities yourdomain.com --region us-east-1
```

**Success Response:**
```json
{
    "VerificationAttributes": {
        "yourdomain.com": {
            "VerificationStatus": "Success",
            "VerificationToken": "p+oMp/tK13qO6orWrChhNzsIvjlIk85gsFZsjO/NQCU="
        }
    }
}
```

## AI Studio Deployment Configuration

### Domain Verification Deployment

When you have domain verification:

```bash
bunx cdk deploy AIStudio-EmailNotificationStack-Dev \
  --context emailDomain=yourdomain.com \
  --context sesIdentityExists=true \
  --context useDomainIdentity=true \
  --context baseDomain=aistudio.yourdomain.com
```

### Fresh Domain Setup

If the domain identity doesn't exist yet, let CDK create it:

```bash
bunx cdk deploy AIStudio-EmailNotificationStack-Dev \
  --context emailDomain=yourdomain.com \
  --context sesIdentityExists=false \
  --context useDomainIdentity=true \
  --context baseDomain=aistudio.yourdomain.com
```

You'll still need to add the DNS record after deployment.

## Configuration Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `emailDomain` | Domain for email addresses | `psd401.net` |
| `sesIdentityExists` | Whether SES identity already exists | `true` or `false` |
| `useDomainIdentity` | Use domain vs email verification | `true` (recommended) |
| `baseDomain` | Base domain for app URLs | `aistudio.psd401.ai` |

## Troubleshooting

### Common Issues

1. **Wrong AWS Region**
   - SES identities are region-specific
   - Check which region contains your identities:
   ```bash
   aws ses list-identities --region us-east-1
   aws ses list-identities --region us-west-2
   ```

2. **Pending Verification**
   - Check DNS record is correct
   - Wait for DNS propagation (up to 48 hours in some cases)
   - Verify with: `dig TXT _amazonses.yourdomain.com`

3. **AlreadyExists Error**
   - Use `sesIdentityExists=true` when identity exists
   - Or delete existing identity and recreate

4. **Sandbox Mode Limitations**
   - New SES accounts start in sandbox mode
   - Can only send to verified addresses
   - Request production access: [SES Console → Account Dashboard → Request Production Access]

### Verification Commands

Check all identities:
```bash
aws ses list-identities --region us-east-1
```

Check verification status:
```bash
aws ses get-identity-verification-attributes \
  --identities yourdomain.com user@yourdomain.com \
  --region us-east-1
```

## Production Considerations

### Moving Out of Sandbox Mode

For production deployments, request SES production access to:
- Remove recipient verification requirements
- Increase sending limits
- Enable sending to any email address

### DNS Management

- Use your organization's DNS management process
- Document DNS changes for future reference
- Consider using AWS Route 53 for automated DNS management

### Security

- Use domain verification instead of individual emails when possible
- Set up SPF, DKIM, and DMARC records for better deliverability
- Monitor SES sending statistics and reputation

## Example: Complete psd401.net Setup

1. **Verify domain:**
```bash
aws ses verify-domain-identity --domain psd401.net --region us-east-1
```

2. **Add DNS record:**
```
_amazonses.psd401.net TXT "verification-token-here"
```

3. **Deploy with verified domain:**
```bash
bunx cdk deploy AIStudio-EmailNotificationStack-Dev \
  --context emailDomain=psd401.net \
  --context sesIdentityExists=true \
  --context useDomainIdentity=true \
  --context baseDomain=aistudio.psd401.ai
```

4. **Verify email notifications work:**
- Create a test schedule
- Execute it manually
- Check CloudWatch logs for email sending success

---

*Last updated: September 2025*
*For questions, see: [AI Studio Documentation](/docs/README.md)*