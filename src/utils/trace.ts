/**
 * Lightweight diagnostic breadcrumbs for the stamp pipeline, readable via
 * the GET_TRACES message (through the e2e relay), since extension
 * background console output is not captured by the geckodriver service
 * log. Ring buffer is memory-only; nothing is persisted or sent off-machine.
 */

const traces: string[] = [];

/** Console mirroring is opt-in (tests/debugging) — not on in production. */
let mirrorToConsole = false;

export function setTraceConsoleMirror(enabled: boolean): void {
  mirrorToConsole = enabled;
}

export function trace(msg: string): void {
  const line = `${Date.now()} ${msg}`;
  traces.push(line);
  if (traces.length > 200) traces.shift();
  if (mirrorToConsole) {
    console.error(`[nobait:trace] ${msg}`);
  }
}

export function getTraces(): string[] {
  return [...traces];
}
