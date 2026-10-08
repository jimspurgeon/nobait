/**
 * Options page logic
 */

// `browser` / `chrome` globals come from webextension-polyfill / @types/chrome.

const api =
  typeof browser !== "undefined"
    ? browser
    : typeof chrome !== "undefined"
      ? chrome
      : null;

const STORAGE_KEYS = {
  backend: "preferredBackend",
  apiKey: "geminiApiKey",
};

async function getStorage(keys: string[]): Promise<Record<string, unknown>> {
  if (!api?.storage?.local) return {};
  if (typeof browser !== "undefined") {
    return await browser.storage.local.get(keys);
  }
  return await new Promise((resolve) => {
    chrome.storage.local.get(keys, (result: Record<string, unknown>) =>
      resolve(result),
    );
  });
}

async function setStorage(items: Record<string, unknown>): Promise<void> {
  if (!api?.storage?.local) return;
  if (typeof browser !== "undefined") {
    await browser.storage.local.set(items);
  } else {
    await new Promise<void>((resolve) => {
      chrome.storage.local.set(items, () => resolve());
    });
  }
}

function setStatus(el: HTMLElement, message: string, isError = false): void {
  el.textContent = message;
  el.classList.add("visible");
  el.classList.toggle("error", isError);
  setTimeout(() => el.classList.remove("visible"), 3000);
}

async function init(): Promise<void> {
  const backendSelect = document.getElementById(
    "backend",
  ) as HTMLSelectElement | null;
  const apiKeyInput = document.getElementById(
    "api-key",
  ) as HTMLInputElement | null;
  const saveBtn = document.getElementById(
    "save-key",
  ) as HTMLButtonElement | null;
  const keyStatus = document.getElementById("key-status") as HTMLElement | null;
  const clearCacheBtn = document.getElementById(
    "clear-cache",
  ) as HTMLButtonElement | null;
  const cacheStatus = document.getElementById(
    "cache-status",
  ) as HTMLElement | null;

  // Load saved values
  const values = await getStorage(Object.values(STORAGE_KEYS));

  if (backendSelect && typeof values[STORAGE_KEYS.backend] === "string") {
    backendSelect.value = values[STORAGE_KEYS.backend] as string;
  }

  if (
    apiKeyInput &&
    typeof values[STORAGE_KEYS.apiKey] === "string" &&
    (values[STORAGE_KEYS.apiKey] as string).length > 0
  ) {
    apiKeyInput.placeholder = "•••••••••••••••• (saved)";
  }

  // Save API key handler
  saveBtn?.addEventListener("click", async () => {
    const key = apiKeyInput?.value.trim() ?? "";
    if (!key) {
      if (keyStatus) setStatus(keyStatus, "Please enter an API key.", true);
      return;
    }
    try {
      await setStorage({ [STORAGE_KEYS.apiKey]: key });
      if (keyStatus) setStatus(keyStatus, "API key saved.");
      if (apiKeyInput) {
        apiKeyInput.value = "";
        apiKeyInput.placeholder = "•••••••••••••••• (saved)";
      }
    } catch (err) {
      if (keyStatus)
        setStatus(keyStatus, `Failed to save: ${String(err)}`, true);
    }
  });

  // Clear cache handler
  clearCacheBtn?.addEventListener("click", async () => {
    if (!api?.runtime?.sendMessage) return;
    try {
      if (typeof browser !== "undefined") {
        await browser.runtime.sendMessage({ type: "CLEAR_CACHE" });
      } else {
        await new Promise<void>((resolve) => {
          chrome.runtime.sendMessage({ type: "CLEAR_CACHE" }, () => resolve());
        });
      }
      if (cacheStatus) setStatus(cacheStatus, "Cache cleared.");
    } catch (err) {
      if (cacheStatus)
        setStatus(cacheStatus, `Failed to clear cache: ${String(err)}`, true);
    }
  });

  // Backend selection handler
  backendSelect?.addEventListener("change", async () => {
    if (!backendSelect) return;
    await setStorage({ [STORAGE_KEYS.backend]: backendSelect.value });
  });
}

init().catch(console.error);
