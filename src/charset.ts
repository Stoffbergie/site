const UTF8_PARAMETER = "; charset=utf-8";
const PRESCAN_BYTES = 1024;
const UTF8_LABELS = new Set([
  "unicode-1-1-utf-8",
  "unicode11utf8",
  "unicode20utf8",
  "utf-8",
  "utf8",
  "x-unicode20utf8",
  "csunicode",
  "iso-10646-ucs-2",
  "ucs-2",
  "unicode",
  "unicodefeff",
  "unicodefffe",
  "utf-16",
  "utf-16be",
  "utf-16le"
]);
const OTHER_LABELS = new Set([
  "866",
  "cp866",
  "csibm866",
  "ibm866",
  "csisolatin2",
  "iso-8859-2",
  "iso-ir-101",
  "iso8859-2",
  "iso88592",
  "iso_8859-2",
  "iso_8859-2:1987",
  "l2",
  "latin2",
  "csisolatin3",
  "iso-8859-3",
  "iso-ir-109",
  "iso8859-3",
  "iso88593",
  "iso_8859-3",
  "iso_8859-3:1988",
  "l3",
  "latin3",
  "csisolatin4",
  "iso-8859-4",
  "iso-ir-110",
  "iso8859-4",
  "iso88594",
  "iso_8859-4",
  "iso_8859-4:1988",
  "l4",
  "latin4",
  "csisolatincyrillic",
  "cyrillic",
  "iso-8859-5",
  "iso-ir-144",
  "iso8859-5",
  "iso88595",
  "iso_8859-5",
  "iso_8859-5:1988",
  "arabic",
  "asmo-708",
  "csiso88596e",
  "csiso88596i",
  "csisolatinarabic",
  "ecma-114",
  "iso-8859-6",
  "iso-8859-6-e",
  "iso-8859-6-i",
  "iso-ir-127",
  "iso8859-6",
  "iso88596",
  "iso_8859-6",
  "iso_8859-6:1987",
  "csisolatingreek",
  "ecma-118",
  "elot_928",
  "greek",
  "greek8",
  "iso-8859-7",
  "iso-ir-126",
  "iso8859-7",
  "iso88597",
  "iso_8859-7",
  "iso_8859-7:1987",
  "sun_eu_greek",
  "csiso88598e",
  "csisolatinhebrew",
  "hebrew",
  "iso-8859-8",
  "iso-8859-8-e",
  "iso-ir-138",
  "iso8859-8",
  "iso88598",
  "iso_8859-8",
  "iso_8859-8:1988",
  "visual",
  "csiso88598i",
  "iso-8859-8-i",
  "logical",
  "csisolatin6",
  "iso-8859-10",
  "iso-ir-157",
  "iso8859-10",
  "iso885910",
  "l6",
  "latin6",
  "iso-8859-13",
  "iso8859-13",
  "iso885913",
  "iso-8859-14",
  "iso8859-14",
  "iso885914",
  "csisolatin9",
  "iso-8859-15",
  "iso8859-15",
  "iso885915",
  "iso_8859-15",
  "l9",
  "iso-8859-16",
  "cskoi8r",
  "koi",
  "koi8",
  "koi8-r",
  "koi8_r",
  "koi8-ru",
  "koi8-u",
  "csmacintosh",
  "mac",
  "macintosh",
  "x-mac-roman",
  "dos-874",
  "iso-8859-11",
  "iso8859-11",
  "iso885911",
  "tis-620",
  "windows-874",
  "cp1250",
  "windows-1250",
  "x-cp1250",
  "cp1251",
  "windows-1251",
  "x-cp1251",
  "ansi_x3.4-1968",
  "ascii",
  "cp1252",
  "cp819",
  "csisolatin1",
  "ibm819",
  "iso-8859-1",
  "iso-ir-100",
  "iso8859-1",
  "iso88591",
  "iso_8859-1",
  "iso_8859-1:1987",
  "l1",
  "latin1",
  "us-ascii",
  "windows-1252",
  "x-cp1252",
  "cp1253",
  "windows-1253",
  "x-cp1253",
  "cp1254",
  "csisolatin5",
  "iso-8859-9",
  "iso-ir-148",
  "iso8859-9",
  "iso88599",
  "iso_8859-9",
  "iso_8859-9:1989",
  "l5",
  "latin5",
  "windows-1254",
  "x-cp1254",
  "cp1255",
  "windows-1255",
  "x-cp1255",
  "cp1256",
  "windows-1256",
  "x-cp1256",
  "cp1257",
  "windows-1257",
  "x-cp1257",
  "cp1258",
  "windows-1258",
  "x-cp1258",
  "x-mac-cyrillic",
  "x-mac-ukrainian",
  "chinese",
  "csgb2312",
  "csiso58gb231280",
  "gb2312",
  "gb_2312",
  "gb_2312-80",
  "gbk",
  "iso-ir-58",
  "x-gbk",
  "gb18030",
  "big5",
  "big5-hkscs",
  "cn-big5",
  "csbig5",
  "x-x-big5",
  "cseucpkdfmtjapanese",
  "euc-jp",
  "x-euc-jp",
  "csiso2022jp",
  "iso-2022-jp",
  "csshiftjis",
  "ms932",
  "ms_kanji",
  "shift-jis",
  "shift_jis",
  "sjis",
  "windows-31j",
  "x-sjis",
  "cseuckr",
  "csksc56011987",
  "euc-kr",
  "iso-ir-149",
  "korean",
  "ks_c_5601-1987",
  "ks_c_5601-1989",
  "ksc5601",
  "ksc_5601",
  "windows-949",
  "csiso2022kr",
  "hz-gb-2312",
  "iso-2022-cn",
  "iso-2022-cn-ext",
  "iso-2022-kr",
  "replacement",
  "x-user-defined"
]);
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "title", "textarea", "iframe", "xmp", "noembed", "noframes"]);

type Charset = "utf-8" | "other";

export function mayCarryCharset(type: string): boolean {
  return type.endsWith(UTF8_PARAMETER);
}

export function fitCharset(type: string, head: Uint8Array, complete: boolean): string {
  if (!mayCarryCharset(type)) return type;
  const essence = type.slice(0, -UTF8_PARAMETER.length);
  if (readsAsUtf8(essence, head, complete)) return type;
  return essence;
}

function readsAsUtf8(essence: string, head: Uint8Array, complete: boolean): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(head, { stream: !complete });
  } catch {
    return false;
  }
  const hasBom = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf;
  if (hasBom) return true;
  const start = head.subarray(0, PRESCAN_BYTES);
  let declared: Charset | null = null;
  if (essence === "text/html") declared = htmlDeclaration(start);
  else if (essence === "text/css") declared = cssDeclaration(start);
  else if (essence === "application/xml" || essence === "text/xml" || essence.endsWith("+xml")) declared = xmlDeclaration(start);
  return declared !== "other";
}

function resolveLabel(label: string): Charset | null {
  const normalized = label.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "").toLowerCase();
  if (UTF8_LABELS.has(normalized)) return "utf-8";
  if (OTHER_LABELS.has(normalized)) return "other";
  return null;
}

function startsWithUtf16Signature(text: string): boolean {
  return text.startsWith("<\0?\0x\0") || text.startsWith("\0<\0?\0x");
}

function latin(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

function cssDeclaration(start: Uint8Array): Charset | null {
  const match = /^@charset "([^"]*)";/.exec(latin(start));
  if (match === null) return null;
  return resolveLabel(match[1]);
}

function xmlDeclaration(start: Uint8Array): Charset | null {
  const text = latin(start);
  if (startsWithUtf16Signature(text)) return "other";
  return xmlEncoding(text);
}

function isControlOrSpace(character: string | undefined): boolean {
  return character !== undefined && character <= " ";
}

function xmlEncoding(text: string): Charset | null {
  if (!text.startsWith("<?xml")) return null;
  const end = text.indexOf(">");
  if (end === -1) return null;
  const declaration = text.slice(0, end);
  const found = declaration.indexOf("encoding");
  if (found === -1) return null;
  let position = found + "encoding".length;
  while (isControlOrSpace(declaration[position])) position += 1;
  if (declaration[position] !== "=") return null;
  position += 1;
  while (isControlOrSpace(declaration[position])) position += 1;
  const quote = declaration[position];
  if (quote !== '"' && quote !== "'") return null;
  const labelEnd = declaration.indexOf(quote, position + 1);
  if (labelEnd === -1) return null;
  const label = declaration.slice(position + 1, labelEnd);
  if (Array.from(label).some(isControlOrSpace)) return null;
  return resolveLabel(label);
}

function isSpace(character: string | undefined): boolean {
  return character === "\t" || character === "\n" || character === "\f" || character === "\r" || character === " ";
}

function htmlDeclaration(start: Uint8Array): Charset | null {
  const text = latin(start);
  if (startsWithUtf16Signature(text)) return "other";
  const scanner = new Scanner(text);
  return scanner.prescan() ?? xmlEncoding(text);
}

function tagName(rest: string): string {
  let position = rest.startsWith("</") ? 2 : 1;
  let name = "";
  while (position < rest.length && !isSpace(rest[position]) && rest[position] !== "/" && rest[position] !== ">") {
    name += rest[position];
    position += 1;
  }
  return name.toLowerCase();
}

class Scanner {
  private position = 0;

  constructor(private readonly text: string) {}

  prescan(): Charset | null {
    const text = this.text;
    while (this.position < text.length) {
      const rest = text.slice(this.position, this.position + 6);
      if (rest.startsWith("<!--")) {
        const end = text.indexOf("-->", this.position + 2);
        if (end === -1) return null;
        this.position = end + 2;
      } else if (rest.slice(0, 5).toLowerCase() === "<meta" && (isSpace(rest[5]) || rest[5] === "/")) {
        this.position += 5;
        const declared = this.meta();
        if (declared === undefined) return null;
        if (declared !== null) return declared;
      } else if (/^<\/?[A-Za-z]/.test(rest)) {
        const isEndTag = rest.startsWith("</");
        const name = tagName(text.slice(this.position));
        while (this.position < text.length && !isSpace(text[this.position]) && text[this.position] !== ">") this.position += 1;
        let attribute = this.attribute();
        while (attribute !== null) {
          if (attribute === undefined) return null;
          attribute = this.attribute();
        }
        if (!isEndTag && name === "plaintext") return null;
        if (!isEndTag && RAW_TEXT_ELEMENTS.has(name)) {
          const closing = this.closingTag(name);
          if (closing === null) return null;
          this.position = closing;
          continue;
        }
      } else if (rest.startsWith("<!") || rest.startsWith("</") || rest.startsWith("<?")) {
        const end = text.indexOf(">", this.position);
        if (end === -1) return null;
        this.position = end;
      }
      this.position += 1;
    }
    return null;
  }

  private closingTag(name: string): number | null {
    const text = this.text;
    let position = this.position;
    while (true) {
      position = text.indexOf("</", position);
      if (position === -1) return null;
      const nameEnd = position + 2 + name.length;
      if (nameEnd >= text.length) return null;
      const after = text[nameEnd];
      const endsName = isSpace(after) || after === "/" || after === ">";
      if (text.slice(position + 2, nameEnd).toLowerCase() === name && endsName) return position;
      position += 2;
    }
  }

  private meta(): Charset | null | undefined {
    const seen = new Set<string>();
    let gotPragma = false;
    let needPragma: boolean | null = null;
    let charset: Charset | "unknown" | null = null;
    let attribute = this.attribute();
    while (attribute !== null) {
      if (attribute === undefined) return undefined;
      const [name, value] = attribute;
      if (!seen.has(name)) {
        seen.add(name);
        if (name === "http-equiv") {
          gotPragma = value === "content-type";
        } else if (name === "content" && charset === null) {
          const label = charsetInContent(value);
          let found: Charset | null = null;
          if (label !== null) found = resolveLabel(label);
          if (found !== null) {
            charset = found;
            needPragma = true;
          }
        } else if (name === "charset") {
          charset = resolveLabel(value) ?? "unknown";
          needPragma = false;
        }
      }
      attribute = this.attribute();
    }
    if (needPragma === null) return null;
    if (needPragma && !gotPragma) return null;
    if (charset === null || charset === "unknown") return null;
    return charset;
  }

  private attribute(): [string, string] | null | undefined {
    const text = this.text;
    while (isSpace(text[this.position]) || text[this.position] === "/") this.position += 1;
    if (this.position >= text.length) return undefined;
    if (text[this.position] === ">") return null;
    let name = "";
    while (true) {
      const character = text[this.position];
      if (character === undefined) return undefined;
      if (character === "=" && name !== "") {
        this.position += 1;
        break;
      }
      if (isSpace(character)) {
        while (isSpace(text[this.position])) this.position += 1;
        if (this.position >= text.length) return undefined;
        if (text[this.position] !== "=") return [name, ""];
        this.position += 1;
        break;
      }
      if (character === "/" || character === ">") return [name, ""];
      name += character.toLowerCase();
      this.position += 1;
    }
    while (isSpace(text[this.position])) this.position += 1;
    const first = text[this.position];
    if (first === undefined) return undefined;
    let value = "";
    if (first === '"' || first === "'") {
      this.position += 1;
      while (true) {
        const character = text[this.position];
        if (character === undefined) return undefined;
        this.position += 1;
        if (character === first) return [name, value];
        value += character.toLowerCase();
      }
    }
    if (first === ">") return [name, ""];
    while (true) {
      const character = text[this.position];
      if (character === undefined) return undefined;
      if (isSpace(character) || character === ">") return [name, value];
      value += character.toLowerCase();
      this.position += 1;
    }
  }
}

function charsetInContent(content: string): string | null {
  const lowered = content.toLowerCase();
  let position = 0;
  while (true) {
    const found = lowered.indexOf("charset", position);
    if (found === -1) return null;
    position = found + "charset".length;
    let next = position;
    while (isSpace(content[next])) next += 1;
    if (content[next] !== "=") continue;
    next += 1;
    while (isSpace(content[next])) next += 1;
    const first = content[next];
    if (first === undefined) return null;
    if (first === '"' || first === "'") {
      const end = content.indexOf(first, next + 1);
      if (end === -1) return null;
      return content.slice(next + 1, end);
    }
    let end = next;
    while (end < content.length && !isSpace(content[end]) && content[end] !== ";") end += 1;
    return content.slice(next, end);
  }
}
