use anyhow::{Result, anyhow};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey};
use ring::hkdf::{HKDF_SHA256, Salt};

pub const CHUNK_SIZE: u64 = 1024 * 1024;
const TAG_SIZE: u64 = 16;
const KEY_SIZE: usize = 32;
const SALT_SIZE: usize = 16;
const CONTENT_INFO: &[u8] = b"site content v1";

pub enum LinkHint {
    Name(String),
    Salt(String),
}

pub struct LinkKey {
    pub hint: LinkHint,
    bytes: [u8; KEY_SIZE],
}

#[derive(Clone)]
pub struct Sealer {
    key: LessSafeKey,
}

impl LinkKey {
    pub fn for_name(secret: &str, name: &str) -> Result<LinkKey> {
        LinkKey::derive(secret, LinkHint::Name(name.to_string()))
    }

    pub fn for_salt(secret: &str, link_salt: &str) -> Result<LinkKey> {
        LinkKey::derive(secret, LinkHint::Salt(link_salt.to_string()))
    }

    pub fn fresh(secret: &str) -> Result<LinkKey> {
        LinkKey::for_salt(secret, &random_salt()?)
    }

    fn derive(secret: &str, hint: LinkHint) -> Result<LinkKey> {
        let info = match &hint {
            LinkHint::Name(name) => format!("site link v1 name:{name}"),
            LinkHint::Salt(salt) => format!("site link v1 deploy:{salt}"),
        };
        let bytes = hkdf(&[], secret.as_bytes(), info.as_bytes())?;
        Ok(LinkKey { hint, bytes })
    }

    pub fn fragment(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.bytes)
    }

    pub fn sealer(&self, content_salt: &str) -> Result<Sealer> {
        let salt = URL_SAFE_NO_PAD
            .decode(content_salt)
            .map_err(|_| anyhow!("the content salt is not valid"))?;
        let content_key = hkdf(&salt, &self.bytes, CONTENT_INFO)?;
        let key = UnboundKey::new(&AES_256_GCM, &content_key)
            .map_err(|_| anyhow!("could not make the content key"))?;
        Ok(Sealer {
            key: LessSafeKey::new(key),
        })
    }
}

impl Sealer {
    pub fn seal(&self, entry: u32, chunk: u32, last: bool, data: &mut Vec<u8>) -> Result<()> {
        let tag = self
            .key
            .seal_in_place_separate_tag(nonce(entry, chunk, last), Aad::empty(), data)
            .map_err(|_| anyhow!("encryption failed"))?;
        data.extend_from_slice(tag.as_ref());
        Ok(())
    }
}

pub fn chunk_count(plain_length: u64) -> u64 {
    plain_length.div_ceil(CHUNK_SIZE).max(1)
}

pub fn sealed_length(plain_length: u64) -> u64 {
    plain_length + chunk_count(plain_length) * TAG_SIZE
}

pub fn random_salt() -> Result<String> {
    let mut salt = [0u8; SALT_SIZE];
    getrandom::fill(&mut salt).map_err(|error| anyhow!("could not make a salt: {error}"))?;
    Ok(URL_SAFE_NO_PAD.encode(salt))
}

fn nonce(entry: u32, chunk: u32, last: bool) -> Nonce {
    let mut bytes = [0u8; NONCE_LEN];
    bytes[..4].copy_from_slice(&entry.to_be_bytes());
    bytes[4..8].copy_from_slice(&chunk.to_be_bytes());
    bytes[NONCE_LEN - 1] = u8::from(last);
    Nonce::assume_unique_for_key(bytes)
}

fn hkdf(salt: &[u8], secret: &[u8], info: &[u8]) -> Result<[u8; KEY_SIZE]> {
    let mut output = [0u8; KEY_SIZE];
    Salt::new(HKDF_SHA256, salt)
        .extract(secret)
        .expand(&[info], HKDF_SHA256)
        .and_then(|okm| okm.fill(&mut output))
        .map_err(|_| anyhow!("could not derive a key"))?;
    Ok(output)
}
