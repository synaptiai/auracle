// Exits at once, but leaves a child that holds stdout for two seconds. The
// process is gone long before its output closes.
import { spawn } from 'node:child_process';

spawn(process.execPath, ['-e', 'setTimeout(() => undefined, 2_000)'], { stdio: ['ignore', 'inherit', 'ignore'] }).unref();
