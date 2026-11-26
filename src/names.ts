const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
const namePattern = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const idShape = /^[a-z0-9]{8}$/;
const keyPattern = /^site_[a-z0-9]{26,64}$/;
const reserved = new Set(["www", "api", "admin", "app", "mail", "smtp", "imap", "pop", "mx", "ftp", "ns1", "ns2", "site", "status", "docs", "help", "abuse", "root", "dev", "test"]);
const blocked = [
  "paypal",
  "google",
  "apple",
  "icloud",
  "microsoft",
  "outlook",
  "office365",
  "amazon",
  "facebook",
  "instagram",
  "whatsapp",
  "netflix",
  "coinbase",
  "binance",
  "metamask",
  "stripe",
  "github",
  "cloudflare",
  "bank",
  "login",
  "logon",
  "signin",
  "sign-in",
  "secure",
  "account",
  "verify",
  "wallet",
  "password",
  "support"
];

const reservedForClaims = new Set([
  "install",
  "download",
  "cli",
  "auth",
  "sso",
  "billing",
  "dashboard",
  "cdn",
  "static",
  "assets",
  "update",
  "updates",
  "releases",
  "get",
  "security",
  "blog",
  "shop",
  "store",
  "stoff",
  "stoffberg",
  "keep",
  "hook",
  "beam",
  "reach",
  "relay",
  "webmail",
  "email",
  "postmaster",
  "hostmaster",
  "webmaster",
  "noreply",
  "no-reply"
]);
const lettersADigitPassesFor: Record<string, string> = { "0": "o", "1": "li", "3": "e", "4": "a", "5": "s", "7": "t" };

export const DEPLOY_ID_LENGTH = 8;

export function randomId(): string {
  while (true) {
    let value = "";
    while (value.length < DEPLOY_ID_LENGTH) {
      for (const byte of crypto.getRandomValues(new Uint8Array(DEPLOY_ID_LENGTH))) {
        if (byte >= 248) continue;
        value += alphabet[byte % alphabet.length];
        if (value.length === DEPLOY_ID_LENGTH) break;
      }
    }
    if (isDeployId(value)) return value;
  }
}

export function isDeployId(label: string): boolean {
  return idShape.test(label) && /[0-9]/.test(label);
}

export function isSiteKey(value: string): boolean {
  return keyPattern.test(value);
}

export function nameProblem(name: string): string | null {
  if (!namePattern.test(name)) return "Names are 3 to 40 lowercase letters, digits and hyphens, starting and ending with a letter or digit.";
  if (isDeployId(name)) return "Names of 8 letters and digits with a digit in them look like deploy ids; pick another name.";
  if (reserved.has(name)) return "That name is reserved; pick another.";
  if (blocked.some((word) => name.includes(word))) return "That name is not allowed; pick another.";
  return null;
}

export function newNameProblem(name: string): string | null {
  if (reservedForClaims.has(name)) return "That name is reserved; pick another.";
  const spelling = name.replaceAll("-", "");
  if (blocked.some((word) => readsAsContaining(spelling, word.replaceAll("-", "")))) return "That name is not allowed; pick another.";
  return null;
}

function readsAsContaining(spelling: string, word: string): boolean {
  for (let start = 0; start + word.length <= spelling.length; start += 1) {
    if (readsAsAt(spelling, start, word)) return true;
  }
  return false;
}

function readsAsAt(spelling: string, start: number, word: string): boolean {
  for (let offset = 0; offset < word.length; offset += 1) {
    if (!readsAs(spelling[start + offset], word[offset])) return false;
  }
  return true;
}

function readsAs(character: string, letter: string): boolean {
  if (character === letter) return true;
  const letters = lettersADigitPassesFor[character];
  if (letters === undefined) return false;
  return letters.includes(letter);
}

export function siteLabel(hostname: string, domain: string): string | null {
  const suffix = `.${domain}`;
  if (!hostname.endsWith(suffix)) return null;
  return hostname.slice(0, -suffix.length);
}
