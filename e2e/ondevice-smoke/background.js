// e2e/ondevice-smoke/bg.ts
var log = (...a) => console.log("[smoke]", ...a);
async function main() {
  log("boot");
  await new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob(['self.postMessage("classic-alive");'], { type: "text/javascript" }));
    const w = new Worker(url);
    const t = setTimeout(() => {
      log("T1b TIMEOUT");
      resolve();
    }, 5e3);
    w.onmessage = (e) => {
      clearTimeout(t);
      log("T1b PASS:", e.data);
      resolve();
    };
    w.onerror = (e) => {
      clearTimeout(t);
      log("T1b FAIL:", e.message);
      resolve();
    };
  });
  await new Promise((resolve) => {
    const w = new Worker(browser.runtime.getURL("test-worker.js"), { type: "module" });
    const t = setTimeout(() => {
      log("T4 TIMEOUT");
      resolve();
    }, 5e3);
    w.onmessage = (e) => {
      clearTimeout(t);
      log("T4 PASS:", e.data);
      resolve();
    };
    w.onerror = (e) => {
      clearTimeout(t);
      log("T4 FAIL:", e.message);
      resolve();
    };
  });
  console.log("[smoke] DONE");
}
void main();
