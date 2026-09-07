import argparse
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('variant', choices=['original', 'clean'])
options = parser.parse_args()
source = root / 'test-results/signalsmith-threshold-source'
binary = root / f'test-results/stretch-threshold-{options.variant}.exe'
result = subprocess.run([str(binary)], check=True, capture_output=True, text=True, timeout=30)
report = json.loads(result.stdout)
report.update({
    'variant': options.variant,
    'timestampUtc': datetime.now(timezone.utc).isoformat(),
    'scope': 'Native MSVC comparison, not WASM or production acceptance. Identical explicit seeds and PCM schedule across variants.',
    'binarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
    'headerSha256': hashlib.sha256((source / 'signalsmith-stretch.h').read_bytes()).hexdigest(),
    'probeSha256': hashlib.sha256((root / 'tests/inspect-stretch-threshold.cpp').read_bytes()).hexdigest(),
    'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip(),
    'linearCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source / 'signalsmith-linear', text=True).strip(),
    'sourceDiff': subprocess.check_output(['git', 'diff', '--', 'signalsmith-stretch.h'], cwd=source, text=True),
})
stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
path = root / f'test-results/stretch-threshold-{options.variant}-{stamp}.json'
with path.open('x', encoding='utf-8') as stream:
    stream.write(json.dumps(report, indent=2) + '\n')
print(json.dumps({'report': str(path), 'cases': report['cases']}))
