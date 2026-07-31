const crypto = require("crypto");

function getCipherKey() {
  const key = process.env.CARD_CIPHER_KEY || "dev-card-cipher-key";
  return crypto.createHash("sha256").update(key).digest();
}

function encryptSecret(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getCipherKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}

function decryptSecret(cipherText) {
  const [ivText, tagText, encryptedText] = cipherText.split(".");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getCipherKey(),
    Buffer.from(ivText, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}

function verifySignature({ method, path, timestamp, rawBody, signature, secret }) {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${method}\n${path}\n${timestamp}\n${rawBody || ""}`)
    .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function isTimestampFresh(timestamp, windowSeconds = 300) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  return Math.abs(Math.floor(Date.now() / 1000) - ts) <= windowSeconds;
}

function maskCard(cardNo) {
  if (!cardNo || cardNo.length < 8) return "****";
  return `${cardNo.slice(0, 4)}****${cardNo.slice(-4)}`;
}

module.exports = { encryptSecret, decryptSecret, verifySignature, isTimestampFresh, maskCard };
