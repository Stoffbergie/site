import { fetchMeta, forgetKey, openDeploy, readKey, saveKey, WrongKey } from "./site";

type State = "private" | "wrong" | "unsupported" | "failed" | "stuck";

const CONTROL_TIMEOUT_MS = 5000;

function show(state: State): void {
  for (const section of document.querySelectorAll<HTMLElement>("[data-state]")) {
    section.hidden = section.dataset.state !== state;
  }
}

type Link = { key: string | null; anchor: string };

const KEY_FRAGMENT = /^([A-Za-z0-9_-]{43})(?:#(.*))?$/s;
const OPENING_PATH = "/__site/opening";
const REOPENS_ITEM = "site-reopens";
const MAX_REOPENS = 3;
const REOPEN_WINDOW_MS = 60_000;
const BOOTSTRAP_HEADER = "X-Site-Bootstrap";

function readLink(): Link {
  const fragment = location.hash.slice(1);
  const match = KEY_FRAGMENT.exec(fragment);
  if (match === null) return { key: null, anchor: fragment };
  return { key: match[1], anchor: match[2] ?? "" };
}

function pageAddress(): string {
  return `${location.origin}${location.pathname}${location.search}`;
}

function withAnchor(anchor: string): string {
  const page = pageAddress();
  if (anchor === "") return page;
  return `${page}#${anchor}`;
}

function dropKey(link: Link): void {
  history.replaceState(null, "", withAnchor(link.anchor));
}

function sendSameSiteReferrer(): void {
  const policy = document.createElement("meta");
  policy.name = "referrer";
  policy.content = "same-origin";
  document.head.append(policy);
}

function openPage(link: Link): void {
  const target = withAnchor(link.anchor);
  history.replaceState(null, "", OPENING_PATH);
  sendSameSiteReferrer();
  location.replace(target);
}

type Reopens = { target: string; count: number; first: number; historyLength: number };

function savedReopens(): Reopens | null {
  const saved = sessionStorage.getItem(REOPENS_ITEM);
  if (saved === null) return null;
  return JSON.parse(saved) as Reopens;
}

function continuesChain(reopens: Reopens | null, target: string, now: number): reopens is Reopens {
  if (reopens === null) return false;
  if (reopens.target !== target) return false;
  if (reopens.historyLength !== history.length) return false;
  return now - reopens.first < REOPEN_WINDOW_MS;
}

function reopen(link: Link): void {
  const target = withAnchor(link.anchor);
  const now = Date.now();
  try {
    const saved = savedReopens();
    let reopens: Reopens = { target, count: 0, first: now, historyLength: history.length };
    if (continuesChain(saved, target, now)) reopens = saved;
    if (reopens.count >= MAX_REOPENS) {
      sessionStorage.removeItem(REOPENS_ITEM);
      show("stuck");
      return;
    }
    sessionStorage.setItem(REOPENS_ITEM, JSON.stringify({ ...reopens, count: reopens.count + 1 }));
  } catch {
    show("unsupported");
    return;
  }
  openPage(link);
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

type WorkerAnswer = "page" | "bootstrap" | "unavailable";

async function askWorker(): Promise<WorkerAnswer> {
  const response = await fetch(pageAddress(), { cache: "no-store" });
  await response.body?.cancel();
  if (response.headers.has(BOOTSTRAP_HEADER)) return "bootstrap";
  if (response.status === 503) return "unavailable";
  return "page";
}

async function boot(): Promise<void> {
  if (!("serviceWorker" in navigator) || typeof indexedDB === "undefined") {
    show("unsupported");
    return;
  }
  const controlledAlready = navigator.serviceWorker.controller !== null;
  const link = readLink();
  const stored = await storedKey();
  const key = link.key ?? stored;
  if (key === null) {
    show("private");
    return;
  }

  if (!controlledAlready || key !== stored) {
    if (!(await keyOpensSite(key))) {
      if (key === stored) await forgetKey();
      dropKey(link);
      show("wrong");
      return;
    }
    try {
      await saveKey(key);
    } catch {
      show("unsupported");
      return;
    }
  }
  dropKey(link);
  if (controlledAlready) {
    const answer = await askWorker();
    if (answer === "page") reopen(link);
    else if (answer === "unavailable") show("failed");
    else show("stuck");
    return;
  }

  const registration = await navigator.serviceWorker.register("/__site/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  if (!(await waitForControl(registration))) {
    show("unsupported");
    return;
  }
  reopen(link);
}

window.addEventListener("hashchange", () => {
  if (location.hash.length > 1) location.reload();
});

boot().catch(() => show("failed"));
