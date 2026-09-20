/**
 * `ffprobe-static` ships no bundled type declarations. It exports a single
 * `path` string pointing at the platform-appropriate ffprobe binary that is
 * bundled inside the package itself (darwin/linux/win32, including
 * `ffprobe.exe` on win32) - see node_modules/ffprobe-static/index.js.
 */
declare module "ffprobe-static" {
  interface FfprobeStatic {
    path: string;
  }
  const ffprobeStatic: FfprobeStatic;
  export default ffprobeStatic;
}
