import io
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))

import artifact_publisher  # noqa: E402


class _Response(io.BytesIO):
    def __init__(self, body=b"", length=None):
        super().__init__(body)
        self.headers = {}
        if length is not None:
            self.headers["Content-Length"] = str(length)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class ArtifactPublisherBoundsTests(unittest.TestCase):
    def setUp(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        self.root = Path(root)

    def test_exact_bounded_download(self):
        destination = self.root / "artifact.pdf"
        with mock.patch.object(
            artifact_publisher,
            "_broker",
            return_value={
                "downloadUrl": "https://download.invalid/x",
                "contentLength": 4,
                "requiredHeaders": {"Range": "bytes=0-3"},
            },
        ), mock.patch.object(
            artifact_publisher.urllib.request,
            "urlopen",
            return_value=_Response(b"%PDF", 4),
        ):
            artifact_publisher.download_public_artifact(
                "public-images/x/a.pdf", destination, 4
            )
        self.assertEqual(destination.read_bytes(), b"%PDF")

    def test_one_over_is_rejected_and_partial_file_removed(self):
        destination = self.root / "artifact.pdf"
        with mock.patch.object(
            artifact_publisher,
            "_broker",
            return_value={
                "downloadUrl": "https://download.invalid/x",
                "contentLength": 4,
                "requiredHeaders": {"Range": "bytes=0-3"},
            },
        ), mock.patch.object(
            artifact_publisher.urllib.request,
            "urlopen",
            return_value=_Response(b"12345"),
        ):
            with self.assertRaisesRegex(RuntimeError, "exceeds"):
                artifact_publisher.download_public_artifact(
                    "public-images/x/a.pdf", destination, 4
                )
        self.assertFalse(destination.exists())

    def test_declared_oversize_fails_before_network_read(self):
        destination = self.root / "artifact.pdf"
        network = mock.Mock()
        with mock.patch.object(
            artifact_publisher,
            "_broker",
            return_value={
                "downloadUrl": "https://download.invalid/x",
                "contentLength": 5,
                "requiredHeaders": {"Range": "bytes=0-4"},
            },
        ), mock.patch.object(
            artifact_publisher.urllib.request, "urlopen", network
        ):
            with self.assertRaisesRegex(RuntimeError, "invalid bounded"):
                artifact_publisher.download_public_artifact(
                    "public-images/x/a.pdf", destination, 4
                )
        network.assert_not_called()

    def test_publish_waits_for_trusted_completion(self):
        calls = []

        def broker(payload):
            calls.append(payload)
            if payload["operation"] == "publish":
                return {
                    "uploadUrl": "https://upload.invalid/x",
                    "reservationId": "reservation",
                    "requiredHeaders": {
                        "Content-Length": "4",
                        "Content-Type": "application/pdf",
                        "x-amz-checksum-sha256":
                            "MV1Cm3cUzttq0ErDEkAUUldpJjBFfzyIJTxb7OrHYCc=",
                    },
                }
            return {
                "publicUrl": "https://public.invalid/a.pdf",
                "key": "public-images/x/a.pdf",
            }

        with mock.patch.object(
            artifact_publisher, "_broker", side_effect=broker
        ), mock.patch.object(
            artifact_publisher.urllib.request,
            "urlopen",
            return_value=_Response(),
        ):
            result = artifact_publisher.publish_artifact(
                b"%PDF", ".pdf", "application/pdf"
            )
        self.assertEqual(result[1], "public-images/x/a.pdf")
        self.assertEqual(calls[0]["contentLength"], 4)
        self.assertEqual(calls[1], {
            "operation": "complete-upload",
            "reservationId": "reservation",
        })


class DriveDeliveryTests(unittest.TestCase):
    """#2034: the private default. Same staged upload, Drive ending."""

    CHECKSUM = "MV1Cm3cUzttq0ErDEkAUUldpJjBFfzyIJTxb7OrHYCc="

    def _broker(self, calls, delivered):
        def broker(payload, timeout=20):
            calls.append((payload, timeout))
            if payload["operation"] == "drive-upload":
                return {
                    "uploadUrl": "https://upload.invalid/x",
                    "reservationId": "reservation",
                    "requiredHeaders": {
                        "Content-Length": "4",
                        "Content-Type": "audio/mpeg",
                        "x-amz-checksum-sha256": self.CHECKSUM,
                    },
                }
            return delivered
        return broker

    def test_stages_as_drive_upload_and_delivers_with_the_long_timeout(self):
        calls = []
        delivered = {
            "fileId": "file-1",
            "webViewLink": "https://drive.invalid/file-1",
            "sharedWith": "owner@psd401.net",
            "fileName": "Brief.mp3",
        }
        with mock.patch.object(
            artifact_publisher, "_broker", side_effect=self._broker(calls, delivered)
        ), mock.patch.object(
            artifact_publisher.urllib.request, "urlopen", return_value=_Response()
        ):
            result = artifact_publisher.deliver_to_drive(
                b"%PDF", "Brief.mp3", "audio/mpeg"
            )
        self.assertEqual(result["webViewLink"], "https://drive.invalid/file-1")
        self.assertEqual(calls[0][0]["operation"], "drive-upload")
        self.assertEqual(calls[0][0]["path"], "Brief.mp3")
        self.assertEqual(
            calls[1],
            (
                {"operation": "deliver-to-drive", "reservationId": "reservation"},
                artifact_publisher.DRIVE_DELIVER_TIMEOUT_SECONDS,
            ),
        )
        # Never the public path.
        self.assertNotIn("publish", [c[0]["operation"] for c in calls])

    def test_an_unverified_delivery_raises(self):
        with mock.patch.object(
            artifact_publisher,
            "_broker",
            side_effect=self._broker([], {"fileId": "file-1"}),
        ), mock.patch.object(
            artifact_publisher.urllib.request, "urlopen", return_value=_Response()
        ):
            with self.assertRaisesRegex(RuntimeError, "verification"):
                artifact_publisher.deliver_to_drive(
                    b"%PDF", "Brief.mp3", "audio/mpeg"
                )

    def test_a_path_is_not_a_file_name(self):
        with self.assertRaises(ValueError):
            artifact_publisher.deliver_to_drive(b"x", "a/b.mp3", "audio/mpeg")

    def test_public_needs_the_confirmation_flag(self):
        self.assertTrue(artifact_publisher.public_needs_confirmation("public", False))
        self.assertFalse(artifact_publisher.public_needs_confirmation("public", True))
        self.assertFalse(artifact_publisher.public_needs_confirmation("drive", False))


if __name__ == "__main__":
    unittest.main()
