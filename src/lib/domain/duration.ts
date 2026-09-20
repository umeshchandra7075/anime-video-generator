export function durationToSeconds(duration: string): number {
  switch (duration) {
    case "30s":
      return 30;
    case "1m":
      return 60;
    case "3m":
      return 180;
    case "5m":
      return 300;
    case "10m":
      return 600;
    default:
      return 300; // "custom" falls back to a sane default; real custom
      // durations should be captured as an explicit field in a future pass.
  }
}
