use std::io::Read;

const UTF8_PARAMETER: &str = "; charset=utf-8";
const UTF8_BOM: &[u8] = &[0xef, 0xbb, 0xbf];
const PRESCAN_BYTES: usize = 1024;
const READ_CHUNK_BYTES: usize = 64 * 1024;
const UTF8_LABELS: &[&str] = &[
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
    "utf-16le",
];
const OTHER_LABELS: &[&str] = &[
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
    "x-user-defined",
];
const UTF16_LE_SIGNATURE: &[u8] = &[0x3c, 0x00, 0x3f, 0x00, 0x78, 0x00];
const UTF16_BE_SIGNATURE: &[u8] = &[0x00, 0x3c, 0x00, 0x3f, 0x00, 0x78];
const RAW_TEXT_ELEMENTS: &[&[u8]] = &[
    b"script",
    b"style",
    b"title",
    b"textarea",
    b"iframe",
    b"xmp",
    b"noembed",
    b"noframes",
];

#[derive(Clone, Copy, PartialEq)]
enum Charset {
    Utf8,
    Other,
}

enum MetaCharset {
    Unset,
    Unknown,
    Known(Charset),
}

pub fn fit_charset(content_type: &'static str, bytes: &[u8]) -> &'static str {
    let Some(essence) = content_type.strip_suffix(UTF8_PARAMETER) else {
        return content_type;
    };
    if reads_as_utf8(essence, bytes) {
        content_type
    } else {
        essence
    }
}

pub fn fit_charset_streamed(
    content_type: &'static str,
    mut reader: impl Read,
) -> std::io::Result<&'static str> {
    let Some(essence) = content_type.strip_suffix(UTF8_PARAMETER) else {
        return Ok(content_type);
    };
    let mut head = Vec::with_capacity(PRESCAN_BYTES);
    let mut unchecked = Vec::new();
    let mut chunk = vec![0u8; READ_CHUNK_BYTES];
    loop {
        let count = reader.read(&mut chunk)?;
        if count == 0 {
            break;
        }
        let read = &chunk[..count];
        let head_room = PRESCAN_BYTES - head.len();
        head.extend_from_slice(&read[..count.min(head_room)]);
        unchecked.extend_from_slice(read);
        match std::str::from_utf8(&unchecked) {
            Ok(_) => unchecked.clear(),
            Err(error) if error.error_len().is_none() => {
                unchecked.drain(..error.valid_up_to());
            }
            Err(_) => return Ok(essence),
        }
    }
    if !unchecked.is_empty() || declares_other_encoding(essence, &head) {
        return Ok(essence);
    }
    Ok(content_type)
}

fn reads_as_utf8(essence: &str, bytes: &[u8]) -> bool {
    if std::str::from_utf8(bytes).is_err() {
        return false;
    }
    let head = &bytes[..bytes.len().min(PRESCAN_BYTES)];
    !declares_other_encoding(essence, head)
}

fn declares_other_encoding(essence: &str, head: &[u8]) -> bool {
    if head.starts_with(UTF8_BOM) {
        return false;
    }
    let declared = match essence {
        "text/html" => html_declaration(head),
        "text/css" => css_declaration(head),
        _ if is_xml(essence) => xml_declaration(head),
        _ => None,
    };
    declared == Some(Charset::Other)
}

fn is_xml(essence: &str) -> bool {
    essence == "application/xml" || essence == "text/xml" || essence.ends_with("+xml")
}

fn resolve_label(label: &[u8]) -> Option<Charset> {
    let text = String::from_utf8_lossy(label);
    let normalized = text
        .trim_matches(|character: char| character.is_ascii_whitespace())
        .to_ascii_lowercase();
    if UTF8_LABELS.contains(&normalized.as_str()) {
        return Some(Charset::Utf8);
    }
    if OTHER_LABELS.contains(&normalized.as_str()) {
        return Some(Charset::Other);
    }
    None
}

fn starts_with_utf16_signature(head: &[u8]) -> bool {
    head.starts_with(UTF16_LE_SIGNATURE) || head.starts_with(UTF16_BE_SIGNATURE)
}

fn css_declaration(head: &[u8]) -> Option<Charset> {
    let rest = head.strip_prefix(b"@charset \"")?;
    let end = rest.iter().position(|&byte| byte == b'"')?;
    if rest.get(end + 1) != Some(&b';') {
        return None;
    }
    resolve_label(&rest[..end])
}

fn xml_declaration(head: &[u8]) -> Option<Charset> {
    if starts_with_utf16_signature(head) {
        return Some(Charset::Other);
    }
    xml_encoding(head)
}

fn xml_encoding(head: &[u8]) -> Option<Charset> {
    if !head.starts_with(b"<?xml") {
        return None;
    }
    let end = head.iter().position(|&byte| byte == b'>')?;
    let declaration = &head[..end];
    let mut position = find(declaration, b"encoding", 0)? + b"encoding".len();
    position = skip_control(declaration, position);
    if declaration.get(position) != Some(&b'=') {
        return None;
    }
    position = skip_control(declaration, position + 1);
    let quote = *declaration.get(position)?;
    if quote != b'"' && quote != b'\'' {
        return None;
    }
    let start = position + 1;
    let length = declaration[start..]
        .iter()
        .position(|&byte| byte == quote)?;
    let label = &declaration[start..start + length];
    if label.iter().any(|&byte| byte <= b' ') {
        return None;
    }
    resolve_label(label)
}

fn html_declaration(head: &[u8]) -> Option<Charset> {
    if starts_with_utf16_signature(head) {
        return Some(Charset::Other);
    }
    meta_scan(head).or_else(|| xml_encoding(head))
}

fn meta_scan(head: &[u8]) -> Option<Charset> {
    let mut position = 0;
    while position < head.len() {
        let rest = &head[position..];
        if rest.starts_with(b"<!--") {
            position = find(head, b"-->", position + 2)? + 2;
        } else if starts_with_ignoring_case(rest, b"<meta")
            && rest
                .get(5)
                .is_some_and(|&byte| is_space(byte) || byte == b'/')
        {
            position += 5;
            if let Some(charset) = meta_declaration(head, &mut position)? {
                return Some(charset);
            }
        } else if is_tag_start(rest) {
            let is_end_tag = rest.starts_with(b"</");
            let name = tag_name(rest);
            while position < head.len() && !is_space(head[position]) && head[position] != b'>' {
                position += 1;
            }
            while attribute(head, &mut position)?.is_some() {}
            if !is_end_tag && name.eq_ignore_ascii_case(b"plaintext") {
                return None;
            }
            if !is_end_tag && is_raw_text_element(name) {
                position = closing_tag(head, position, name)?;
                continue;
            }
        } else if rest.starts_with(b"<!") || rest.starts_with(b"</") || rest.starts_with(b"<?") {
            position += head[position..].iter().position(|&byte| byte == b'>')?;
        }
        position += 1;
    }
    None
}

fn is_tag_start(rest: &[u8]) -> bool {
    let name_start = if rest.starts_with(b"</") { 2 } else { 1 };
    rest.first() == Some(&b'<') && rest.get(name_start).is_some_and(u8::is_ascii_alphabetic)
}

fn tag_name(rest: &[u8]) -> &[u8] {
    let start = if rest.starts_with(b"</") { 2 } else { 1 };
    let length = rest[start..]
        .iter()
        .position(|&byte| is_space(byte) || byte == b'/' || byte == b'>')
        .unwrap_or(rest.len() - start);
    &rest[start..start + length]
}

fn is_raw_text_element(name: &[u8]) -> bool {
    RAW_TEXT_ELEMENTS
        .iter()
        .any(|element| name.eq_ignore_ascii_case(element))
}

fn closing_tag(head: &[u8], from: usize, name: &[u8]) -> Option<usize> {
    let mut position = from;
    loop {
        position = find(head, b"</", position)?;
        let name_end = position + 2 + name.len();
        let candidate = head.get(position + 2..name_end)?;
        let after = *head.get(name_end)?;
        let ends_name = is_space(after) || after == b'/' || after == b'>';
        if candidate.eq_ignore_ascii_case(name) && ends_name {
            return Some(position);
        }
        position += 2;
    }
}

fn meta_declaration(head: &[u8], position: &mut usize) -> Option<Option<Charset>> {
    let mut seen: Vec<Vec<u8>> = Vec::new();
    let mut got_pragma = false;
    let mut need_pragma: Option<bool> = None;
    let mut charset = MetaCharset::Unset;
    while let Some((name, value)) = attribute(head, position)? {
        if seen.contains(&name) {
            continue;
        }
        match name.as_slice() {
            b"http-equiv" => got_pragma = value == b"content-type",
            b"content" if matches!(charset, MetaCharset::Unset) => {
                let found = charset_in_content(&value).and_then(|label| resolve_label(&label));
                if let Some(found) = found {
                    charset = MetaCharset::Known(found);
                    need_pragma = Some(true);
                }
            }
            b"charset" => {
                charset = match resolve_label(&value) {
                    Some(found) => MetaCharset::Known(found),
                    None => MetaCharset::Unknown,
                };
                need_pragma = Some(false);
            }
            _ => {}
        }
        seen.push(name);
    }
    let MetaCharset::Known(found) = charset else {
        return Some(None);
    };
    let declared = match need_pragma {
        Some(true) if !got_pragma => None,
        _ => Some(found),
    };
    Some(declared)
}

fn attribute(head: &[u8], position: &mut usize) -> Option<Option<(Vec<u8>, Vec<u8>)>> {
    while is_space(*head.get(*position)?) || head[*position] == b'/' {
        *position += 1;
    }
    if head[*position] == b'>' {
        return Some(None);
    }
    let mut name = Vec::new();
    loop {
        let byte = *head.get(*position)?;
        if byte == b'=' && !name.is_empty() {
            *position += 1;
            break;
        }
        if is_space(byte) {
            *position = skip_whitespace(head, *position);
            if head.get(*position)? != &b'=' {
                return Some(Some((name, Vec::new())));
            }
            *position += 1;
            break;
        }
        if byte == b'/' || byte == b'>' {
            return Some(Some((name, Vec::new())));
        }
        name.push(byte.to_ascii_lowercase());
        *position += 1;
    }
    *position = skip_whitespace(head, *position);
    let mut value = Vec::new();
    let first = *head.get(*position)?;
    if first == b'"' || first == b'\'' {
        *position += 1;
        loop {
            let byte = *head.get(*position)?;
            *position += 1;
            if byte == first {
                return Some(Some((name, value)));
            }
            value.push(byte.to_ascii_lowercase());
        }
    }
    if first == b'>' {
        return Some(Some((name, value)));
    }
    loop {
        let byte = *head.get(*position)?;
        if is_space(byte) || byte == b'>' {
            return Some(Some((name, value)));
        }
        value.push(byte.to_ascii_lowercase());
        *position += 1;
    }
}

fn charset_in_content(content: &[u8]) -> Option<Vec<u8>> {
    let mut position = 0;
    loop {
        position = find_ignoring_case(content, b"charset", position)? + b"charset".len();
        let after_name = skip_whitespace(content, position);
        if content.get(after_name) != Some(&b'=') {
            continue;
        }
        let start = skip_whitespace(content, after_name + 1);
        let first = *content.get(start)?;
        if first == b'"' || first == b'\'' {
            let length = content[start + 1..]
                .iter()
                .position(|&byte| byte == first)?;
            return Some(content[start + 1..start + 1 + length].to_vec());
        }
        let length = content[start..]
            .iter()
            .position(|&byte| is_space(byte) || byte == b';')
            .unwrap_or(content.len() - start);
        return Some(content[start..start + length].to_vec());
    }
}

fn is_space(byte: u8) -> bool {
    matches!(byte, b'\t' | b'\n' | b'\x0c' | b'\r' | b' ')
}

fn skip_control(bytes: &[u8], mut position: usize) -> usize {
    while bytes.get(position).is_some_and(|&byte| byte <= b' ') {
        position += 1;
    }
    position
}

fn skip_whitespace(bytes: &[u8], mut position: usize) -> usize {
    while bytes.get(position).is_some_and(|&byte| is_space(byte)) {
        position += 1;
    }
    position
}

fn find(bytes: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    let offset = bytes
        .get(from..)?
        .windows(needle.len())
        .position(|window| window == needle)?;
    Some(from + offset)
}

fn find_ignoring_case(bytes: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    let offset = bytes
        .get(from..)?
        .windows(needle.len())
        .position(|window| window.eq_ignore_ascii_case(needle))?;
    Some(from + offset)
}

fn starts_with_ignoring_case(bytes: &[u8], prefix: &[u8]) -> bool {
    bytes.len() >= prefix.len() && bytes[..prefix.len()].eq_ignore_ascii_case(prefix)
}
