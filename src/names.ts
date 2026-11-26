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

export function siteLabel(hostname: string, domain: string): string | null {
  const suffix = `.${domain}`;
  if (!hostname.endsWith(suffix)) return null;
  const label = hostname.slice(0, -suffix.length);
  if (label.includes(".")) return null;
  return label;
}
