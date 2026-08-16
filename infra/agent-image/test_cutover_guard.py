"""The workspace-cutover guard must resolve BOTH ways a runtime can be pinned.

An AgentCore runtime carries either a digest reference
(`repo@sha256:...`) or a tag reference (`repo:2026-08-14-run-fence`),
depending on whether the deploy passed `agentImageDigest`. `deployed_commit`
in build-and-push.sh only handled the digest form: on a tag-pinned runtime the
`${uri##*@}` strip is a no-op, the whole URI went out as an `imageDigest`, the
ECR lookup failed, and the guard fell through to "could not determine the
deployed image's commit" and demanded a workspace drain.

dev is digest-pinned and prod is tag-pinned, so from 2026-08-03 every single
prod build raised a cutover that was not real, while dev never did. A guard
that cries wolf on every build of one environment is worse than no guard —
that is precisely the failure the commit which introduced this function set
out to fix ("it stopped being read").

The function is exercised directly, with `aws` and `git` stubbed on PATH, so
these tests pin the shell that actually ships rather than a transcription of
it.
"""

import os
import pathlib
import shutil
import subprocess
import tempfile
import textwrap
import unittest

SCRIPT = pathlib.Path(__file__).with_name("build-and-push.sh")

DIGEST = "sha256:5deea07c297d674a57e2eed10894574f7aa7a1e482e114557b281c696665d78f"
REPO = "390844780692.dkr.ecr.us-east-1.amazonaws.com/psd-agent-base-prod"


def _extract_function() -> str:
    """The real deployed_commit(), lifted verbatim from the shipped script."""
    lines = SCRIPT.read_text().splitlines()
    start = next(
        i for i, line in enumerate(lines) if line.startswith("deployed_commit() {")
    )
    end = next(i for i in range(start, len(lines)) if lines[i] == "}")
    return "\n".join(lines[start:end + 1])


class DeployedCommitResolvesEitherPinning(unittest.TestCase):
    def _run(self, container_uri, tags="commit-9c271a21bbfb 2026-08-14-run-fence"):
        """Run deployed_commit() against a stubbed AWS/git, return (rc, stdout)."""
        work = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, work)
        binaries = pathlib.Path(work, "bin")
        binaries.mkdir()

        # `aws` answers the three calls the function makes, and — critically —
        # FAILS on an image-id it does not recognize, the way the real API does
        # when handed a whole URI as a digest.
        (binaries / "aws").write_text(textwrap.dedent(f"""\
            #!/usr/bin/env bash
            case "$*" in
              *describe-stacks*) echo "psd_agent-ABC123" ;;
              *get-agent-runtime*) echo "{container_uri}" ;;
              *describe-images*)
                case "$*" in
                  *"imageDigest={DIGEST}"*|*"imageTag=2026-08-14-run-fence"*)
                    echo "{tags}" ;;
                  *) echo "An error occurred: InvalidParameterException" >&2; exit 254 ;;
                esac ;;
              *) exit 1 ;;
            esac
        """))
        # `git cat-file -e` validates the sha exists locally; accept it.
        (binaries / "git").write_text("#!/usr/bin/env bash\nexit 0\n")
        for stub in ("aws", "git"):
            (binaries / stub).chmod(0o755)

        script = "\n".join([
            "set -uo pipefail",
            'REGION=us-east-1',
            'REPO_ROOT=/tmp',
            'STACK_NAME=AIStudio-AgentPlatformStack-Prod',
            f'ECR_URI="{REPO}"',
            _extract_function(),
            "deployed_commit",
        ])
        env = dict(os.environ, PATH=f"{binaries}:{os.environ['PATH']}")
        done = subprocess.run(
            ["bash", "-c", script], capture_output=True, text=True, env=env
        )
        return done.returncode, done.stdout.strip()

    def test_a_digest_pinned_runtime_resolves(self):
        rc, sha = self._run(f"{REPO}@{DIGEST}")
        self.assertEqual(rc, 0)
        self.assertEqual(sha, "9c271a21bbfb")

    def test_a_tag_pinned_runtime_resolves(self):
        # The prod case. This returned non-zero for thirteen days, which the
        # guard reported as "cutover required".
        rc, sha = self._run(f"{REPO}:2026-08-14-run-fence")
        self.assertEqual(rc, 0, "a tag-pinned runtime must not read as unknown")
        self.assertEqual(sha, "9c271a21bbfb")

    def test_an_unparseable_reference_still_fails_closed(self):
        # Failing closed is right when we genuinely cannot tell; the bug was
        # reaching that branch for a reference we could have read.
        rc, _ = self._run("psd-agent-base-prod")
        self.assertNotEqual(rc, 0)

    def test_an_image_with_no_commit_tag_falls_back_to_the_trailing_sha(self):
        rc, sha = self._run(f"{REPO}:2026-08-14-run-fence", tags="2026-08-14-9c271a21bbfb")
        self.assertEqual(rc, 0)
        self.assertEqual(sha, "9c271a21bbfb")

    def test_an_image_with_no_usable_tag_fails_closed(self):
        rc, _ = self._run(f"{REPO}:2026-08-14-run-fence", tags="latest")
        self.assertNotEqual(rc, 0)


if __name__ == "__main__":
    unittest.main()
