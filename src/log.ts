/** Minimal logger matching the journalctl-friendly format the bot has
 * always used: "HH:MM:SS LEVEL   name: message".
 */
function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

export interface Log {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string, err?: unknown): void;
}

export function makeLog(name: string): Log {
  const line = (level: string, msg: string) =>
    `${stamp()} ${level.padEnd(7)} ${name}: ${msg}`;
  return {
    info: (msg) => console.log(line("INFO", msg)),
    warn: (msg) => console.warn(line("WARNING", msg)),
    error: (msg, err) => {
      console.error(line("ERROR", msg));
      if (err) console.error(err);
    },
  };
}
