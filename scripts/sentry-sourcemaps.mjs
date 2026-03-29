import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const artifactDirectories = [
  'apps/api/dist',
  'apps/worker/dist',
  'packages/config/dist',
  'packages/contracts/dist',
  'packages/shared/dist',
];

const existingArtifactDirectories = artifactDirectories.filter((directory) =>
  existsSync(directory),
);

if (existingArtifactDirectories.length === 0) {
  throw new Error(
    `No Sentry sourcemap artifacts found. Checked: ${artifactDirectories.join(', ')}`,
  );
}

function runSentryCli(command, extraArgs = []) {
  const result = spawnSync(
    'pnpm',
    [
      'exec',
      'sentry-cli',
      'sourcemaps',
      command,
      '--org',
      'pingcap2',
      '--project',
      'mem9-node',
      ...extraArgs,
      ...existingArtifactDirectories,
    ],
    {
      stdio: 'inherit',
    },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

runSentryCli('inject');
runSentryCli('upload', ['--validate']);
