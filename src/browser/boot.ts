import { fetchMeta, forgetKey, openDeploy, readKey, saveKey, WrongKey } from "./site";

type State = "private" | "wrong" | "unsupported" | "failed";

const CONTROL_TIMEOUT_MS = 5000;

function show(state: State): void {
  for (const section of document.querySelectorAll<HTMLElement>("[data-state]")) {
    section.hidden = section.dataset.state !== state;
  }
}

function dropFragment(): void {
  history.replaceState(null, "", location.pathname + location.search);
}

async function keyOpensSite(key: string): Promise<boolean> {
  try {
    await openDeploy(await fetchMeta(), key);
    return true;
  } catch (error) {
    if (error instanceof WrongKey) return false;
    throw error;
  }
}

async function storedKey(): Promise<string | null> {
  try {
    return await readKey();
  } catch {
    return null;
  }
}

function waitForControl(registration: ServiceWorkerRegistration): Promise<boolean> {
  return new Promise((resolve) => {
    if (navigator.serviceWorker.controller !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), CONTROL_TIMEOUT_MS);
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      clearTimeout(timer);
      resolve(true);
    });
    registration.active?.postMessage("claim");
  });
}

async function boot(): Promise<void> {
  if (!("serviceWorker" in navigator) || typeof indexedDB === "undefined") {
    show("unsupported");
    return;
  }
  const controlledAlready = navigator.serviceWorker.controller !== null;
  const fromLink = location.hash.slice(1);
  const stored = await storedKey();
  let key = stored;
  if (fromLink !== "") key = fromLink;
  if (key === null) {
    show("private");
    return;
  }

  if (!(await keyOpensSite(key))) {
    if (key === stored) await forgetKey();
    dropFragment();
    show("wrong");
    return;
  }

  try {
    await saveKey(key);
  } catch {
    show("unsupported");
    return;
  }
  dropFragment();
  if (controlledAlready && key === stored) {
    show("failed");
    return;
  }

  const registration = await navigator.serviceWorker.register("/__site/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  if (!(await waitForControl(registration))) {
    show("unsupported");
    return;
  }
  location.reload();
}

boot().catch(() => show("failed"));
