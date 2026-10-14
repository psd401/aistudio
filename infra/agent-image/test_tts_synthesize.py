"""Regression tests for psd-tts's OpenClaw exec-to-root-relay boundary."""

import contextlib
import importlib.util
import io
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
import pathlib
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


class TestNarrationPersonalDataGate(unittest.TestCase):
    """
    Issue #1886. Every MP3 this skill makes is uploaded public-by-link with no
    expiry, and seven morning-brief podcasts were found sitting on open URLs.
    Once the text is sound no later check can read it, so the refusal has to
    happen BEFORE synthesis — nothing sent to Polly, nothing uploaded.
    """

    def _run_main(self, text):
        """Drive main() with --text and return (exit_code, parsed stdout)."""
        argv = ["synthesize.py", "--user", "staff@psd401.net", "--text", text]
        synthesized = []
        uploaded = []
        buffer = io.StringIO()
        with mock.patch.object(sys, "argv", argv), \
                mock.patch.object(
                    synthesize_module,
                    "synthesize",
                    side_effect=lambda *a, **k: (
                        synthesized.append(a) or (b"mp3", 1)
                    ),
                ), \
                mock.patch.object(
                    synthesize_module,
                    "upload_mp3",
                    side_effect=lambda *a, **k: (
                        uploaded.append(a) or ("https://example.invalid/a.mp3", "k")
                    ),
                ), \
                mock.patch.object(
                    synthesize_module,
                    "_record_narration_refusal",
                ) as recorded, \
                contextlib.redirect_stdout(buffer):
            try:
                synthesize_module.main()
                code = 0
            except SystemExit as exc:
                code = exc.code
        return {
            "code": code,
            # Whole buffer: _emit() pretty-prints over several lines while
            # _fail() emits one. Both are the only thing the command writes.
            "stdout": json.loads(buffer.getvalue()),
            "synthesized": synthesized,
            "uploaded": uploaded,
            "recorded": recorded,
        }

    def test_a_staff_phone_number_is_refused_and_nothing_is_uploaded(self):
        result = self._run_main(
            "Good morning. Reach Mrs Hall on 253-555-0147 before Friday."
        )

        self.assertEqual(result["code"], 1)
        self.assertEqual(result["stdout"]["error"], "personal_data_detected")
        self.assertIn("us-phone", result["stdout"]["message"])
        # Refused BEFORE synthesis: no Polly call and no upload at all.
        self.assertEqual(result["synthesized"], [])
        self.assertEqual(result["uploaded"], [])
        # Counted, so the gate's false-positive rate is measurable.
        self.assertEqual(result["recorded"].call_count, 1)
        self.assertEqual(
            result["recorded"].call_args.args,
            ("staff@psd401.net", ["us-phone"]),
        )

    def test_the_refusal_names_the_kind_and_not_the_number(self):
        result = self._run_main("Call 253-555-0147 or email a.hall@psd401.net.")
        message = result["stdout"]["message"]
        self.assertNotIn("253-555-0147", message)
        self.assertNotIn("a.hall@psd401.net", message)

    def test_a_student_number_is_refused(self):
        result = self._run_main("Student 2240393 moves to third period.")
        self.assertEqual(result["stdout"]["error"], "personal_data_detected")
        self.assertIn("psd-student-id", result["stdout"]["message"])

    def test_an_ordinary_brief_still_synthesizes_and_uploads(self):
        result = self._run_main(
            "Good morning. Three meetings today and the board packet is ready."
        )
        self.assertEqual(result["code"], 0)
        self.assertEqual(result["stdout"]["status"], "ok")
        self.assertEqual(len(result["synthesized"]), 1)
        self.assertEqual(len(result["uploaded"]), 1)

    def test_the_gate_fails_closed_when_the_pattern_file_is_unavailable(self):
        # A missing pattern file means the IMAGE is broken, not that this text
        # is safe. Refusing is the only safe reading, and the ship test in
        # tests/unit/agent-image-personal-data-ship.test.ts is what keeps this
        # from ever being the live behaviour.
        with mock.patch.object(
            synthesize_module,
            "narration_personal_data",
            side_effect=RuntimeError("patterns missing"),
        ):
            result = self._run_main("Anything at all.")
        self.assertEqual(result["code"], 1)
        self.assertEqual(result["stdout"]["error"], "gate_unavailable")
        self.assertEqual(result["uploaded"], [])

    def test_the_narration_policy_is_stricter_than_the_public_file_policy(self):
        # The shared module, read directly: one contact detail is allowed in a
        # public FILE (a flyer footer) and never in narration.
        sys.path.insert(0, str(pathlib.Path(__file__).parent))
        from personal_data import (
            NARRATION_POLICY,
            PUBLIC_FILE_POLICY,
            personal_data_kinds,
        )

        flyer = "Open house Thursday. Questions? Call 253-530-1000."
        self.assertEqual(personal_data_kinds(flyer, PUBLIC_FILE_POLICY), [])
        self.assertEqual(
            personal_data_kinds(flyer, NARRATION_POLICY), ["us-phone"]
        )


if __name__ == "__main__":
    unittest.main()
