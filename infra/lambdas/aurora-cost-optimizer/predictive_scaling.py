"""
Aurora Serverless v2 Predictive Scaling Lambda

This Lambda function implements intelligent scaling for Aurora Serverless v2
based on time-based schedules and usage patterns.

Features:
- Scheduled scaling for business hours vs off-hours
- Configurable capacity targets per schedule
- Safe scaling with validation
- Detailed logging for cost tracking
"""

import boto3
import os
import json
from datetime import datetime
from typing import Dict, Any, Optional
import logging

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Initialize AWS clients
rds = boto3.client("rds")

# Configuration from environment variables
CLUSTER_ID = os.environ["CLUSTER_IDENTIFIER"]
ENVIRONMENT = os.environ["ENVIRONMENT"]

# Constants for input validation
MAX_REASON_LENGTH = 500


def validate_capacity(capacity: Optional[float], name: str) -> Optional[float]:
    """Validate capacity value is within Aurora Serverless v2 bounds."""
    if capacity is None:
        return None

    # Aurora Serverless v2 valid range: 0.5 - 128 ACU
    if capacity < 0.5:
        logger.warning(f"{name} capacity {capacity} too low. Minimum is 0.5 ACU.")
        return 0.5
    if capacity > 128:
        logger.warning(f"{name} capacity {capacity} too high. Maximum is 128 ACU.")
        return 128

    return capacity


def validate_event(event: Dict[str, Any]) -> tuple[Optional[float], Optional[float], str]:
    """Validate and sanitize event inputs."""
    min_capacity = validate_capacity(event.get("minCapacity"), "Minimum")
    max_capacity = validate_capacity(event.get("maxCapacity"), "Maximum")

    # Sanitize reason string
    reason = str(event.get("reason", "Scheduled scaling"))
    if len(reason) > MAX_REASON_LENGTH:
        logger.warning(
            f"Reason too long ({len(reason)} chars). Truncating to {MAX_REASON_LENGTH}."
        )
        reason = reason[:MAX_REASON_LENGTH] + "... (truncated)"

    return min_capacity, max_capacity, reason


def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Main Lambda handler for predictive scaling operations.

    Event structure:
    {
        "minCapacity": 2.0,  # Optional, target minimum ACU
        "maxCapacity": 8.0,  # Optional, target maximum ACU
        "reason": "Business hours scale-up"
    }
    """
    logger.info(f"Predictive scaling invoked: {json.dumps(event)}")

    try:
        min_capacity, max_capacity, reason = validate_event(event)

        # Get current cluster state
        current_config = get_current_scaling_config()

        # Determine target configuration
        target_min, target_max = determine_target_capacity(
            min_capacity, max_capacity, current_config
        )

        # Check if scaling is needed
        if (
            current_config["minCapacity"] == target_min
            and current_config["maxCapacity"] == target_max
        ):
            logger.info(
                f"Cluster already at target capacity: {target_min}-{target_max} ACU"
            )
            return {
                "statusCode": 200,
                "status": "no_change_needed",
                "currentCapacity": f"{target_min}-{target_max}",
                "reason": reason,
            }

        # Apply scaling
        result = apply_scaling(target_min, target_max, reason, current_config)

        return {
            "statusCode": 200,
            "status": "scaled",
            "previousCapacity": f"{current_config['minCapacity']}-{current_config['maxCapacity']}",
            "newCapacity": f"{target_min}-{target_max}",
            "reason": reason,
            "costImpact": calculate_cost_impact(current_config, target_min, target_max),
        }

    except Exception as e:
        logger.error(f"Error in predictive scaling: {str(e)}", exc_info=True)
        return {
            "statusCode": 500,
            "error": str(e),
            "cluster": CLUSTER_ID,
        }


def get_current_scaling_config() -> Dict[str, Any]:
    """Get the current Aurora Serverless v2 scaling configuration."""
    try:
        response = rds.describe_db_clusters(DBClusterIdentifier=CLUSTER_ID)

        if not response["DBClusters"]:
            raise ValueError(f"Cluster {CLUSTER_ID} not found")

        cluster = response["DBClusters"][0]
        scaling_config = cluster.get("ServerlessV2ScalingConfiguration", {})

        return {
            "minCapacity": scaling_config.get("MinCapacity", 0.5),
            "maxCapacity": scaling_config.get("MaxCapacity", 1.0),
            "status": cluster["Status"],
            "engine": cluster["Engine"],
        }

    except Exception as e:
        logger.error(f"Error getting current scaling config: {str(e)}")
        raise


def determine_target_capacity(
    requested_min: Optional[float],
    requested_max: Optional[float],
    current_config: Dict[str, Any],
) -> tuple[float, float]:
    """
    Determine the target capacity based on request and environment.

    Args:
        requested_min: Requested minimum capacity (optional)
        requested_max: Requested maximum capacity (optional)
        current_config: Current cluster configuration

    Returns:
        Tuple of (min_capacity, max_capacity)
    """
    # Default capacity by environment
    # Right-sized per issue #832 based on CloudWatch ACU metrics
    env_defaults = {
        "prod": {"min": 1.0, "max": 4.0, "off_hours_min": 0.5, "off_hours_max": 2.0},
        "staging": {"min": 0.5, "max": 2.0, "off_hours_min": 0.5, "off_hours_max": 1.0},
        "dev": {"min": 0.5, "max": 2.0, "off_hours_min": 0.5, "off_hours_max": 1.0},
    }

    defaults = env_defaults.get(ENVIRONMENT, env_defaults["dev"])

    # Use requested values if provided, otherwise use environment defaults
    target_min = requested_min if requested_min is not None else defaults["min"]
    target_max = requested_max if requested_max is not None else defaults["max"]

    # Validate capacity values
    target_min = validate_capacity(target_min, "minimum")
    target_max = validate_capacity(target_max, "maximum")

    # Ensure max >= min
    if target_max < target_min:
        logger.warning(
            f"Max capacity ({target_max}) < min capacity ({target_min}). "
            f"Adjusting max to match min."
        )
        target_max = target_min

    logger.info(f"Target capacity determined: {target_min}-{target_max} ACU")
    return target_min, target_max


def validate_capacity(capacity: float, capacity_type: str) -> float:
    """
    Validate and adjust capacity value to allowed Aurora Serverless v2 values.

    Valid values: 0.5, 1, 1.5, 2, 2.5, ..., 128 (in 0.5 increments)
    """
    # Minimum is 0.5 ACU for Aurora Serverless v2
    if capacity < 0.5:
        logger.warning(f"Capacity {capacity} too low. Setting to minimum 0.5 ACU.")
        return 0.5

    # Maximum is 128 ACU for Aurora Serverless v2
    if capacity > 128:
        logger.warning(f"Capacity {capacity} too high. Setting to maximum 128 ACU.")
        return 128

    # Round to nearest 0.5
    rounded = round(capacity * 2) / 2

    if rounded != capacity:
        logger.info(
            f"Adjusted {capacity_type} capacity from {capacity} to {rounded} ACU "
            f"(must be in 0.5 increments)"
        )

    return rounded


def apply_scaling(
    target_min: float,
    target_max: float,
    reason: str,
    current_config: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Apply the scaling configuration to the Aurora cluster.

    Args:
        target_min: Target minimum capacity
        target_max: Target maximum capacity
        reason: Reason for scaling
        current_config: Current cluster configuration

    Returns:
        Dict with scaling result details
    """
    try:
        logger.info(
            f"Applying scaling: {current_config['minCapacity']}-{current_config['maxCapacity']} ACU "
            f"-> {target_min}-{target_max} ACU. Reason: {reason}"
        )

        rds.modify_db_cluster(
            DBClusterIdentifier=CLUSTER_ID,
            ServerlessV2ScalingConfiguration={
                "MinCapacity": target_min,
                "MaxCapacity": target_max,
            },
            ApplyImmediately=True,
        )

        logger.info("Scaling applied successfully")

        return {
            "success": True,
            "previousMin": current_config["minCapacity"],
            "previousMax": current_config["maxCapacity"],
            "newMin": target_min,
            "newMax": target_max,
        }

    except Exception as e:
        logger.error(f"Error applying scaling: {str(e)}")
        raise


def calculate_cost_impact(
    current_config: Dict[str, Any],
    new_min: float,
    new_max: float,
) -> Dict[str, Any]:
    """
    Calculate the cost impact of the scaling change.

    Aurora Serverless v2 pricing: ~$0.12 per ACU-hour
    """
    ACU_HOURLY_COST = 0.12

    current_min = current_config["minCapacity"]
    current_max = current_config["maxCapacity"]

    # Calculate minimum cost impact (assuming cluster runs at minimum most of the time)
    current_min_cost_hourly = current_min * ACU_HOURLY_COST
    new_min_cost_hourly = new_min * ACU_HOURLY_COST

    hourly_savings = current_min_cost_hourly - new_min_cost_hourly
    daily_savings = hourly_savings * 24
    monthly_savings = daily_savings * 30

    return {
        "currentMinCostHourly": round(current_min_cost_hourly, 4),
        "newMinCostHourly": round(new_min_cost_hourly, 4),
        "hourlySavings": round(hourly_savings, 4),
        "dailySavings": round(daily_savings, 2),
        "monthlySavings": round(monthly_savings, 2),
        "direction": "savings" if hourly_savings > 0 else "increase",
    }
