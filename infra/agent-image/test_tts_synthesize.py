"""Regression tests for psd-tts's OpenClaw exec-to-root-relay boundary."""

import importlib.util
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import subprocess
import sys
import threading
import unittest
from unittest import mock


SCRIPT = (
    Path(__file__).parent
    / "skills"
    / "psd-tts"
    / "scripts"
    / "synthesize.py"
)
SPEC = importlib.util.spec_from_file_location("psd_tts_synthesize", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("unable to load psd-tts synthesize module")
synthesize_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(synthesize_module)


class _Headers:
    @staticmethod
    def get_content_type():
        return "audio/mpeg"


class _Response:
    def __init__(self, body):
        self._body = body
        self._offset = 0
        self.headers = _Headers()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, amount):
        chunk = self._body[self._offset : self._offset + amount]
        self._offset += len(chunk)
        return chunk


class TestTtsCredentialBoundary(unittest.TestCase):
    def test_sanitized_exec_subprocess_reaches_fixed_operation_relay(self):
        requests = []

        class RelayHandler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers["Content-Length"])
                requests.append({
                    "path": self.path,
                    "payload": json.loads(self.rfile.read(length)),
                })
                body = b"synthetic-mp3"
                self.send_response(200)
                self.send_header("Content-Type", "audio/mpeg")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), RelayHandler)
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        relay_url = (
            f"http://127.0.0.1:{server.server_address[1]}"
            "/aws-skill/polly/synthesize"
        )
        child_code = """
import importlib.util
import pathlib
import sys

script = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("subprocess_tts", script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.POLLY_RELAY_URL = sys.argv[2]
audio, chunks = module.synthesize("Synthetic canary", "Ruth", "generative")
print(f"{audio.hex()}:{chunks}")
"""
        credential_keys = {
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_SESSION_TOKEN",
            "AWS_CONTAINER_CREDENTIALS_FULL_URI",
            "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
        }
        clean_env = {
            key: value
            for key, value in os.environ.items()
            if key not in credential_keys
        }
        try:
            result = subprocess.run(
                [sys.executable, "-c", child_code, str(SCRIPT), relay_url],
                check=True,
                capture_output=True,
                text=True,
                timeout=10,
                env=clean_env,
            )
        finally:
            server.shutdown()
            server.server_close()
            server_thread.join(timeout=5)

        self.assertEqual(result.stdout.strip(), "73796e7468657469632d6d7033:1")
        self.assertEqual(
            requests,
            [{
                "path": "/aws-skill/polly/synthesize",
                "payload": {
                    "text": "Synthetic canary",
                    "voice": "Ruth",
                    "engine": "generative",
                },
            }],
        )

    def test_exec_subprocess_needs_no_aws_credential_environment(self):
        credential_keys = (
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_SESSION_TOKEN",
            "AWS_CONTAINER_CREDENTIALS_FULL_URI",
            "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
        )
        clean_env = {
            key: value
            for key, value in os.environ.items()
            if key not in credential_keys
        }
        calls = []

        def relay(text, voice, engine):
            calls.append((text, voice, engine))
            return b"mp3"

        with mock.patch.dict(os.environ, clean_env, clear=True):
            audio, chunks = synthesize_module.synthesize(
                "First sentence. Second sentence.",
                "Ruth",
                "generative",
                synthesize_chunk=relay,
            )

        self.assertEqual(audio, b"mp3")
        self.assertEqual(chunks, 1)
        self.assertEqual(
            calls,
            [("First sentence. Second sentence.", "Ruth", "generative")],
        )

    def test_relay_request_contains_operation_inputs_but_no_credentials(self):
        response = _Response(b"synthetic-mp3")
        with mock.patch.object(
            synthesize_module.urllib.request,
            "urlopen",
            return_value=response,
        ) as urlopen:
            audio = synthesize_module._synthesize_chunk(
                "Synthetic canary",
                "Ruth",
                "generative",
            )

        self.assertEqual(audio, b"synthetic-mp3")
        request = urlopen.call_args.args[0]
        self.assertEqual(
            request.full_url,
            "http://127.0.0.1:18791/aws-skill/polly/synthesize",
        )
        body = request.data.decode("utf-8")
        self.assertIn('"text": "Synthetic canary"', body)
        self.assertNotIn("AWS_ACCESS_KEY_ID", body)
        self.assertNotIn("AWS_SECRET_ACCESS_KEY", body)
        self.assertNotIn("AWS_SESSION_TOKEN", body)

    def test_model_facing_script_does_not_import_an_aws_sdk(self):
        source = SCRIPT.read_text(encoding="utf-8")
        self.assertNotRegex(source, r"(?m)^\s*import boto3\b")
        self.assertNotRegex(source, r"(?m)^\s*from (?:boto3|botocore)\b")


if __name__ == "__main__":
    unittest.main()
