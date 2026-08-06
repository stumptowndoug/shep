#!/usr/bin/env node

import process from "node:process";

const ESC = "\x1b";
const DEFAULTS = {
  scrollback: 4_000,
  frames: 120,
  frameLines: 90,
  delayMs: 2,
};

function parsePositiveInteger(flag, value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { ...options, help: true };

    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${arg}`);
    if (arg === "--scrollback") options.scrollback = parsePositiveInteger(arg, value);
    else if (arg === "--frames") options.frames = parsePositiveInteger(arg, value);
    else if (arg === "--frame-lines") options.frameLines = parsePositiveInteger(arg, value);
    else if (arg === "--delay-ms") options.delayMs = parsePositiveInteger(arg, value);
    else throw new Error(`unknown option: ${arg}`);
    index += 1;
  }
  return options;
}

function usage() {
  return `Usage: node scripts/replay-terminal-scroll-repro.mjs [options]

Replay an agent-style terminal workload into the current Shep terminal.

Options:
  --scrollback N    Initial scrollback lines (default: ${DEFAULTS.scrollback})
  --frames N        Synchronized full repaint count (default: ${DEFAULTS.frames})
  --frame-lines N   Lines per repaint (default: ${DEFAULTS.frameLines})
  --delay-ms N      Delay between repaints (default: ${DEFAULTS.delayMs})
  -h, --help        Show this help
`;
}

async function write(data) {
  if (process.stdout.write(data)) return;
  await new Promise((resolve) => process.stdout.once("drain", resolve));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function padded(value, width) {
  return String(value).padStart(width, "0");
}

async function run(options) {
  let interrupted = false;
  const restoreCursor = () => {
    if (interrupted) return;
    interrupted = true;
    process.stdout.write(`${ESC}[?25h${ESC}[?2026l\r\n`);
  };
  process.once("SIGINT", () => {
    restoreCursor();
    process.exitCode = 130;
  });
  process.once("SIGTERM", () => {
    restoreCursor();
    process.exitCode = 143;
  });

  await write(`${ESC}[?25l${ESC}[0m[terminal-repro] building ${options.scrollback} lines of scrollback\r\n`);
  for (let line = 1; line <= options.scrollback; line += 1) {
    const color = 31 + (line % 6);
    await write(`${ESC}[${color}m[history ${padded(line, 5)}]${ESC}[0m agent transcript payload ${"·".repeat(72)}\r\n`);
  }

  for (let frame = 1; frame <= options.frames && !interrupted; frame += 1) {
    const repaint = [
      `${ESC}[?2026h`,
      `${ESC}[H${ESC}[2J`,
      `${ESC}[1;36mShep terminal pipeline repro${ESC}[0m  frame ${padded(frame, 3)}/${options.frames}\r\n`,
      `This repaint is wrapped in CSI ?2026 and contains CSI 2J.\r\n`,
    ];
    for (let line = 1; line <= options.frameLines; line += 1) {
      repaint.push(
        `${ESC}[${line % 2 === 0 ? "2" : "0"}m`,
        `agent output ${padded(line, 3)}  frame=${padded(frame, 3)}  ${"█".repeat(64)}${ESC}[0m\r\n`,
      );
    }
    repaint.push(`${ESC}[?2026l`);
    await write(repaint.join(""));
    if (options.delayMs > 0) await sleep(options.delayMs);
  }

  if (!interrupted) {
    await write(
      `${ESC}[?2026h${ESC}[H${ESC}[2J${ESC}[1;32m[terminal-repro] COMPLETE${ESC}[0m\r\n` +
      `Expected after Phase 1: continuous paint, viewport at this marker, follow mode active.\r\n` +
      `Manual check: scroll up during another run, then press End and rerun to resume follow.\r\n` +
      `${ESC}[?2026l${ESC}[?25h`,
    );
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
  } else {
    await run(options);
  }
} catch (error) {
  process.stderr.write(`[terminal-repro] ${error instanceof Error ? error.message : String(error)}\n`);
  process.stderr.write(usage());
  process.exitCode = 1;
}
