import json
import hashlib
import os
import subprocess
from pathlib import Path

from userscript_fixture import ROOT


def build_worklet():
    override = os.environ.get('TEMPO_TEST_WORKLET')
    if override:
        path = Path(override).resolve()
        if not path.is_relative_to(ROOT / 'test-results'):
            raise ValueError('Diagnostic worklets must remain inside test-results')
        expected = os.environ.get('TEMPO_TEST_WORKLET_SHA256')
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError('Diagnostic worklet checksum mismatch')
        return path
    result = subprocess.run(
        [os.environ.get('NODE', 'node'), str(ROOT / 'scripts/worklet-assets.cjs')],
        check=True, capture_output=True, text=True, timeout=30,
    )
    return Path(json.loads(result.stdout)['path'])
