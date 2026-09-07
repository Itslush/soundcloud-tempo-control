import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SUITES = [
    'verify-release.py', 'verify-inline.py', 'verify-ux.py', 'verify-library.py', 'verify-compact-library.py',
    'verify-timeline.py', 'verify-pitch-mode.py', 'verify-wasm.py', 'verify-wasm-boundaries.py',
    'verify-share-links.py', 'verify-native-copy.py', 'verify-embedded-track.py', 'verify-display-duration.py', 'verify-editor-zoom.py',
    'verify-timeline-pan.py', 'verify-fade-start.py', 'verify-output.py', 'verify-overhead.py', 'verify-updates.py',
]

for suite in SUITES:
    print(f'Running {suite}', flush=True)
    subprocess.run([sys.executable, str(ROOT/suite)], cwd=ROOT.parent, check=True,
                   env={**os.environ, 'PYTHONUNBUFFERED': '1'})
print(f'Passed {len(SUITES)} muted browser suites.', flush=True)
