/**
 * TEMPORARY debugging aid for the EVALUATE_VIDEO hang investigation.
 * Collects timestamped breadcrumbs in a background-side buffer that the
 * e2e relay can read via GET_TRACES, since extension background console
 * output is not captured by the geckodriver service log.
 */

const traces: string[] = [];

export function trace(msg: string): void {
  const line = `${Date.now()} ${msg}`;
  traces.push(line);
  if (traces.length > 200) traces.shift();
  console.error(`[nobait:trace] ${msg}`);
}

export function getTraces(): string[] {
  return [...traces];
}
