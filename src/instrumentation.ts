// Next.js calls register() once when the server boots, for every runtime
// the app is configured to use (nodejs and, speculatively, edge). Node
// built-ins aren't available to the edge bundle, so any reference to one
// has to stay out of code paths Next's edge bundler tries to compile.
//
// The webpackIgnore comment below tells webpack not to touch this import at
// all - not bundle it, not analyze its graph - so it's resolved natively by
// Node only when this line actually executes under the nodejs runtime
// (guarded above). Because it targets a bare built-in specifier
// ("child_process") rather than one of our own compiled files, Node
// resolves it directly with no filesystem lookup, so there's no compiled
// output file that needs to exist for this to work.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const explicit = process.env.EMBEDDED_WORKER;
  const shouldStart = explicit === "true" || (explicit !== "false" && process.env.NODE_ENV !== "production");
  if (!shouldStart) return;

  // Next's dev server can invoke register() more than once in some
  // configurations (e.g. multiple worker threads); guard against spawning
  // the embedded worker twice, which would otherwise both try to claim jobs
  // (harmless, since claiming is race-safe - but wasteful, and doubles log noise).
  const g = globalThis as unknown as { __embeddedWorkerStarted?: boolean };
  if (g.__embeddedWorkerStarted) return;
  g.__embeddedWorkerStarted = true;

  const { spawn } = await import(/* webpackIgnore: true */ "child_process");

  // Launches the generation worker as a genuinely separate OS process
  // alongside `npm run dev` / `next start`, so local dev is one command
  // with no Docker and no Redis required. Spawned as a real child process
  // (not imported in-process) for crash isolation between the web server
  // and the FFmpeg-running worker - which is also the right shape in
  // production, where you'd typically run `npm run worker:generation` as
  // its own managed service instead and set EMBEDDED_WORKER=false here.
  //
  // On Windows, npm resolves to npm.cmd, a batch file - spawning a .cmd
  // directly without shell:true is a well-known source of EINVAL/ENOENT on
  // Windows regardless of Node version, since .cmd files aren't directly
  // executable the way a real binary is. shell:true routes the spawn
  // through cmd.exe, which resolves and runs it correctly. This has no
  // effect on POSIX (shell stays false there).
  const isWindows = process.platform === "win32";
  const npmCmd = isWindows ? "npm.cmd" : "npm";
  const child = spawn(npmCmd, ["run", "worker:generation"], {
    stdio: "inherit",
    env: process.env,
    shell: isWindows,
  });

  child.on("error", (err: Error) => {
    // eslint-disable-next-line no-console
    console.error(`[embedded worker] failed to start: ${err.message}`);
  });

  child.on("exit", (code: number | null, signal: string | null) => {
    // eslint-disable-next-line no-console
    console.warn(`[embedded worker] exited (code=${code} signal=${signal})`);
    g.__embeddedWorkerStarted = false;
  });

  const shutdown = () => child.kill();
  process.on("exit", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
