import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('variant', choices=['original', 'clean'])
options = parser.parse_args()
sdk = root / 'test-results/emsdk-diagnostic'
source = root / 'test-results/signalsmith-threshold-source'
directory = root / f'test-results/stretch-wasm-{options.variant}'
directory.mkdir(exist_ok=False)
environment = dict(os.environ, EM_CONFIG=str(sdk / '.emscripten'))
compiler = sdk / 'upstream/emscripten/em++.py'
command = [
    sys.executable, str(compiler), str(source / 'web/emscripten/main.cpp'),
    '-o', str(directory / 'factory.mjs'), '-I', str(source / 'web/emscripten'),
    '-std=c++11', '-O3', '-ffast-math', '-fno-exceptions', '-fno-rtti',
    '--pre-js', str(source / 'web/emscripten/pre.js'), '--closure', '0',
    '-sSINGLE_FILE=1', '-sMODULARIZE=1', '-sEXPORT_ES6=1',
    '-sENVIRONMENT=web,worker,shell', '-sNO_EXIT_RUNTIME=1',
    '-sFILESYSTEM=0', '-sEXPORTED_RUNTIME_METHODS=HEAP8,UTF8ToString',
    '-sINITIAL_MEMORY=512kb', '-sALLOW_MEMORY_GROWTH=1',
    '-sMEMORY_GROWTH_GEOMETRIC_STEP=0.5', '-sABORTING_MALLOC=1',
    '-sSTRICT=1', '-sDYNAMIC_EXECUTION=0',
]
result = subprocess.run(command, env=environment, capture_output=True, text=True, timeout=180)
manifest = {
    'variant': options.variant, 'command': command, 'exitCode': result.returncode,
    'stdout': result.stdout, 'stderr': result.stderr,
    'compilerVersion': subprocess.check_output([sys.executable, str(compiler), '--version'], env=environment, text=True),
    'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip(),
    'linearCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source / 'signalsmith-linear', text=True).strip(),
    'headerSha256': hashlib.sha256((source / 'signalsmith-stretch.h').read_bytes()).hexdigest(),
    'sourceDiff': subprocess.check_output(['git', 'diff', '--', 'signalsmith-stretch.h'], cwd=source, text=True),
}
if result.returncode == 0:
    manifest['factorySha256'] = hashlib.sha256((directory / 'factory.mjs').read_bytes()).hexdigest()
with (directory / 'build.json').open('x', encoding='utf-8') as stream:
    stream.write(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'directory': str(directory), 'exitCode': result.returncode, 'stderr': result.stderr}))
raise SystemExit(result.returncode)
