// Online matches on the runtime's local platform (`--dev --local-platform`):
// the first run serves a platform whose room-bound sessions run server.js, the
// second joins it. Plays tests/online/host.play (alice creates a match) and
// tests/online/guest.play (bob quick-joins it on a phone) at once; both play
// by keys to the result server.js records. Real time: a few minutes.
// STARHERMIT names the runtime; SHOTS a folder for the screenshots.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fallback = join(homedir(), 'sh/runtime/1.23.0/starhermit-1.23.0-linux-x86_64/starhermit');
const exe = process.env.STARHERMIT || (existsSync(fallback) ? fallback : null);
if (!exe) { console.error('set STARHERMIT to the engine runtime'); process.exit(1); }
const shots = process.env.SHOTS || mkdtempSync(join(tmpdir(), 'spot-kick-online-'));

function run(player, script) {
  return new Promise((resolve) => {
    const p = spawn(exe, ['.', '--dev', '--local-platform', '--player', player, '--render-check', '--quiet', '--script', script],
      { cwd: root, env: { ...process.env, STARHERMIT_RENDER_CHECK_PNG: shots } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}
let failed = 0;
const report = (name, r) => {
  if (r.code === 0) console.log(`ok - ${name}`);
  else { console.log(`not ok - ${name}\n${r.out.trim().split('\n').slice(-8).join('\n')}`); failed++; }
};
const host = run('alice', 'tests/online/host.play');
await new Promise((r) => setTimeout(r, 8000));
const guest = run('bob', 'tests/online/guest.play');
report('guest.play', await guest);
report('host.play', await host);
console.log(`screenshots: ${shots}`);
console.log(failed ? `ONLINE FAIL — ${failed} failed` : 'ONLINE PASS');
process.exit(failed ? 1 : 0);
