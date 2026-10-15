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

import codecs
import json
import os
import shutil
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

# A long line carrying many escapes that all sit inside a string literal, in a
# file that does NOT parse for an unrelated reason — so neither the quote
# pairing nor a parse can vindicate it. Genuinely unsure: exit 2, untouched.
AMBIGUOUS_PY = (
    "import sys\n"
    'MESSAGE = "alpha\\nbravo\\ncharlie\\ndelta\\necho\\nfoxtrot\\ngolf"\n'
    "def broken(\n"
)

# Healthy JS whose escapes are prose in a `//` comment. There is no JS parser
# to veto a bad repair, so the scanner itself has to know about comments.
HEALTHY_JS_LINE_COMMENT = (
    "// Reads records separated by \\n\\n\\n markers and writes a summary "
    "for staff each week\n"
    'const fs = require("fs");\n'
    'console.log("hello");\n'
)

# Healthy JS whose escape-rich lines sit inside a template literal and a
# `/* */` block that both OPEN ON AN EARLIER LINE. A line-at-a-time scan sees
# no quote on those lines and would call them collapsed.
HEALTHY_JS_MULTILINE = (
    "const TEMPLATE = `\n"
    "alpha\\nbravo\\ncharlie\\ndelta\\necho\\nfoxtrot\\ngolf\\nhotel\n"
    "`;\n"
    "/*\n"
    " * Records are separated by \\n\\n\\n markers in the legacy export "
    "format.\n"
    " */\n"
    "console.log(TEMPLATE);\n"
)

# Healthy JS using regex literals. Telling a regex from a division needs a
# real lexer — `/[/\n]/` ends its character class with the character that
# would close the literal — and guessing got this exact file rewritten. The
# scan now refuses instead, so the file must come back untouched.
HEALTHY_JS_REGEX = (
    "const cls = /[/\\n]/.test(a) || /[/\\n]/.test(b) || "
    "/[/\\n]/.test(c) || false;\n"
)

# Healthy JS with a template literal NESTED inside a `${...}` interpolation.
# A flat backtick toggle reads the inner backtick as closing the outer
# template, which put the text after it in code position and rewrote it.
HEALTHY_JS_NESTED_TEMPLATE = (
    "const x = `start ${`alpha\\nbravo\\ncharlie\\ndelta\\necho\\nfoxtrot`} "
    "end of it`;\n"
)

# Healthy JS whose interpolation is ordinary and whose template text mentions
# `\n` three times. The interpolation must not make this look collapsed.
HEALTHY_JS_INTERPOLATION = (
    "const msg = `Report for ${name} covering ${count} rows and "
    "\\n\\n\\n separators`;\n"
)

# A collapsed body hiding INSIDE an interpolation. `${...}` is code again, so
# this has to be found rather than written off as template text.
COLLAPSED_JS_IN_INTERPOLATION = (
    "const out = `${ (() => { const a = 1;\\nconst b = 2;\\n"
    "console.log(a + b);\\nreturn a; })() }`;\n"
)

# A genuinely collapsed JS file: the escapes are in code position, where a
# backslash cannot appear in working source.
COLLAPSED_JS = (
    'const fs = require("fs");\\nconst path = require("path");\\n'
    'console.log(fs.existsSync(path.join(".", "x")));\\nprocess.exit(0);\\n'
)

# A collapsed file in a language this tool does not model. Reported, never
# rewritten: `\n` in a `#` comment cannot be told from a collapsed break.
COLLAPSED_SHELL = (
    "#!/bin/bash\\nset -euo pipefail\\n"
    'echo "building the report"\\nexit 0\\n'
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
        verdict, _real, _literal, lines = rln.diagnose(AMBIGUOUS_PY, "m.py")
        self.assertEqual(verdict, "ambiguous")
        self.assertEqual(lines, [2])

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

    def test_a_js_line_comment_full_of_escapes_is_left_alone(self):
        self.assertEqual(
            rln.diagnose(HEALTHY_JS_LINE_COMMENT, "notes.js")[0], "clean")

    def test_js_lines_inside_a_template_or_block_comment_are_left_alone(self):
        self.assertEqual(
            rln.diagnose(HEALTHY_JS_MULTILINE, "t.ts")[0], "clean")

    def test_a_js_file_using_a_regex_literal_is_refused_not_guessed(self):
        self.assertEqual(
            rln.diagnose(HEALTHY_JS_REGEX, "r.js")[0], "ambiguous")

    def test_a_nested_template_literal_is_left_alone(self):
        self.assertEqual(
            rln.diagnose(HEALTHY_JS_NESTED_TEMPLATE, "n.js")[0], "clean")

    def test_template_text_around_an_interpolation_is_left_alone(self):
        self.assertEqual(
            rln.diagnose(HEALTHY_JS_INTERPOLATION, "i.js")[0], "clean")

    def test_a_collapsed_body_inside_an_interpolation_is_found(self):
        verdict, _real, _literal, lines = rln.diagnose(
            COLLAPSED_JS_IN_INTERPOLATION, "i.js")
        self.assertEqual(verdict, "broken")
        self.assertEqual(lines, [1])

    def test_collapsed_js_is_broken(self):
        verdict, _real, _literal, lines = rln.diagnose(COLLAPSED_JS, "b.js")
        self.assertEqual(verdict, "broken")
        self.assertEqual(lines, [1])

    def test_a_js_file_ending_inside_a_template_cannot_be_scanned(self):
        # The stream scan is unreliable, so it must not guess.
        text = "const T = `\nalpha\\nbravo\\ncharlie\\ndelta\\necho\n"
        self.assertEqual(rln.diagnose(text, "t.js")[0], "ambiguous")

    def test_an_unsupported_extension_is_reported_not_repaired(self):
        verdict, _real, _literal, lines = rln.diagnose(
            COLLAPSED_SHELL, "build.sh")
        self.assertEqual(verdict, "unsupported")
        self.assertEqual(lines, [1])

    def test_an_unsupported_extension_with_no_candidate_is_clean(self):
        self.assertEqual(rln.diagnose('echo "a\\nb"\n', "x.sh")[0], "clean")

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
        proc, content = self.run_on(AMBIGUOUS_PY)
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(content, AMBIGUOUS_PY)
        self.assertIn("ambiguous", proc.stderr)

    def test_the_output_says_which_lines_it_would_change(self):
        proc, content = self.run_on(MIXED, "--check")
        self.assertEqual(proc.returncode, 0)
        self.assertIn("broken", proc.stdout)
        self.assertIn("line(s) 3", proc.stdout)
        self.assertEqual(content, MIXED)

    def test_the_ambiguous_output_says_which_lines_it_declined(self):
        proc, _content = self.run_on(AMBIGUOUS_PY)
        self.assertIn("line(s) 2", proc.stderr)

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


class FileHandling(unittest.TestCase):
    """The on-disk contract: never leave a file worse than it arrived."""

    def write_temp(self, raw, suffix=".py"):
        with tempfile.NamedTemporaryFile("wb", suffix=suffix,
                                         delete=False) as fh:
            fh.write(raw)
            return fh.name

    def run_on_path(self, path, *extra):
        return subprocess.run([sys.executable, SCRIPT, path, *extra],
                              capture_output=True, text=True)

    def test_a_bom_does_not_disable_the_python_veto(self):
        # Reading as plain utf-8 leaves U+FEFF in the text, which makes
        # compile() fail, which silently switched off every Python
        # protection — and this healthy file was rewritten.
        raw = codecs.BOM_UTF8 + HEALTHY_DOCSTRING.encode("utf-8")
        path = self.write_temp(raw)
        try:
            proc = self.run_on_path(path)
            with open(path, "rb") as handle:
                self.assertEqual(handle.read(), raw)
            self.assertEqual(proc.returncode, 0)
            self.assertIn("clean", proc.stdout)
        finally:
            os.unlink(path)

    def test_a_bom_is_preserved_when_the_file_is_repaired(self):
        raw = codecs.BOM_UTF8 + COLLAPSED.encode("utf-8")
        path = self.write_temp(raw)
        try:
            proc = self.run_on_path(path)
            self.assertEqual(proc.returncode, 0)
            with open(path, "rb") as handle:
                fixed = handle.read()
            self.assertTrue(fixed.startswith(codecs.BOM_UTF8))
            compile(fixed.decode("utf-8-sig"), "<repaired>", "exec")
        finally:
            os.unlink(path)

    def test_the_executable_bit_survives_a_repair(self):
        path = self.write_temp(COLLAPSED_SHEBANG.encode("utf-8"))
        try:
            os.chmod(path, 0o755)
            proc = self.run_on_path(path)
            self.assertEqual(proc.returncode, 0)
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o755)
        finally:
            os.unlink(path)

    def test_a_repair_follows_a_symlink_instead_of_replacing_it(self):
        directory = tempfile.mkdtemp()
        try:
            real = os.path.join(directory, "real.py")
            link = os.path.join(directory, "link.py")
            with open(real, "w", encoding="utf-8") as handle:
                handle.write(COLLAPSED)
            os.symlink(real, link)
            proc = self.run_on_path(link)
            self.assertEqual(proc.returncode, 0)
            self.assertTrue(os.path.islink(link))
            with open(real, encoding="utf-8") as handle:
                compile(handle.read(), "<repaired>", "exec")
        finally:
            shutil.rmtree(directory)

    def test_a_non_utf8_file_exits_2_and_is_left_identical(self):
        raw = b"import sys\n# \xff\xfe not utf-8\nprint(1)\n"
        path = self.write_temp(raw)
        try:
            proc = self.run_on_path(path)
            self.assertEqual(proc.returncode, 2)
            self.assertIn("unreadable", proc.stderr)
            with open(path, "rb") as handle:
                self.assertEqual(handle.read(), raw)
        finally:
            os.unlink(path)

    def test_a_missing_path_exits_2_without_a_traceback(self):
        proc = self.run_on_path(os.path.join(tempfile.mkdtemp(), "nope.py"))
        self.assertEqual(proc.returncode, 2)
        self.assertIn("unreadable", proc.stderr)
        self.assertNotIn("Traceback", proc.stderr)

    def test_an_unwritable_directory_exits_2_and_keeps_the_original(self):
        directory = tempfile.mkdtemp()
        path = os.path.join(directory, "x.py")
        try:
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(COLLAPSED)
            os.chmod(directory, 0o555)
            proc = self.run_on_path(path)
            self.assertEqual(proc.returncode, 2)
            self.assertIn("unwritable", proc.stderr)
            self.assertNotIn("Traceback", proc.stderr)
            with open(path, encoding="utf-8") as handle:
                self.assertEqual(handle.read(), COLLAPSED)
            # No temp file was left behind next to it.
            os.chmod(directory, 0o755)
            self.assertEqual(os.listdir(directory), ["x.py"])
        finally:
            os.chmod(directory, 0o755)
            shutil.rmtree(directory)

    def test_an_empty_file_is_clean(self):
        path = self.write_temp(b"")
        try:
            proc = self.run_on_path(path)
            self.assertEqual(proc.returncode, 0)
            self.assertIn("clean", proc.stdout)
        finally:
            os.unlink(path)


class Languages(unittest.TestCase):
    """End-to-end per language, on the fixtures that used to be corrupted."""

    def run_on(self, text, suffix, *extra):
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

    def test_a_healthy_js_comment_file_is_left_identical(self):
        proc, content = self.run_on(HEALTHY_JS_LINE_COMMENT, ".js")
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(content, HEALTHY_JS_LINE_COMMENT)

    def test_a_healthy_js_multiline_file_is_left_identical(self):
        proc, content = self.run_on(HEALTHY_JS_MULTILINE, ".ts")
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(content, HEALTHY_JS_MULTILINE)

    def test_a_healthy_js_regex_file_is_left_identical(self):
        proc, content = self.run_on(HEALTHY_JS_REGEX, ".js")
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(content, HEALTHY_JS_REGEX)
        self.assertIn("regex", proc.stderr)

    def test_a_healthy_js_nested_template_file_is_left_identical(self):
        proc, content = self.run_on(HEALTHY_JS_NESTED_TEMPLATE, ".js")
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(content, HEALTHY_JS_NESTED_TEMPLATE)

    def test_a_collapsed_interpolation_body_is_repaired(self):
        proc, content = self.run_on(COLLAPSED_JS_IN_INTERPOLATION, ".js")
        self.assertEqual(proc.returncode, 0)
        self.assertIn("repaired", proc.stdout)
        self.assertIn("const b = 2;\n", content)

    def test_a_collapsed_js_file_is_repaired(self):
        proc, content = self.run_on(COLLAPSED_JS, ".js")
        self.assertEqual(proc.returncode, 0)
        self.assertIn("repaired", proc.stdout)
        self.assertIn('const fs = require("fs");\n', content)
        self.assertNotIn("\\n", content)

    def test_a_collapsed_shell_file_is_reported_but_not_touched(self):
        proc, content = self.run_on(COLLAPSED_SHELL, ".sh")
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(content, COLLAPSED_SHELL)
        self.assertIn("unsupported", proc.stderr)
        self.assertIn("line(s) 1", proc.stderr)

    def test_collapsed_json_is_repaired_into_valid_json(self):
        collapsed = (
            '{\\n  "name": "report",\\n  "rows": 12,\\n'
            '  "owner": "someone"\\n}\\n'
        )
        proc, content = self.run_on(collapsed, ".json")
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(json.loads(content)["name"], "report")

    def test_valid_json_is_left_identical(self):
        original = '{"note": "alpha\\nbravo\\ncharlie\\ndelta\\necho\\nfox"}\n'
        proc, content = self.run_on(original, ".json")
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(content, original)


if __name__ == "__main__":
    unittest.main()
