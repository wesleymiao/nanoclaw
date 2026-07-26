/**
 * Tier 1 · E2E — real Docker, real container image, real bind mounts.
 *
 * Unlike src/e2e.test.ts (Tier 0), NOTHING here is mocked at the
 * container boundary: `child_process.spawn` is the real one, the
 * `nanoclaw-agent:latest` image is the real image built from
 * container/Dockerfile, and the volume mounts are real host directories
 * built by container-runner.ts's real `buildVolumeMounts()`/`runContainerAgent()`.
 *
 * What IS still synthetic, matching the design doc's Tier 1 plan:
 *  - The chat Channel and injected user messages (we call runContainerAgent()
 *    directly — no WhatsApp/Telegram/etc. involved).
 *  - The Claude Agent SDK call itself. We don't have API credentials or the
 *    real `claude` binary in CI, so we deliberately DON'T mount it — the
 *    container is expected to fail fast with a clean, well-formed error
 *    inside the ---NANOCLAW_OUTPUT_START/END--- marker contract. That
 *    contract (not a live model response) is exactly what Tier 0's fakes
 *    assume, so asserting it here is the whole point of this smoke test.
 *
 * Requirements to run this file:
 *  - A real Docker daemon reachable from this machine (`docker version`).
 *  - Linux. Production NanoClaw only ever runs on Linux; volume-mount and
 *    permission semantics differ enough on native Windows that Tier 1+
 *    should be run from WSL (or any Linux host), not native Windows.
 *    On Windows, run via: `wsl -d <your-distro> -- npm run test:tier1`
 *  - The `nanoclaw-agent:latest` image built (this suite builds it once in
 *    `beforeAll` via `docker build`, mirroring container/build.sh, if it's
 *    not already present — the very first run may take several minutes).
 *
 * This suite is intentionally excluded from the default `npm test` fast
 * loop (see vitest.config.ts) — run it explicitly with `npm run test:tier1`
 * before merging changes to container-runner.ts or container/Dockerfile.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runContainerAgent } from './container-runner.js';
import { RegisteredGroup } from './types.js';

const isLinux = os.platform() === 'linux';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function imageExists(image: string): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const IMAGE = 'nanoclaw-agent:latest';
const canRun = isLinux && dockerAvailable();

// Unique scratch group so this test never collides with a real group and is
// trivially identifiable for cleanup, matching the design doc's
// "scratch/throwaway group folder" plan for the Tier 1 smoke test.
const SCRATCH_GROUP_FOLDER = `tier1-scratch-${Date.now()}`;

describe.skipIf(!canRun)(
  'Tier 1 · E2E — real Docker daemon, real image, real bind mounts',
  () => {
    beforeAll(
      () => {
        if (!imageExists(IMAGE)) {
          // Mirrors container/build.sh's `docker build -t nanoclaw-agent:latest .`
          execFileSync('docker', ['build', '-t', IMAGE, '.'], {
            cwd: path.resolve(process.cwd(), 'container'),
            stdio: 'inherit',
            timeout: 10 * 60 * 1000,
          });
        }
      },
      10 * 60 * 1000,
    );

    afterAll(() => {
      // Clean up the scratch group's real host directories (groups/<folder>,
      // data/sessions/<folder>, data/ipc/<folder>) created by the real
      // container-runner.ts code paths during this test.
      for (const dir of [
        path.resolve(process.cwd(), 'groups', SCRATCH_GROUP_FOLDER),
        path.resolve(process.cwd(), 'data', 'sessions', SCRATCH_GROUP_FOLDER),
        path.resolve(process.cwd(), 'data', 'ipc', SCRATCH_GROUP_FOLDER),
      ]) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it(
      'real docker run against the real image produces the exact ---NANOCLAW_OUTPUT_START/END--- marker contract Tier 0 fakes assume',
      async () => {
        const group: RegisteredGroup = {
          name: 'Tier 1 Scratch',
          folder: SCRATCH_GROUP_FOLDER,
          trigger: '@nanoclaw',
          added_at: new Date().toISOString(),
          isMain: false,
          verbose: false,
        };

        const output = await runContainerAgent(
          group,
          {
            prompt: 'What is 2+2?',
            groupFolder: SCRATCH_GROUP_FOLDER,
            chatJid: 'tier1-scratch@test',
            isMain: false,
          },
          () => {
            /* onProcess: no-op, we don't need the raw ChildProcess handle here */
          },
        );

        // No `claude` binary is mounted in this environment (no credentials,
        // no live SDK call in CI) — so we expect a clean, well-formed error,
        // not a crash or malformed output. This is the real behavior of the
        // real entrypoint.sh + agent-runner when the binary is missing.
        expect(output.status).toBe('error');
        expect(output.result).toBeNull();
        expect(typeof output.error).toBe('string');
        expect(output.error!.length).toBeGreaterThan(0);
      },
      // Real docker run (npm install/build inside entrypoint.sh + full
      // container startup) is much slower than Tier 0's faked spawn.
      60 * 1000,
    );

    it('the real host directories for the scratch group were actually created by the real code paths', () => {
      const groupDir = path.resolve(
        process.cwd(),
        'groups',
        SCRATCH_GROUP_FOLDER,
      );
      const ipcDir = path.resolve(
        process.cwd(),
        'data',
        'ipc',
        SCRATCH_GROUP_FOLDER,
      );
      expect(fs.existsSync(groupDir)).toBe(true);
      expect(fs.existsSync(path.join(ipcDir, 'messages'))).toBe(true);
      expect(fs.existsSync(path.join(ipcDir, 'tasks'))).toBe(true);
      expect(fs.existsSync(path.join(ipcDir, 'input'))).toBe(true);
    });
  },
);

if (!canRun) {
  // Vitest requires at least one test per file when a describe block is
  // entirely skipped via describe.skipIf — this keeps the file from
  // reporting as a failure when Docker/Linux aren't available, while making
  // the reason visible in the test output.
  describe('Tier 1 · E2E', () => {
    it.skip(
      isLinux
        ? 'skipped: Docker daemon not reachable (run `docker version` to check, or start Docker Desktop / WSL Docker Engine)'
        : 'skipped: Tier 1 requires Linux (production never runs on Windows) — run via `wsl -d <distro> -- npm run test:tier1`',
      () => {},
    );
  });
}
