const crypto = require('crypto');

// Minimal crypto helper based on 企业微信加解密方案
// 参考：消息接收与发送文档中的签名校验与AES解密流程

function sha1(strs) {
  const shasum = crypto.createHash('sha1');
  strs.forEach((s) => shasum.update(s));
  return shasum.digest('hex');
}

function pkcs7Pad(buffer) {
  const blockSize = 32;
  const pad = blockSize - (buffer.length % blockSize);
  const padBuf = Buffer.alloc(pad, pad);
  return Buffer.concat([buffer, padBuf]);
}

function pkcs7Unpad(buffer) {
  const pad = buffer[buffer.length - 1];
  if (pad < 1 || pad > 32) return buffer;
  return buffer.slice(0, buffer.length - pad);
}

function aesDecrypt(encrypt, aesKey, corpIdOrSuiteId) {
  const key = Buffer.from(aesKey + '=', 'base64');
  const iv = key.slice(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  let decrypted = Buffer.concat([decipher.update(Buffer.from(encrypt, 'base64')), decipher.final()]);
  decrypted = pkcs7Unpad(decrypted);

  const random = decrypted.slice(0, 16);
  const msgLen = decrypted.slice(16, 20).readUInt32BE(0);
  const msg = decrypted.slice(20, 20 + msgLen).toString('utf-8');
  const receiveId = decrypted.slice(20 + msgLen).toString('utf-8');
  if (corpIdOrSuiteId && receiveId !== corpIdOrSuiteId) {
    // optional: guard mismatch
  }
  return { random, msgLen, msg, receiveId };
}

function aesEncrypt(msg, aesKey, corpId) {
  const key = Buffer.from(aesKey + '=', 'base64');
  const iv = key.slice(0, 16);
  const random = crypto.randomBytes(16);
  const msgBuf = Buffer.from(msg);
  const corpBuf = Buffer.from(corpId);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length, 0);
  const buf = Buffer.concat([random, lenBuf, msgBuf, corpBuf]);
  const padded = pkcs7Pad(buf);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
  return encrypted.toString('base64');
}

function genSignature(token, timestamp, nonce, encrypt) {
  const arr = [token, timestamp, nonce, encrypt].sort();
  return sha1(arr);
}

module.exports = {
  sha1,
  aesDecrypt,
  aesEncrypt,
  genSignature,
};