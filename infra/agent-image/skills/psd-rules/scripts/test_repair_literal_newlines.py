"""Tests for repair_literal_newlines.py — Rule 9a's missing third option.

Rule 9a's remedy was "rewrite it as a file", but the file IS what failed:
`write` produced the literal \\n. Rewriting reruns the tool that just broke it,
which is why the loop consumed whole turns. These pin the repair AND the
refusal to touch healthy code, because a corrupted working script is worse
than no repair.
"""

import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import repair_literal_newlines as rln  # noqa: E402

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "repair_literal_newlines.py")


class Diagnose(unittest.TestCase):
    def test_the_bug_signature_is_one_line_with_many_escapes(self):
        text = 'import json\\nimport sys\\nprint("hi")\\n'
        self.assertEqual(rln.diagnose(text)[0], "broken")

    def test_a_file_with_no_escapes_is_clean(self):
        self.assertEqual(rln.diagnose("import sys\nprint(1)\n")[0], "clean")

    def test_working_code_with_n_in_a_string_is_ambiguous_not_broken(self):
        # Rewriting this would corrupt a working script.
        text = 'import sys\nprint("a\\nb")\nsys.exit(0)\n'
        self.assertEqual(rln.diagnose(text)[0], "ambiguous")

    def test_a_single_escape_on_one_line_is_not_enough_to_fire(self):
        self.assertEqual(rln.diagnose('print("a\\nb")')[0], "ambiguous")


class Repair(unittest.TestCase):
    def test_literal_escapes_become_real_newlines(self):
        self.assertEqual(rln.repair('a\\nb'), "a\nb")

    def test_tabs_too(self):
        self.assertEqual(rln.repair('a\\tb'), "a\tb")

    def test_an_escaped_backslash_is_preserved(self):
        # `\\n` in the source is a deliberate literal, not a mangled break.
        self.assertEqual(rln.repair('a\\\\nb'), 'a\\\\nb')


class EndToEnd(unittest.TestCase):
    def run_on(self, text, *extra):
        with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as fh:
            fh.write(text)
            path = fh.name
        try:
            proc = subprocess.run([sys.executable, SCRIPT, path, *extra],
                                  capture_output=True, text=True)
            with open(path) as handle:
                return proc, handle.read()
        finally:
            os.unlink(path)

    def test_a_broken_file_becomes_runnable(self):
        proc, content = self.run_on('import sys\\nprint("ok")\\n')
        self.assertEqual(proc.returncode, 0)
        self.assertIn("repaired", proc.stdout)
        compile(content, "<repaired>", "exec")  # would raise if still broken

    def test_a_healthy_file_is_left_byte_identical(self):
        original = 'import sys\nprint("a\\nb")\nsys.exit(0)\n'
        proc, content = self.run_on(original)
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(content, original)
        self.assertIn("ambiguous", proc.stderr)

    def test_check_mode_reports_without_modifying(self):
        original = 'import sys\\nprint("ok")\\n'
        proc, content = self.run_on(original, "--check")
        self.assertEqual(proc.returncode, 0)
        self.assertIn("broken", proc.stdout)
        self.assertEqual(content, original)

    def test_repair_is_idempotent(self):
        proc, content = self.run_on('import sys\\nprint("ok")\\n')
        with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as fh:
            fh.write(content)
            path = fh.name
        try:
            again = subprocess.run([sys.executable, SCRIPT, path],
                                   capture_output=True, text=True)
            self.assertEqual(again.returncode, 0)
            self.assertIn("clean", again.stdout)
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main()
