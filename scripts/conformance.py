"""Run the Nestor server's black-box conformance suite against a satellite command.

    python scripts/conformance.py node dist/node/bin.js run --core {url} --room salon --input none --output none

Needs the `nestor` package (its venv: `../nestor/.venv/bin/python`). `{url}` is replaced by the
fake core's address. Prints one line per check, then exits 0 when every check passed.
"""

import asyncio
import sys

from nestor.adapters.channels.voice.satellites.conformance import check_satellite


async def main(command: list[str]) -> int:
    findings = await check_satellite(command, deadline_s=20)
    for finding in findings.items:
        mark = "PASS" if finding.passed else "FAIL"
        print(f"{mark}  {finding.check}" + (f"  ({finding.detail})" if finding.detail and not finding.passed else ""))
    print("conformant" if findings.passed else f"{len(findings.failures())} check(s) failed", flush=True)
    return 0 if findings.passed else 1


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    sys.exit(asyncio.run(main(sys.argv[1:])))
