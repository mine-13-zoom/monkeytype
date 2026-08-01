// Low-level terminal handling: raw mode, key input parsing, ANSI output.

export type Key =
  | { type: "char"; char: string }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "ctrl_backspace" }
  | { type: "enter" }
  | { type: "tab" }
  | { type: "shift_tab" }
  | { type: "escape" }
  | { type: "up" }
  | { type: "down" }
  | { type: "left" }
  | { type: "right" }
  | { type: "home" }
  | { type: "end" }
  | { type: "ctrl_c" };

type KeyHandler = (key: Key) => void;
type ResizeHandler = (cols: number, rows: number) => void;

let keyHandler: KeyHandler | null = null;
let resizeHandler: ResizeHandler | null = null;
let started = false;

const ESC = "\x1b";

export function parseKeys(buf: Buffer): Key[] {
  const s = buf.toString("utf8");
  const keys: Key[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === ESC) {
      const rest = s.slice(i);
      if (rest === ESC) {
        keys.push({ type: "escape" });
        i += 1;
      } else if (rest.startsWith(ESC + "[Z")) {
        keys.push({ type: "shift_tab" });
        i += 3;
      } else if (rest.startsWith(ESC + "[A") || rest.startsWith(ESC + "OA")) {
        keys.push({ type: "up" });
        i += 3;
      } else if (rest.startsWith(ESC + "[B") || rest.startsWith(ESC + "OB")) {
        keys.push({ type: "down" });
        i += 3;
      } else if (rest.startsWith(ESC + "[C") || rest.startsWith(ESC + "OC")) {
        keys.push({ type: "right" });
        i += 3;
      } else if (rest.startsWith(ESC + "[D") || rest.startsWith(ESC + "OD")) {
        keys.push({ type: "left" });
        i += 3;
      } else if (rest.startsWith(ESC + "[H") || rest.startsWith(ESC + "OH") || rest.startsWith(ESC + "[1~")) {
        keys.push({ type: "home" });
        i += rest.startsWith(ESC + "[1~") ? 4 : 3;
      } else if (rest.startsWith(ESC + "[F") || rest.startsWith(ESC + "OF") || rest.startsWith(ESC + "[4~")) {
        keys.push({ type: "end" });
        i += rest.startsWith(ESC + "[4~") ? 4 : 3;
      } else if (rest.startsWith(ESC + "[3~")) {
        keys.push({ type: "delete" });
        i += 4;
      } else if (rest.startsWith(ESC + "[3;5~")) {
        keys.push({ type: "ctrl_backspace" });
        i += 6;
      } else {
        // Unknown escape sequence: consume the introducer and treat as escape-ish no-op
        const m = /^\x1b(\[[0-9;?]*[~A-Za-z]|\[[0-9;?]*$|O.?|.)/.exec(rest);
        i += m ? m[0].length : 1;
      }
    } else if (c === "\x03") {
      keys.push({ type: "ctrl_c" });
      i += 1;
    } else if (c === "\x7f" || c === "\x08") {
      keys.push({ type: "backspace" });
      i += 1;
    } else if (c === "\x17") {
      keys.push({ type: "ctrl_backspace" });
      i += 1;
    } else if (c === "\r" || c === "\n") {
      keys.push({ type: "enter" });
      i += 1;
    } else if (c === "\t") {
      keys.push({ type: "tab" });
      i += 1;
    } else if (c < " ") {
      // ignore other control chars
      i += 1;
    } else {
      // consume a full unicode codepoint
      const cp = s.codePointAt(i)!;
      keys.push({ type: "char", char: String.fromCodePoint(cp) });
      i += cp > 0xffff ? 2 : 1;
    }
  }
  return keys;
}

export function startTerminal(opts: {
  onKey: KeyHandler;
  onResize?: ResizeHandler;
}): void {
  if (started) return;
  started = true;
  keyHandler = opts.onKey;
  resizeHandler = opts.onResize ?? null;

  const stdin = process.stdin;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", (buf: Buffer) => {
    for (const key of parseKeys(buf)) keyHandler?.(key);
  });

  process.stdout.on("resize", () => {
    resizeHandler?.(process.stdout.columns, process.stdout.rows);
  });

  // alternate screen, hide cursor, clear
  write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H");
}

export function stopTerminal(): void {
  if (!started) return;
  started = false;
  write("\x1b[?25h\x1b[?1049h\x1b[0m");
  const stdin = process.stdin;
  if (stdin.isTTY) stdin.setRawMode(false);
  stdin.pause();
}

export function write(s: string): void {
  process.stdout.write(s);
}

export function size(): { cols: number; rows: number } {
  return { cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 };
}

// ---- ANSI helpers ----

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split("").map((c) => c + c).join("");
  if (h.length === 8) h = h.slice(0, 6);
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

export function fg(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[38;2;${r};${g};${b}m`;
}

export function bg(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[48;2;${r};${g};${b}m`;
}

export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const DIM = "\x1b[2m";
export const INVERSE = "\x1b[7m";

export function moveTo(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

/** Visible length of a string that may contain ANSI escapes. */
export function visibleLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, "").length;
}

export function centerPad(s: string, width: number): string {
  const len = visibleLen(s);
  if (len >= width) return s;
  const left = Math.floor((width - len) / 2);
  return " ".repeat(left) + s;
}
