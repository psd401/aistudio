"""
OAuth Token Secret Rotation Handler

Implements rotation for OAuth tokens and refresh tokens.
Suitable for short-lived OAuth credentials that need frequent rotation.

Note: This is a generic handler. For production use, customize the rotation
logic based on your specific OAuth provider (Google, Microsoft, etc.)
"""

import json
import logging
import boto3
import os
import re
from typing import Dict, Any

logger = logging.getLogger()
logger.setLevel(logging.INFO)

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
    Main rotation handler for OAuth secrets

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
    Step 1: Create new OAuth credentials.

    A real implementation must use the stored refresh_token to obtain a NEW
    access_token from the OAuth provider. There is NO safe placeholder for OAuth:
    the previous behaviour copied the current secret verbatim into AWSPENDING, so
    Secrets Manager reported a successful rotation while the token never changed —
    resetting the rotation clock and suppressing the rotation-failure alarm
    (REV-INFRA-106 / REV-COR-435-OVF2).

    Until provider-specific refresh is implemented, fail loudly so the rotation
    surfaces as an error instead of silently promoting an AWSPENDING version whose
    material is identical to AWSCURRENT.
    """
    logger.error("OAuth rotation is not implemented; refusing to promote an unchanged token")
    raise NotImplementedError(
        "OAuth secret rotation is not implemented. A provider-specific refresh-token "
        "exchange that mints a new access_token is required before this secret can be "
        "rotated. Implement the provider integration or disable rotation for this secret."
    )


def set_secret(arn: str, token: str) -> None:
    """
    Step 2: Set the new OAuth token

    For OAuth tokens, this is typically a no-op as the token
    is obtained from the provider and doesn't need to be "set"
    anywhere else.
    """
    logger.info(f"Set secret for {arn} - no-op for OAuth tokens")
    # OAuth tokens don't typically need to be set anywhere
    # They're retrieved from the provider and stored in Secrets Manager
    pass


def test_secret(arn: str, token: str) -> None:
    """
    Step 3: Test the new OAuth token

    Validates that the new token works by making a test API call
    to the OAuth provider.
    """
    logger.info(f"Testing OAuth token for {arn}")

    # Get pending secret
    pending_secret = secretsmanager.get_secret_value(
        SecretId=arn,
        VersionId=token,
        VersionStage="AWSPENDING"
    )

    pending_dict = json.loads(pending_secret['SecretString'])

    # Validate the token structure
    required_fields = ['access_token']
    for field in required_fields:
        if field not in pending_dict:
            raise ValueError(f"OAuth secret missing required field: {field}")

    # TODO: Implement actual token validation
    # This should make a test API call to the OAuth provider
    # to verify the access_token works
    logger.warning("Using placeholder validation - implement OAuth provider-specific test")

    logger.info("Successfully validated new OAuth token (placeholder)")


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

    logger.info("Successfully completed OAuth token rotation")
