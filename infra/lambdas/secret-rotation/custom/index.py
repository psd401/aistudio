"""
Custom Secret Rotation Handler

Generic rotation handler for custom secret types including:
- Certificates
- SSH keys
- Custom application secrets
- Encryption keys
- Service account credentials

This is a basic template that implements the 4-step rotation process.
Customize the rotation logic based on your specific secret type and
requirements.
"""

import json
import logging
import boto3
import os
import re
from typing import Dict, Any
import secrets
import string

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Explicit opt-in for self-contained secrets (no external consumer to update). When
# unset, the placeholder set_secret fails loudly so a real secret is not marked
# rotated without its new value being propagated/validated (REV-INFRA-107 / OVF2).
ALLOW_PLACEHOLDER_ROTATION = os.environ.get('ALLOW_PLACEHOLDER_ROTATION', '').lower() in ('1', 'true', 'yes')

# Initialize AWS clients
secretsmanager = boto3.client(
    'secretsmanager',
    endpoint_url=os.environ.get('SECRETS_MANAGER_ENDPOINT')
)


def sanitize_for_logging(text: str) -> str:
    """Redact ARNs / IPs / emails from log messages (REV-INFRA-115)."""
    if not text:
        return text
    text = re.sub(r'arn:aws:[^:]+:[^:]+:\d+:[^\s]+', '[ARN_REDACTED]', text)
    text = re.sub(r'\d+\.\d+\.\d+\.\d+', '[IP_REDACTED]', text)
    text = re.sub(r'[\w\.-]+@[\w\.-]+\.\w+', '[EMAIL_REDACTED]', text)
    return text


def sanitize_error(error: Exception) -> str:
    """Sanitize an exception message for logging (REV-INFRA-115)."""
    return sanitize_for_logging(str(error))


def validate_rotation_request(arn: str, token: str) -> bool:
    """
    AWS-standard rotation preamble guard (REV-INFRA-109). Verifies rotation is
    enabled, the token is staged for this secret, and it is AWSPENDING (not already
    AWSCURRENT). Returns True if the caller should short-circuit (already current).
    """
    metadata = secretsmanager.describe_secret(SecretId=arn)
    if not metadata.get('RotationEnabled', False):
        raise ValueError("Secret is not enabled for rotation")
    versions = metadata['VersionIdsToStages']
    if token not in versions:
        raise ValueError("Rotation token has no stage for this secret")
    if "AWSCURRENT" in versions[token]:
        logger.info("Rotation token is already AWSCURRENT; nothing to do")
        return True
    if "AWSPENDING" not in versions[token]:
        raise ValueError("Rotation token is not staged as AWSPENDING")
    return False


def handler(event: Dict[str, Any], context: Any) -> None:
    """
    Main rotation handler for custom secrets

    Args:
        event: Event data from Secrets Manager
        context: Lambda context object
    """
    # Log only the step, never the full event/ARN/ClientRequestToken (REV-INFRA-115).
    logger.info(f"Rotation event received for step: {event.get('Step')}")

    arn = event['SecretId']
    token = event['ClientRequestToken']
    step = event['Step']

    try:
        # AWS-standard preamble guard before acting on the step (REV-INFRA-109).
        if validate_rotation_request(arn, token):
            return

        if step == "createSecret":
            create_secret(arn, token)
        elif step == "setSecret":
            set_secret(arn, token)
        elif step == "testSecret":
            test_secret(arn, token)
        elif step == "finishSecret":
            finish_secret(arn, token)
        else:
            raise ValueError(f"Invalid step: {step}")
    except Exception as e:
        logger.error(f"Rotation failed: {sanitize_error(e)}")
        raise


def create_secret(arn: str, token: str) -> None:
    """
    Step 1: Create new custom secret value

    Generates a new secret value. For custom secrets, this might be:
    - A new randomly generated key
    - A new certificate from a CA
    - A new password or token
    - Custom application-specific credentials
    """
    logger.info(f"Creating new custom secret for {arn}")

    # Check if AWSPENDING version already exists
    try:
        secretsmanager.get_secret_value(
            SecretId=arn,
            VersionId=token,
            VersionStage="AWSPENDING"
        )
        logger.info("Custom secret version already exists, skipping creation")
        return
    except secretsmanager.exceptions.ResourceNotFoundException:
        pass

    # Preserve the current secret's SHAPE across rotation (REV-INFRA-107): a
    # plain-string secret must stay a plain string, and a JSON secret keeps its
    # other fields. The old code coerced a plain string into {'value': ...} (and
    # replaced the whole dict when 'value' was absent, dropping sibling fields).
    current_is_json = True
    secret_dict: Dict[str, Any] = {}
    try:
        current_secret = secretsmanager.get_secret_value(
            SecretId=arn,
            VersionStage="AWSCURRENT"
        )
        try:
            parsed = json.loads(current_secret['SecretString'])
            if isinstance(parsed, dict):
                secret_dict = parsed
            else:
                current_is_json = False
        except json.JSONDecodeError:
            current_is_json = False
    except secretsmanager.exceptions.ResourceNotFoundException:
        # No current version — default to a JSON {"value": ...} structure.
        current_is_json = True

    # Default: generate a cryptographically secure random string. (TODO: customize
    # per secret type — e.g. mint a certificate from a CA, or a KMS key — when this
    # handler is used for something other than a self-contained random value.)
    new_secret_value = generate_secure_secret(length=64)

    if current_is_json:
        secret_dict['value'] = new_secret_value
        new_secret_string = json.dumps(secret_dict)
    else:
        # Plain-string secret — keep it a plain string.
        new_secret_string = new_secret_value

    # Put new secret version
    secretsmanager.put_secret_value(
        SecretId=arn,
        ClientRequestToken=token,
        SecretString=new_secret_string,
        VersionStages=['AWSPENDING']
    )

    logger.info("Successfully created new custom secret version")


def set_secret(arn: str, token: str) -> None:
    """
    Step 2: Set the new secret in the target service.

    This handler cannot push the new value to an external consumer. For a secret
    with an external consumer, implement service-specific propagation here. For a
    SELF-CONTAINED secret (no external consumer to update), set the
    ALLOW_PLACEHOLDER_ROTATION env var to opt in — set_secret is then a documented
    no-op. Otherwise it fails loudly, so the rotation does not silently promote a
    value that was never propagated to its consumer (REV-INFRA-107 / REV-COR-435-OVF2).
    """
    if not ALLOW_PLACEHOLDER_ROTATION:
        raise NotImplementedError(
            "Custom secret set_secret is not implemented for an external consumer. "
            "Implement service-specific propagation, or set ALLOW_PLACEHOLDER_ROTATION=true "
            "to declare this secret self-contained (no external consumer to update)."
        )

    logger.info("set_secret is a documented no-op (self-contained secret; ALLOW_PLACEHOLDER_ROTATION set)")


def test_secret(arn: str, token: str) -> None:
    """
    Step 3: Test the new secret

    Verify that the new secret works correctly.

    TODO: Implement service-specific validation logic.
    Examples:
    - Make test API call with new credentials
    - Verify certificate validity
    - Test encryption/decryption with new key
    - Validate secret format and structure
    """
    logger.info("Validating new custom secret")

    # Get pending secret
    pending_secret = secretsmanager.get_secret_value(
        SecretId=arn,
        VersionId=token,
        VersionStage="AWSPENDING"
    )

    # Real format validation of the rotated value (REV-INFRA-107): a non-empty
    # string meeting the generator's length invariant, for either the plain-string
    # or JSON {"value": ...} shape. (For a secret with an external consumer, extend
    # this with an authenticated round-trip before promotion.)
    raw = pending_secret['SecretString']
    try:
        parsed = json.loads(raw)
        value = parsed.get('value') if isinstance(parsed, dict) else parsed
    except json.JSONDecodeError:
        value = raw

    if not isinstance(value, str) or len(value) < 32:
        raise ValueError("Rotated custom secret value is missing or too short")

    logger.info("Successfully validated new custom secret")


def finish_secret(arn: str, token: str) -> None:
    """
    Step 4: Finish the rotation by moving AWSCURRENT label
    """
    logger.info(f"Finishing rotation for {arn}")

    # Get metadata about the secret
    metadata = secretsmanager.describe_secret(SecretId=arn)

    # Find current version
    current_version = None
    for version in metadata['VersionIdsToStages']:
        if "AWSCURRENT" in metadata['VersionIdsToStages'][version]:
            if version == token:
                logger.info("New version is already marked as AWSCURRENT")
                return
            current_version = version
            break

    # Move AWSCURRENT stage to new version. Never pass RemoveFromVersionId=None
    # (REV-INFRA-109).
    if current_version is not None:
        secretsmanager.update_secret_version_stage(
            SecretId=arn,
            VersionStage="AWSCURRENT",
            MoveToVersionId=token,
            RemoveFromVersionId=current_version
        )
    else:
        logger.warning("No AWSCURRENT version found to remove; setting AWSCURRENT without removal")
        secretsmanager.update_secret_version_stage(
            SecretId=arn,
            VersionStage="AWSCURRENT",
            MoveToVersionId=token
        )

    logger.info("Successfully completed custom secret rotation")


def generate_secure_secret(length: int = 64) -> str:
    """
    Generate a cryptographically secure random secret

    Args:
        length: Length of the secret (default 64)

    Returns:
        Secure random string
    """
    # Use URL-safe characters
    alphabet = string.ascii_letters + string.digits + '-_'
    secret = ''.join(secrets.choice(alphabet) for _ in range(length))

    return secret
