// Claude Code updates itself unless DISABLE_AUTOUPDATER is set (the owner turned
// updates off on 2026-11-21, board a24a6aee). The owner's switch lives in the user
// settings file's `env`, which a claude started with `--setting-sources project`
// never reads, and which a process this server starts can't be sure of. So every
// claude this repo starts gets the variable itself, through this module:
//
//   - collectors/usage.mjs, the five-minute `claude -p /usage` poll;
//   - collectors/plan.mjs, the daily `claude auth status --json`;
//   - lib/jarvis-recover.mjs, Restart Jarvis, whose script starts the lead's claude
//     (its environment is built from scratch, so the variable is added there);
//   - bin/exact-hook-check.mjs, the console test's scratch settings (`env`), which
//     a `--setting-sources project` session still reads, as `--settings`.
//
// server/test/no-autoupdate.test.mjs pins each one, and fails when a new file names
// `claude` as a program to run without importing this module.
export const NO_AUTOUPDATE = Object.freeze({ DISABLE_AUTOUPDATER: '1' });

// This server's environment with updates off: what an exec of claude passes as `env`.
// The variable wins over a base that sets it to anything else.
export const claudeEnv = (base = process.env) => ({ ...base, ...NO_AUTOUPDATE });
