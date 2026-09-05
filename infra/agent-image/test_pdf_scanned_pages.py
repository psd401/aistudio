"""psd-pdf-to-markdown: scanned / image-only PDFs must not be a dead end.

A user handed the agent a scanned, image-only PDF. The converter returned a bare
`empty_output` reading "OCR is not enabled in v1" — accurate, unactionable, and
the turn ended there with nothing delivered.

There is no OCR engine in the agent image and there cannot be one: the AgentCore
overlay-mount snapshotter will not carry that native stack (see
infra/agent-image/Dockerfile). But the MODEL reading the output is multimodal, so
rendering the pages IS the OCR answer. These tests pin that:

  * an image-only PDF is DIAGNOSED, not just reported empty;
  * the refusal names the exact re-run command;
  * with --rasterize-pages it is a SUCCESS carrying readable page images;
  * a normal text PDF is completely unaffected.

Skipped when PyMuPDF is unavailable locally; it is always present in the image
(requirements-agentcore.txt pins pymupdf==1.28.0).
"""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = (
    Path(__file__).parent
    / "skills"
    / "psd-pdf-to-markdown"
    / "scripts"
    / "convert.py"
)

try:  # pragma: no cover - environment probe
    import pymupdf  # noqa: F401

    HAVE_PYMUPDF = True
except Exception:  # noqa: BLE001
    HAVE_PYMUPDF = False

try:  # pragma: no cover - environment probe
    import pymupdf4llm  # noqa: F401

    HAVE_PYMUPDF4LLM = True
except Exception:  # noqa: BLE001
    HAVE_PYMUPDF4LLM = False


def _load_convert():
    spec = importlib.util.spec_from_file_location("psd_pdf_convert", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load convert.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write_text_pdf(path: Path, pages: int = 2) -> None:
    import pymupdf

    document = pymupdf.open()
    for index in range(pages):
        page = document.new_page()
        page.insert_text((72, 100), f"Board Memo page {index + 1}", fontsize=18)
        page.insert_text(
            (72, 140), "Enrollment held steady across all buildings.", fontsize=11
        )
    document.save(str(path))
    document.close()


def _write_scanned_pdf(path: Path, source: Path) -> None:
    """Render `source`'s pages to pixmaps and place ONLY those on fresh pages.

    The result carries no text layer at all — exactly what a document scanner
    produces, and what the original failure was about.
    """
    import pymupdf

    original = pymupdf.open(str(source))
    scan = pymupdf.open()
    for index in range(original.page_count):
        pixmap = original[index].get_pixmap(dpi=120)
        page = scan.new_page(width=pixmap.width, height=pixmap.height)
        page.insert_image(
            pymupdf.Rect(0, 0, pixmap.width, pixmap.height), pixmap=pixmap
        )
    scan.save(str(path))
    scan.close()
    original.close()


@unittest.skipUnless(HAVE_PYMUPDF, "PyMuPDF is not installed in this environment")
class TextLayerDiagnosisTests(unittest.TestCase):
    """diagnose_text_layer separates a scan from a text PDF."""

    def setUp(self):
        self.convert = _load_convert()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.text_pdf = self.root / "text.pdf"
        self.scan_pdf = self.root / "scan.pdf"
        _write_text_pdf(self.text_pdf)
        _write_scanned_pdf(self.scan_pdf, self.text_pdf)

    def test_a_text_pdf_is_not_reported_as_image_only(self):
        diagnosis = self.convert.diagnose_text_layer(self.text_pdf)
        self.assertEqual(diagnosis["pages"], 2)
        self.assertEqual(diagnosis["pages_with_text"], 2)
        self.assertFalse(diagnosis["image_only"])

    def test_a_scan_is_reported_as_image_only(self):
        diagnosis = self.convert.diagnose_text_layer(self.scan_pdf)
        self.assertEqual(diagnosis["pages"], 2)
        self.assertEqual(diagnosis["pages_with_text"], 0)
        self.assertEqual(diagnosis["pages_with_images"], 2)
        self.assertTrue(diagnosis["image_only"])

    def test_a_page_selection_narrows_the_diagnosis(self):
        diagnosis = self.convert.diagnose_text_layer(self.scan_pdf, [1])
        self.assertEqual(diagnosis["pages"], 1)
        self.assertTrue(diagnosis["image_only"])

    def test_an_out_of_range_page_is_ignored_rather_than_crashing(self):
        diagnosis = self.convert.diagnose_text_layer(self.scan_pdf, [0, 99, -4])
        self.assertEqual(diagnosis["pages"], 1)

    def test_rasterizing_writes_one_png_per_page_in_page_order(self):
        out = self.root / "pages"
        out.mkdir()
        written, dropped = self.convert.rasterize_pages(self.scan_pdf, out)
        self.assertEqual(dropped, 0)
        self.assertEqual([p.name for p in written], ["page-0001.png", "page-0002.png"])
        for page in written:
            # A real render, not a zero-byte placeholder.
            self.assertGreater(page.stat().st_size, 1000)
            self.assertEqual(page.read_bytes()[:8], b"\x89PNG\r\n\x1a\n")

    def test_rasterizing_is_bounded(self):
        out = self.root / "capped"
        out.mkdir()
        original_cap = self.convert.MAX_RASTERIZED_PAGES
        self.convert.MAX_RASTERIZED_PAGES = 1
        try:
            written, dropped = self.convert.rasterize_pages(self.scan_pdf, out)
        finally:
            self.convert.MAX_RASTERIZED_PAGES = original_cap
        self.assertEqual(len(written), 1)
        self.assertEqual(dropped, 1)

    def test_a_page_selection_is_honoured_and_keeps_original_numbering(self):
        out = self.root / "selected"
        out.mkdir()
        written, _dropped = self.convert.rasterize_pages(self.scan_pdf, out, [1])
        # 0-based selection, 1-based filename: page index 1 is "page-0002".
        self.assertEqual([p.name for p in written], ["page-0002.png"])


@unittest.skipUnless(
    HAVE_PYMUPDF and HAVE_PYMUPDF4LLM,
    "PyMuPDF/pymupdf4llm are not installed in this environment",
)
class ScannedPdfCliTests(unittest.TestCase):
    """The CLI contract a caller actually sees."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.text_pdf = self.root / "text.pdf"
        self.scan_pdf = self.root / "scan.pdf"
        _write_text_pdf(self.text_pdf)
        _write_scanned_pdf(self.scan_pdf, self.text_pdf)

    def run_cli(self, *args):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            capture_output=True,
            text=True,
            check=False,
        )
        payload = None
        for line in reversed(result.stdout.strip().splitlines()):
            try:
                payload = json.loads(line)
                break
            except ValueError:
                continue
        return result.returncode, payload

    def test_a_scan_without_rasterize_says_exactly_what_to_run(self):
        code, payload = self.run_cli("--path", str(self.scan_pdf))
        self.assertEqual(code, 1)
        self.assertEqual(payload["error"], "scanned_pdf")
        # Diagnosis, not a shrug.
        self.assertIn("All 2 page(s) are images with no text layer", payload["message"])
        # And the exact command that resolves it.
        self.assertIn("--rasterize-pages", payload["message"])
        self.assertIn(str(self.scan_pdf), payload["message"])

    def test_a_scan_with_rasterize_succeeds_and_says_to_read_the_images(self):
        out = self.root / "pages"
        code, payload = self.run_cli(
            "--path", str(self.scan_pdf), "--rasterize-pages", str(out)
        )
        self.assertEqual(code, 0)
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["text_layer"], "none")
        self.assertEqual(len(payload["pages_rendered"]), 2)
        for rendered in payload["pages_rendered"]:
            self.assertTrue(Path(rendered).is_file())
        # The note must tell the reader to READ the pages — the whole failure
        # was an agent reporting "could not be processed" and stopping.
        self.assertIn("READ THEM", payload["note"])
        self.assertIn(
            "Do not report that the document could not be processed", payload["note"]
        )

    def test_a_normal_text_pdf_is_unaffected(self):
        code, payload = self.run_cli("--path", str(self.text_pdf))
        self.assertEqual(code, 0)
        self.assertEqual(payload["status"], "ok")
        self.assertIn("Board Memo page 1", payload["markdown"])
        self.assertNotIn("pages_rendered", payload)

    def test_a_text_pdf_can_have_both_markdown_and_page_images(self):
        out = self.root / "both-pages"
        code, payload = self.run_cli(
            "--path", str(self.text_pdf), "--rasterize-pages", str(out)
        )
        self.assertEqual(code, 0)
        self.assertIn("Board Memo page 1", payload["markdown"])
        self.assertEqual(len(payload["pages_rendered"]), 2)

    def test_the_rasterize_directory_must_be_empty(self):
        out = self.root / "used"
        out.mkdir()
        (out / "leftover.png").write_bytes(b"x")
        code, payload = self.run_cli(
            "--path", str(self.text_pdf), "--rasterize-pages", str(out)
        )
        self.assertEqual(code, 1)
        self.assertIn("must be empty", payload["message"])

    def test_page_renders_and_embedded_images_cannot_share_a_directory(self):
        shared = self.root / "shared"
        code, payload = self.run_cli(
            "--path",
            str(self.text_pdf),
            "--rasterize-pages",
            str(shared),
            "--extract-images",
            str(shared),
        )
        self.assertEqual(code, 1)
        self.assertEqual(payload["error"], "bad_args")
        self.assertIn("different", payload["message"])

    def test_the_shared_directory_check_resolves_both_paths_first(self):
        """Two spellings of ONE directory must still collide.

        Comparing the raw arguments passes whenever the spellings differ but the
        directory is the same — on macOS `/var/x` and `/private/var/x` are one
        directory — and the result then lists every page render twice: once as a
        page, once as an "embedded image" it never was.
        """
        shared = self.root / "shared-alias"
        alias = Path(str(shared).replace("/var/", "/private/var/", 1))
        if alias == shared:
            self.skipTest("no symlinked temp root on this platform")
        code, payload = self.run_cli(
            "--path",
            str(self.text_pdf),
            "--rasterize-pages",
            str(shared),
            "--extract-images",
            str(alias),
        )
        self.assertEqual(code, 1)
        self.assertEqual(payload["error"], "bad_args")


if __name__ == "__main__":
    unittest.main()
