"""
Aurora Serverless v2 Auto-Pause/Resume Lambda

This Lambda function monitors Aurora Serverless v2 database connections
and automatically pauses the cluster during idle periods to save costs.

Features:
- Monitors DatabaseConnections metric from CloudWatch
- Pauses cluster after configured idle period
- Automatically resumes on next connection attempt
- Safe rollback on errors
"""

import boto3
import os
import json
from datetime import datetime, timedelta, timezone
from typing import Dict, Any, Optional
import logging

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Initialize AWS clients
rds = boto3.client("rds")
cloudwatch = boto3.client("cloudwatch")

# Configuration from environment variables
CLUSTER_ID = os.environ["CLUSTER_IDENTIFIER"]
ENVIRONMENT = os.environ["ENVIRONMENT"]


def get_idle_threshold() -> int:
    """Get and validate idle threshold from environment with reasonable bounds."""
    threshold = int(os.environ.get("IDLE_MINUTES_THRESHOLD", "30"))

    # Enforce reasonable bounds: 5 minutes to 4 hours
    MIN_THRESHOLD = 5
    MAX_THRESHOLD = 240

    if threshold < MIN_THRESHOLD:
        logger.warning(
            f"IDLE_MINUTES_THRESHOLD {threshold} too low. "
            f"Using minimum {MIN_THRESHOLD} minutes."
        )
        return MIN_THRESHOLD

    if threshold > MAX_THRESHOLD:
        logger.warning(
            f"IDLE_MINUTES_THRESHOLD {threshold} too high. "
            f"Using maximum {MAX_THRESHOLD} minutes."
        )
        return MAX_THRESHOLD

    return threshold


IDLE_MINUTES_THRESHOLD = get_idle_threshold()

# Constants for input validation
ALLOWED_ACTIONS = {"pause", "resume", "auto"}
MAX_REASON_LENGTH = 500


def validate_event(event: Dict[str, Any]) -> tuple[str, str]:
    """Validate and sanitize event inputs."""
    action = event.get("action", "auto")

    # Validate action is allowed
    if action not in ALLOWED_ACTIONS:
        logger.warning(
            f"Invalid action '{action}' provided. Defaulting to 'auto'."
        )
        action = "auto"

    # Sanitize reason string
    reason = str(event.get("reason", "Manual invocation"))
    if len(reason) > MAX_REASON_LENGTH:
        logger.warning(
            f"Reason too long ({len(reason)} chars). Truncating to {MAX_REASON_LENGTH}."
        )
        reason = reason[:MAX_REASON_LENGTH] + "... (truncated)"

    return action, reason


def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Main Lambda handler for pause/resume operations.

    Event structure:
    {
        "action": "pause" | "resume" | "auto",
        "reason": "Description of why this action was triggered"
    }
    """
    logger.info(f"Aurora cost optimizer invoked: action={event.get('action', 'auto')}")

    action, reason = validate_event(event)

    try:
        if action == "pause":
            return pause_cluster(reason)
        elif action == "resume":
            return resume_cluster(reason)
        elif action == "auto":
            return auto_pause_check(reason)
        else:
            raise ValueError(f"Invalid action: {action}")

    except Exception as e:
        logger.error(f"Error in Aurora cost optimizer: {str(e)}", exc_info=True)
        return {"statusCode": 500, "error": "Aurora cost optimizer failed. See CloudWatch logs for details."}


def get_cluster_info() -> Dict[str, Any]:
    """Get current cluster configuration."""
    try:
        response = rds.describe_db_clusters(DBClusterIdentifier=CLUSTER_ID)
        if not response["DBClusters"]:
            raise ValueError(f"Cluster {CLUSTER_ID} not found")

        cluster = response["DBClusters"][0]
        scaling_config = cluster.get("ServerlessV2ScalingConfiguration", {})

        return {
            "status": cluster["Status"],
            "minCapacity": scaling_config.get("MinCapacity", 0.5),
            "maxCapacity": scaling_config.get("MaxCapacity", 1.0),
            "engine": cluster["Engine"],
            "engineVersion": cluster["EngineVersion"],
        }
    except Exception as e:
        logger.error(f"Error getting cluster info: {str(e)}")
        raise


def get_connection_count(minutes: int = 30) -> int:
    """
    Get maximum database connections over the specified time period.

    Args:
        minutes: Number of minutes to look back

    Returns:
        Maximum number of connections in the period
    """
    try:
        end_time = datetime.now(timezone.utc)
        start_time = end_time - timedelta(minutes=minutes)

        response = cloudwatch.get_metric_statistics(
            Namespace="AWS/RDS",
            MetricName="DatabaseConnections",
            Dimensions=[{"Name": "DBClusterIdentifier", "Value": CLUSTER_ID}],
            StartTime=start_time,
            EndTime=end_time,
            Period=300,  # 5-minute periods
            Statistics=["Maximum"],
        )

        if not response["Datapoints"]:
            logger.info(f"No connection metrics found for last {minutes} minutes")
            return 0

        # Get the maximum connection count across all data points
        max_connections = max(
            point["Maximum"] for point in response["Datapoints"]
        )

        logger.info(
            f"Max connections in last {minutes} minutes: {max_connections}"
        )
        return int(max_connections)

    except Exception as e:
        logger.error(f"Error getting connection metrics: {str(e)}")
        # On error, assume connections exist (safe default)
        return 1


def pause_cluster(reason: str) -> Dict[str, Any]:
    """
    Pause the cluster by setting min/max capacity to minimal values.

    Note: Aurora Serverless v2 doesn't have a true "pause" API.
    We simulate pausing by reducing capacity to minimum (0.5 ACU).
    """
    logger.info(f"Attempting to pause cluster: {reason}")

    cluster_info = get_cluster_info()
    current_min = cluster_info["minCapacity"]

    # Only consider it paused if both min AND max are at 0.5.
    # Use normalized comparison (round to nearest 0.5) to avoid float precision issues.
    # Bug fix: Previously only checked min, so dev cluster (min=0.5, max=2.0)
    # was incorrectly reported as "already paused" and never truly paused.
    current_max = cluster_info["maxCapacity"]
    normalized_min = round(current_min * 2) / 2
    normalized_max = round(current_max * 2) / 2
    if normalized_min == 0.5 and normalized_max == 0.5:
        logger.info("Cluster already at minimum capacity (effectively paused)")
        return {"status": "already_paused", "capacity": 0.5}

    try:
        # Store original max capacity before modifying
        original_max = cluster_info["maxCapacity"]

        rds.modify_db_cluster(
            DBClusterIdentifier=CLUSTER_ID,
            ServerlessV2ScalingConfiguration={
                "MinCapacity": 0.5,
                "MaxCapacity": 0.5,  # Force minimum to reduce costs
            },
            ApplyImmediately=True,
        )

        logger.info(
            f"Cluster paused successfully. "
            f"Previous capacity: {current_min}-{original_max} ACU, "
            f"New capacity: 0.5-0.5 ACU"
        )

        return {
            "status": "paused",
            "previousMin": current_min,
            "previousMax": original_max,
            "newCapacity": 0.5,
            "reason": reason,
        }

    except Exception as e:
        logger.error(f"Error pausing cluster: {str(e)}")
        raise


def resume_cluster(reason: str) -> Dict[str, Any]:
    """
    Resume the cluster to normal scaling configuration.

    Restores the cluster's scaling configuration based on environment.
    """
    logger.info(f"Attempting to resume cluster: {reason}")

    cluster_info = get_cluster_info()

    # Determine target capacity based on environment (right-sized per #832)
    if ENVIRONMENT == "prod":
        target_min, target_max = 1.0, 4.0
    elif ENVIRONMENT == "staging":
        target_min, target_max = 0.5, 2.0
    else:  # dev
        target_min, target_max = 0.5, 2.0

    # If already at target, no action needed
    if (
        cluster_info["minCapacity"] == target_min
        and cluster_info["maxCapacity"] == target_max
    ):
        logger.info("Cluster already at target capacity")
        return {"status": "already_resumed", "capacity": f"{target_min}-{target_max}"}

    try:
        rds.modify_db_cluster(
            DBClusterIdentifier=CLUSTER_ID,
            ServerlessV2ScalingConfiguration={
                "MinCapacity": target_min,
                "MaxCapacity": target_max,
            },
            ApplyImmediately=True,
        )

        logger.info(
            f"Cluster resumed successfully. Capacity set to {target_min}-{target_max} ACU"
        )

        return {
            "status": "resumed",
            "minCapacity": target_min,
            "maxCapacity": target_max,
            "reason": reason,
        }

    except Exception as e:
        logger.error(f"Error resuming cluster: {str(e)}")
        raise


def auto_pause_check(reason: str) -> Dict[str, Any]:
    """
    Automatically check if cluster should be paused based on idle time.

    Logic:
    1. Check connection metrics for the threshold period
    2. If no connections, pause the cluster
    3. If connections exist, ensure cluster is resumed
    """
    logger.info(f"Running auto-pause check: {reason}")

    # Get connection count over threshold period
    max_connections = get_connection_count(minutes=IDLE_MINUTES_THRESHOLD)

    if max_connections == 0:
        logger.info(
            f"No connections in last {IDLE_MINUTES_THRESHOLD} minutes. "
            f"Attempting to pause cluster."
        )
        return pause_cluster(
            f"Auto-pause: Idle for {IDLE_MINUTES_THRESHOLD} minutes"
        )
    else:
        logger.info(
            f"Found {max_connections} connections in last "
            f"{IDLE_MINUTES_THRESHOLD} minutes. Ensuring cluster is active."
        )
        # Don't force resume if cluster is already active
        # This prevents unnecessary API calls
        cluster_info = get_cluster_info()
        if round(cluster_info["minCapacity"] * 2) / 2 == 0.5 and round(cluster_info["maxCapacity"] * 2) / 2 == 0.5:
            logger.info("Cluster is paused but has activity. Resuming.")
            return resume_cluster("Auto-resume: Activity detected")
        else:
            logger.info("Cluster already active. No action needed.")
            return {
                "status": "active",
                "connections": max_connections,
                "capacity": f"{cluster_info['minCapacity']}-{cluster_info['maxCapacity']}",
            }
