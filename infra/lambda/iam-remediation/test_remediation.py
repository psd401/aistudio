"""Regression tests for trust-policy-specific IAM remediation."""

import importlib
import os
import sys
import types
import unittest
from unittest.mock import MagicMock


os.environ.setdefault("ANALYZER_ARN", "arn:aws:access-analyzer:us-east-1:123:analyzer/test")
os.environ.setdefault("SNS_TOPIC_ARN", "arn:aws:sns:us-east-1:123:test")
os.environ.setdefault("ENVIRONMENT", "dev")

CLIENTS = {
    name: MagicMock(name=f"{name}_client")
    for name in ("access-analyzer", "iam", "s3", "sns", "cloudwatch")
}
fake_boto3 = types.ModuleType("boto3")
fake_boto3.client = lambda name: CLIENTS[name]
sys.modules["boto3"] = fake_boto3

remediation = importlib.import_module("remediation")


class IamTrustRemediationTests(unittest.TestCase):
    def setUp(self):
        for client in CLIENTS.values():
            client.reset_mock()
        remediation.ENVIRONMENT = "dev"
        CLIENTS["iam"].get_role.return_value = {
            "Role": {
                "Tags": [
                    {"Key": "ManagedBy", "Value": "BaseIAMRole"},
                    {"Key": "Environment", "Value": "dev"},
                ],
                "AssumeRolePolicyDocument": {
                    "Version": "2012-10-17",
                    "Statement": [
                        {
                            "Sid": "PublicTrust",
                            "Effect": "Allow",
                            "Principal": {"AWS": "*"},
                            "Action": "sts:AssumeRole",
                        },
                        {
                            "Sid": "ServiceTrust",
                            "Effect": "Allow",
                            "Principal": {"Service": "lambda.amazonaws.com"},
                            "Action": "sts:AssumeRole",
                        },
                    ],
                },
            }
        }

    @staticmethod
    def finding():
        return {
            "id": "finding-1",
            "resourceType": "AWS::IAM::Role",
            "resource": "arn:aws:iam::123:role/test-role",
            "principal": {"AWS": "*"},
            "status": "ACTIVE",
        }

    def test_repairs_only_the_offending_trust_statement(self):
        CLIENTS["access-analyzer"].list_findings.return_value = {
            "findings": [{**self.finding(), "status": "ACTIVE"}]
        }

        result = remediation.remediate_iam_role(self.finding())

        self.assertFalse(result["success"])
        self.assertIn("verification is pending", result["reason"])
        CLIENTS["iam"].update_assume_role_policy.assert_called_once()
        update = CLIENTS["iam"].update_assume_role_policy.call_args.kwargs
        self.assertEqual(update["RoleName"], "test-role")
        self.assertNotIn("PublicTrust", update["PolicyDocument"])
        self.assertIn("ServiceTrust", update["PolicyDocument"])
        CLIENTS["iam"].delete_role_policy.assert_not_called()

    def test_reports_success_only_after_fresh_analyzer_resolution(self):
        CLIENTS["access-analyzer"].list_findings.return_value = {
            "findings": [{**self.finding(), "status": "RESOLVED"}]
        }

        result = remediation.remediate_iam_role(self.finding())

        self.assertTrue(result["success"])
        self.assertIn("verified resolution", result["action"])
        CLIENTS["access-analyzer"].list_findings.assert_called_once()

    def test_refuses_to_modify_an_unmatched_or_sole_trust(self):
        role = CLIENTS["iam"].get_role.return_value["Role"]
        role["AssumeRolePolicyDocument"]["Statement"] = [
            {
                "Effect": "Allow",
                "Principal": {"Service": "lambda.amazonaws.com"},
                "Action": "sts:AssumeRole",
            }
        ]

        result = remediation.remediate_iam_role(self.finding())

        self.assertFalse(result["success"])
        self.assertIn("not found exactly", result["reason"])
        CLIENTS["iam"].update_assume_role_policy.assert_not_called()


if __name__ == "__main__":
    unittest.main()
