"""
Database Secret Rotation Handler

Implements the 4-step rotation process for database credentials:
1. createSecret - Generate new password
2. setSecret - Update database with new password
3. testSecret - Verify new password works
4. finishSecret - Mark rotation as complete

Supports:
- Amazon RDS (PostgreSQL, MySQL, etc.)
- Aurora Serverless v2
- Self-managed databases

Environment Variables:
- SECRETS_MANAGER_ENDPOINT: Secrets Manager endpoint URL
"""

import json
import logging
import boto3
import os
from typing import Dict, Any, Optional
import psycopg2
from psycopg2 import sql
import re

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Initialize AWS clients
secretsmanager = boto3.client(
    'secretsmanager',
    endpoint_url=os.environ.get('SECRETS_MANAGER_ENDPOINT')
)


def sanitize_for_logging(text: str) -> str:
    """
    Sanitize sensitive information from log messages

    Removes:
    - ARNs (Amazon Resource Names)
    - IP addresses
    - Email addresses

    Args:
        text: Text to sanitize

    Returns:
        Sanitized text safe for logging
    """
    if not text:
        return text

    # Remove ARNs
    text = re.sub(r'arn:aws:[^:]+:[^:]+:\d+:[^\s]+', '[ARN_REDACTED]', text)
    # Remove IP addresses
    text = re.sub(r'\d+\.\d+\.\d+\.\d+', '[IP_REDACTED]', text)
    # Remove email addresses
    text = re.sub(r'[\w\.-]+@[\w\.-]+\.\w+', '[EMAIL_REDACTED]', text)

    return text


def sanitize_error(error: Exception) -> str:
    """
    Sanitize error messages to remove sensitive data

    Args:
        error: Exception to sanitize

    Returns:
        Sanitized error message
    """
    error_str = str(error)
    return sanitize_for_logging(error_str)


def validate_rotation_request(arn: str, token: str) -> bool:
    """
    AWS-standard rotation preamble guard (REV-INFRA-109).

    Verifies the secret has rotation enabled, the ClientRequestToken is actually
    staged for this secret, and it is AWSPENDING (not already AWSCURRENT). Without
    these checks the handler would act on out-of-order/stale invocations or on a
    version Secrets Manager does not expect.

    Returns:
        True if the caller should short-circuit (token already AWSCURRENT).
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
    Main rotation handler invoked by Secrets Manager

    Args:
        event: Event data from Secrets Manager containing:
            - SecretId: ARN of the secret being rotated
            - ClientRequestToken: Unique rotation request ID
            - Step: Rotation step (createSecret, setSecret, testSecret, finishSecret)
        context: Lambda context object
    """
    # Log sanitized event (don't log full ARN)
    logger.info(f"Rotation event received for step: {event.get('Step')}")

    arn = event['SecretId']
    token = event['ClientRequestToken']
    step = event['Step']

    try:
        # AWS-standard preamble guard before acting on the step (REV-INFRA-109).
        if validate_rotation_request(arn, token):
            return

        # Dispatch to appropriate step handler
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
    Step 1: Create a new secret version with a new password

    Generates a new random password and stores it as AWSPENDING.
    """
    logger.info(f"Creating new secret version for {arn}")

    # Check if AWSPENDING version already exists
    try:
        secretsmanager.get_secret_value(
            SecretId=arn,
            VersionId=token,
            VersionStage="AWSPENDING"
        )
        logger.info("Secret version already exists, skipping creation")
        return
    except secretsmanager.exceptions.ResourceNotFoundException:
        pass  # Secret doesn't exist yet, continue with creation

    # Get current secret
    current_secret = secretsmanager.get_secret_value(
        SecretId=arn,
        VersionStage="AWSCURRENT"
    )

    secret_dict = json.loads(current_secret['SecretString'])

    # Generate new password
    password_response = secretsmanager.get_random_password(
        PasswordLength=32,
        ExcludeCharacters='/@"\'\\',
        ExcludePunctuation=False,
        RequireEachIncludedType=True
    )

    # Update password in secret dict
    secret_dict['password'] = password_response['RandomPassword']

    # Put new secret version
    secretsmanager.put_secret_value(
        SecretId=arn,
        ClientRequestToken=token,
        SecretString=json.dumps(secret_dict),
        VersionStages=['AWSPENDING']
    )

    logger.info("Successfully created new secret version")


def set_secret(arn: str, token: str) -> None:
    """
    Step 2: Set the new password in the database

    Updates the database user's password to match the AWSPENDING secret.
    """
    logger.info(f"Setting secret in database for {arn}")

    # Get pending secret
    pending_secret = secretsmanager.get_secret_value(
        SecretId=arn,
        VersionId=token,
        VersionStage="AWSPENDING"
    )

    pending_dict = json.loads(pending_secret['SecretString'])

    # Get current secret for connection
    current_secret = secretsmanager.get_secret_value(
        SecretId=arn,
        VersionStage="AWSCURRENT"
    )

    current_dict = json.loads(current_secret['SecretString'])

    # Connect to database with current credentials
    conn = get_database_connection(current_dict)

    try:
        cursor = conn.cursor()

        # Update user password
        username = pending_dict['username']
        new_password = pending_dict['password']

        # Use SQL composition with Identifier to safely quote username
        # This prevents SQL injection while allowing dynamic usernames
        cursor.execute(
            sql.SQL("ALTER USER {} WITH PASSWORD %s").format(
                sql.Identifier(username)
            ),
            (new_password,)
        )

        conn.commit()
        logger.info(f"Successfully updated password for user {sanitize_for_logging(username)}")

    finally:
        if conn:
            conn.close()


def test_secret(arn: str, token: str) -> None:
    """
    Step 3: Test the new password

    Attempts to connect to the database using the AWSPENDING credentials.
    """
    logger.info(f"Testing secret for {arn}")

    # Get pending secret
    pending_secret = secretsmanager.get_secret_value(
        SecretId=arn,
        VersionId=token,
        VersionStage="AWSPENDING"
    )

    pending_dict = json.loads(pending_secret['SecretString'])

    # Test connection with new credentials
    conn = get_database_connection(pending_dict)

    try:
        cursor = conn.cursor()
        cursor.execute("SELECT 1")
        result = cursor.fetchone()

        if result[0] != 1:
            raise Exception("Failed to execute test query")

        logger.info("Successfully tested new credentials")

    finally:
        if conn:
            conn.close()


def finish_secret(arn: str, token: str) -> None:
    """
    Step 4: Finish the rotation

    Moves the AWSCURRENT label to the AWSPENDING version.
    """
    logger.info(f"Finishing rotation for {arn}")

    # Get metadata about the secret
    metadata = secretsmanager.describe_secret(SecretId=arn)

    # Find current version
    current_version = None
    for version in metadata['VersionIdsToStages']:
        if "AWSCURRENT" in metadata['VersionIdsToStages'][version]:
            if version == token:
                # Already current, nothing to do
                logger.info("New version is already marked as AWSCURRENT")
                return
            current_version = version
            break

    # Move AWSCURRENT stage to new version. Never pass RemoveFromVersionId=None —
    # if no AWSCURRENT version was found, omit it rather than sending an invalid
    # argument to the API (REV-INFRA-109).
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

    logger.info("Successfully completed rotation")


def get_database_connection(secret_dict: Dict[str, Any]) -> Any:
    """
    Establishes database connection using provided credentials

    Args:
        secret_dict: Dictionary containing connection parameters
            - host: Database host
            - port: Database port
            - username: Database username
            - password: Database password
            - database: Database name (optional)

    Returns:
        Database connection object
    """
    # Require TLS on the rotation connection (REV-COR-435-OVF1 / REV-INFRA-108).
    # libpq's default sslmode is 'prefer', which silently falls back to an
    # UNENCRYPTED connection — over which set_secret transmits the freshly rotated
    # ALTER USER password. Aurora/RDS accept TLS; 'require' guarantees encryption.
    # Overridable via the secret's own `sslmode` for non-TLS targets, but the
    # default enforces encryption.
    sslmode = secret_dict.get('sslmode', 'require')
    return psycopg2.connect(
        host=secret_dict['host'],
        port=secret_dict.get('port', 5432),
        user=secret_dict['username'],
        password=secret_dict['password'],
        database=secret_dict.get('database', 'postgres'),
        sslmode=sslmode,
        connect_timeout=5
    )
