const log = (...a: unknown[]) => console.log("[smoke]", ...a);

async function main() {
  log("boot");
  // T1b: CLASSIC blob worker (no type: module)
  await new Promise<void>((resolve) => {
    const url = URL.createObjectURL(
      new Blob(['self.postMessage("classic-alive");'], {
        type: "text/javascript",
      }),
    );
    const w = new Worker(url);
    const t = setTimeout(() => {
      log("T1b TIMEOUT");
      resolve();
    }, 5000);
    w.onmessage = (e) => {
      clearTimeout(t);
      log("T1b PASS:", e.data);
      resolve();
    };
    w.onerror = (e) => {
      clearTimeout(t);
      log("T1b FAIL:", (e as ErrorEvent).message);
      resolve();
    };
  });
  // T4: classic blob worker importing via importScripts? skip. Instead: packaged-file module worker
  await new Promise<void>((resolve) => {
    const w = new Worker(browser.runtime.getURL("test-worker.js"), {
      type: "module",
    });
    const t = setTimeout(() => {
      log("T4 TIMEOUT");
      resolve();
    }, 5000);
    w.onmessage = (e) => {
      clearTimeout(t);
      log("T4 PASS:", e.data);
      resolve();
    };
    w.onerror = (e) => {
      clearTimeout(t);
      log("T4 FAIL:", (e as ErrorEvent).message);
      resolve();
    };
  });
  console.log("[smoke] DONE");
}
void main();
