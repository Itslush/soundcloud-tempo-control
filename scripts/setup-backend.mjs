import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const python =
  process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const local = path.join(
  root,
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) console.error(result.error.message);
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}

run(python, ['-m', 'venv', '.venv']);
run(local, [
  '-m',
  'pip',
  'install',
  '--disable-pip-version-check',
  '--require-hashes',
  '--only-binary=:all:',
  '-r',
  'server/requirements.txt',
]);
run(local, ['-m', 'yt_dlp', '--version']);
