r"""Tests for repair_literal_newlines.py — Rule 9a's missing third option.

Rule 9a's remedy was "rewrite it as a file", but the file IS what failed:
`write` produced the literal \n. Rewriting reruns the tool that just broke it,
which is why the loop consumed whole turns. These pin the repair AND the
refusal to touch healthy code, because a corrupted working script is worse
than no repair.

The diagnosis is line by line (issue #1896), because the real-world shape is
PARTIAL collapse — a few correct header lines then a body collapsed onto one
line. The old whole-file test ("2 or fewer real lines") called that ambiguous
and left ~37 people's files broken between 2026-09-25 and 2026-10-11.
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

# A whole file collapsed onto one line — the classic shape.
COLLAPSED = (
    'import sys\\nimport json\\n\\ndef main():\\n'
    '    print(json.dumps({"ok": True}))\\n    return 0\\n\\n'
    'if __name__ == "__main__":\\n    sys.exit(main())\\n'
)

# Correct header lines, then a body collapsed onto line 3. The old whole-file
# heuristic refused this; it is the most common real shape.
HEADER_PLUS_COLLAPSED = (
    "#!/usr/bin/env python3\n"
    "import sys\n"
    'def main():\\n    data = {"ok": True}\\n    print(data)\\n'
    '    return 0\\n\\nif __name__ == "__main__":\\n    sys.exit(main())\\n'
)

# Line 2 holds a legitimate `\n` inside a string literal; only line 3 is
# collapsed. Repairing line 2 would corrupt working code.
MIXED = (
    "import sys\n"
    'SEPARATOR = "alpha\\nbravo"\n'
    'def main():\\n    print(SEPARATOR)\\n    print("done")\\n'
    '    return 0\\n\\nsys.exit(main())\\n'
)

# A healthy Python file whose strings contain `\n`. It parses, so it is clean.
HEALTHY = 'import sys\nprint("a\\nb")\nsys.exit(0)\n'

# Collapsed AND shebang-first, with an apostrophe in the collapsed comment.
# This file parses — the whole thing is one comment — so a parse-first check
# calls it clean and leaves it broken. It is the most common real shape.
COLLAPSED_SHEBANG = (
    "#!/usr/bin/env python3\\n# don't rewrite this, repair it\\n"
    'import sys\\nprint("ok")\\nsys.exit(0)\\n'
)

# A healthy file whose escape-rich line sits INSIDE a triple-quoted string.
# The per-line scan cannot see the opening quote (it is on an earlier line), so
# only the tokeniser can tell this apart from a collapsed body. Repairing it
# would silently rewrite a working file's data.
HEALTHY_DOCSTRING = (
    "import sys\n"
    'DOC = """\n'
    "alpha\\nbravo\\ncharlie\\ndelta\\necho\\nfoxtrot\\ngolf\\nhotel\\nindia\n"
    '"""\n'
    "print(DOC)\nsys.exit(0)\n"
)

# A working line whose escapes really are prose in a comment. It parses now
# and would NOT parse after a repair, so the repair must be vetoed.
COMMENT_PROSE = (
    "import sys\n"
    "VALUE = 1  # the payload separates its records with \\n\\n\\n markers\n"
    "print(VALUE)\n"
)

# A long line carrying many escapes that all sit INSIDE a string literal, in a
# file that does not parse for an unrelated reason (and has no stdlib parser
# anyway). Genuinely unsure: exit 2, untouched.
AMBIGUOUS_JS = (
    'const MESSAGE = "alpha\\nbravo\\ncharlie\\ndelta\\necho\\nfoxtrot\\ngolf";\n'
    "function broken( {\n"
)


class Diagnose(unittest.TestCase):
    def test_the_bug_signature_is_one_line_with_many_escapes(self):
        self.assertEqual(rln.diagnose(COLLAPSED, "broken.py")[0], "broken")

    def test_a_file_with_no_escapes_is_clean(self):
        self.assertEqual(rln.diagnose("import sys\nprint(1)\n", "x.py")[0],
                         "clean")

    def test_working_code_with_n_in_a_string_is_clean(self):
        # Rewriting this would corrupt a working script. It parses, so the
        # escapes are string literals and there is nothing to repair.
        self.assertEqual(rln.diagnose(HEALTHY, "ok.py")[0], "clean")

    def test_a_single_escape_on_one_line_is_not_enough_to_fire(self):
        self.assertEqual(rln.diagnose('print("a\\nb")', "s.py")[0], "clean")

    def test_a_short_line_of_escapes_is_below_the_length_threshold(self):
        # Three escapes, but far too short to be a collapsed file.
        self.assertEqual(rln.diagnose('print("a\\nb\\nc\\nd")', "s.py")[0],
                         "clean")

    def test_a_header_plus_a_collapsed_body_is_repaired_on_that_line_only(self):
        verdict, _real, _literal, lines = rln.diagnose(
            HEADER_PLUS_COLLAPSED, "broken.py")
        self.assertEqual(verdict, "broken")
        self.assertEqual(lines, [3])

    def test_a_mixed_file_is_repaired_only_on_the_collapsed_lines(self):
        verdict, _real, _literal, lines = rln.diagnose(MIXED, "mixed.py")
        self.assertEqual(verdict, "broken")
        self.assertEqual(lines, [3])

    def test_escapes_inside_a_string_on_a_long_line_stay_ambiguous(self):
        verdict, _real, _literal, lines = rln.diagnose(AMBIGUOUS_JS, "m.js")
        self.assertEqual(verdict, "ambiguous")
        self.assertEqual(lines, [1])

    def test_a_collapsed_shebang_file_is_broken_even_though_it_parses(self):
        # It parses only because the collapsed line is one giant `#` comment.
        self.assertTrue(rln.parses_cleanly(COLLAPSED_SHEBANG, "python"))
        verdict, _real, _literal, lines = rln.diagnose(
            COLLAPSED_SHEBANG, "broken.py")
        self.assertEqual(verdict, "broken")
        self.assertEqual(lines, [1])

    def test_a_line_inside_a_triple_quoted_string_is_left_alone(self):
        self.assertEqual(rln.diagnose(HEALTHY_DOCSTRING, "ok.py")[0], "clean")

    def test_escapes_that_are_prose_in_a_comment_are_left_alone(self):
        # Repairing line 2 would turn working code into an IndentationError.
        self.assertEqual(rln.diagnose(COMMENT_PROSE, "ok.py")[0], "clean")

    def test_valid_json_is_clean_even_with_many_escapes(self):
        text = '{"note": "alpha\\nbravo\\ncharlie\\ndelta\\necho\\nfoxtrot"}\n'
        self.assertEqual(rln.diagnose(text, "d.json")[0], "clean")

    def test_collapsed_json_is_broken(self):
        text = (
            '{\\n  "name": "report",\\n  "rows": 12,\\n'
            '  "owner": "someone"\\n}\\n'
        )
        self.assertEqual(rln.diagnose(text, "d.json")[0], "broken")


class Repair(unittest.TestCase):
    def test_literal_escapes_become_real_newlines(self):
        self.assertEqual(rln.repair('a\\nb'), "a\nb")

    def test_tabs_too(self):
        self.assertEqual(rln.repair('a\\tb'), "a\tb")

    def test_an_escaped_backslash_is_preserved(self):
        # `\\n` in the source is a deliberate literal, not a mangled break.
        self.assertEqual(rln.repair('a\\\\nb'), 'a\\\\nb')

    def test_escaped_double_quotes_are_unescaped(self):
        # Double-escaping also mangles the quotes; leaving them would still
        # not parse.
        self.assertEqual(rln.repair('print(\\"hi\\")'), 'print("hi")')

    def test_escaped_single_quotes_are_unescaped(self):
        self.assertEqual(rln.repair("x = \\'a\\'"), "x = 'a'")

    def test_an_escape_inside_a_string_literal_is_left_alone(self):
        # The quotes pair up, so `\n` between them is a real string literal.
        self.assertEqual(rln.repair('x = "a\\nb"', "python"), 'x = "a\\nb"')

    def test_an_unknown_escape_is_left_alone(self):
        self.assertEqual(rln.repair(r"re.compile(r\d)"), r"re.compile(r\d)")


class EndToEnd(unittest.TestCase):
    def run_on(self, text, *extra, suffix=".py"):
        with tempfile.NamedTemporaryFile("w", suffix=suffix,
                                         delete=False) as fh:
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
        proc, content = self.run_on(COLLAPSED)
        self.assertEqual(proc.returncode, 0)
        self.assertIn("repaired", proc.stdout)
        compile(content, "<repaired>", "exec")  # would raise if still broken

    def test_a_header_plus_collapsed_body_becomes_runnable(self):
        proc, content = self.run_on(HEADER_PLUS_COLLAPSED)
        self.assertEqual(proc.returncode, 0)
        self.assertIn("repaired", proc.stdout)
        self.assertTrue(content.startswith("#!/usr/bin/env python3\nimport sys\n"))
        compile(content, "<repaired>", "exec")

    def test_a_mixed_file_keeps_its_real_string_escape(self):
        proc, content = self.run_on(MIXED)
        self.assertEqual(proc.returncode, 0)
        compile(content, "<repaired>", "exec")
        # The legitimate literal on line 2 survived the repair of line 3.
        self.assertIn('SEPARATOR = "alpha\\nbravo"', content)
        self.assertIn("    print(SEPARATOR)\n", content)

    def test_an_in_string_escape_on_a_repaired_line_survives(self):
        collapsed = (
            'import sys\\nimport os\\nSEP = "a\\nb"\\n'
            'print(SEP)\\nsys.exit(0)\\n'
        )
        proc, content = self.run_on(collapsed)
        self.assertEqual(proc.returncode, 0)
        compile(content, "<repaired>", "exec")
        self.assertIn('SEP = "a\\nb"\n', content)

    def test_a_collapsed_shebang_file_becomes_runnable(self):
        proc, content = self.run_on(COLLAPSED_SHEBANG)
        self.assertEqual(proc.returncode, 0)
        self.assertIn("repaired", proc.stdout)
        self.assertTrue(content.startswith("#!/usr/bin/env python3\n"))
        compile(content, "<repaired>", "exec")

    def test_a_healthy_docstring_file_is_left_byte_identical(self):
        proc, content = self.run_on(HEALTHY_DOCSTRING)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(content, HEALTHY_DOCSTRING)
        self.assertIn("clean", proc.stdout)

    def test_a_comment_whose_prose_contains_escapes_is_left_identical(self):
        proc, content = self.run_on(COMMENT_PROSE)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(content, COMMENT_PROSE)
        self.assertIn("clean", proc.stdout)

    def test_a_healthy_file_is_left_byte_identical(self):
        proc, content = self.run_on(HEALTHY)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(content, HEALTHY)
        self.assertIn("clean", proc.stdout)

    def test_an_ambiguous_file_is_left_byte_identical_and_exits_2(self):
        proc, content = self.run_on(AMBIGUOUS_JS, suffix=".js")
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(content, AMBIGUOUS_JS)
        self.assertIn("ambiguous", proc.stderr)

    def test_the_output_says_which_lines_it_would_change(self):
        proc, content = self.run_on(MIXED, "--check")
        self.assertEqual(proc.returncode, 0)
        self.assertIn("broken", proc.stdout)
        self.assertIn("line(s) 3", proc.stdout)
        self.assertEqual(content, MIXED)

    def test_the_ambiguous_output_says_which_lines_it_declined(self):
        proc, _content = self.run_on(AMBIGUOUS_JS, suffix=".js")
        self.assertIn("line(s) 1", proc.stderr)

    def test_check_mode_reports_without_modifying(self):
        proc, content = self.run_on(COLLAPSED, "--check")
        self.assertEqual(proc.returncode, 0)
        self.assertIn("broken", proc.stdout)
        self.assertEqual(content, COLLAPSED)

    def test_repair_is_idempotent(self):
        _proc, content = self.run_on(COLLAPSED)
        again, _content = self.run_on(content)
        self.assertEqual(again.returncode, 0)
        self.assertIn("clean", again.stdout)


if __name__ == "__main__":
    unittest.main()
