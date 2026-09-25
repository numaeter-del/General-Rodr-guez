'use strict';
/*
 * Seguridad: contraseñas, códigos de doble factor (TOTP, compatibles con Microsoft
 * Authenticator y Google Authenticator) y cifrado de respaldos con la llave pública
 * del Administrador. Solo usa el módulo "crypto" de Node (sin librerías externas).
 */
const crypto = require('node:crypto');

/* ---------- Contraseñas (scrypt con sal) ---------- */
const SCRYPT = { N: 16384, r: 8, p: 1, largo: 64 };

function hashClave(clave) {
  const sal = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(clave), sal, SCRYPT.largo, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${sal.toString('base64')}$${h.toString('base64')}`;
}

function verificarClave(clave, guardado) {
  const partes = String(guardado || '').split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') {
    // Igual se hace el cálculo, para no revelar por el tiempo de respuesta si el usuario existe.
    crypto.scryptSync(String(clave), 'x', SCRYPT.largo, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
    return false;
  }
  const [, N, r, p, sal, h] = partes;
  const esperado = Buffer.from(h, 'base64');
  const calc = crypto.scryptSync(String(clave), Buffer.from(sal, 'base64'), esperado.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(calc, esperado);
}

/** Política: al menos 10 caracteres, con letras y números. Devuelve el problema o null. */
function problemaClave(clave) {
  clave = String(clave || '');
  if (clave.length < 10) return 'La contraseña debe tener al menos 10 caracteres.';
  if (!/[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(clave) || !/\d/.test(clave)) return 'La contraseña debe combinar letras y números.';
  if (clave.length > 128) return 'La contraseña es demasiado larga.';
  return null;
}

/** Contraseña temporal legible (sin caracteres que se confunden: 0/O, 1/l/I). */
function claveTemporal() {
  const letras = 'abcdefghjkmnpqrstuvwxyz', numeros = '23456789';
  const elegir = s => s[crypto.randomInt(s.length)];
  let c = '';
  for (let i = 0; i < 4; i++) c += elegir(letras);
  c += '-';
  for (let i = 0; i < 4; i++) c += elegir(numeros);
  c += '-';
  for (let i = 0; i < 4; i++) c += elegir(letras);
  return c;
}

const token = () => crypto.randomBytes(32).toString('base64url');
const sha256 = texto => crypto.createHash('sha256').update(texto).digest('hex');
/** Huella corta de un secreto (para el registro de auditoría, sin revelar el secreto). */
const huella = texto => (texto ? sha256('rcd:' + texto).slice(0, 16) : '');

/* ---------- TOTP (RFC 6238) ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(buf) {
  let bits = 0, valor = 0, out = '';
  for (const b of buf) {
    valor = (valor << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(valor >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(valor << (5 - bits)) & 31];
  return out;
}

function desdeBase32(texto) {
  const limpio = String(texto).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, valor = 0;
  const out = [];
  for (const ch of limpio) {
    valor = (valor << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((valor >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const nuevoSecretoTotp = () => base32(crypto.randomBytes(20));

function codigoTotp(secreto, paso) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(paso));
  const h = crypto.createHmac('sha1', desdeBase32(secreto)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}

/** Acepta el código actual y el anterior/siguiente (tolerancia de ±30 s en el reloj). */
function verificarTotp(secreto, codigo, ahora = Date.now()) {
  codigo = String(codigo || '').replace(/\s/g, '');
  if (!secreto || !/^\d{6}$/.test(codigo)) return false;
  const paso = Math.floor(ahora / 30000);
  return [-1, 0, 1].some(d => crypto.timingSafeEqual(Buffer.from(codigoTotp(secreto, paso + d)), Buffer.from(codigo)));
}

function uriTotp(secreto, usuario, emisor) {
  const e = encodeURIComponent(emisor);
  return `otpauth://totp/${e}:${encodeURIComponent(usuario)}?secret=${secreto}&issuer=${e}&algorithm=SHA1&digits=6&period=30`;
}

/* ---------- Cifrado de respaldos ----------
 * Formato .rcd: "RCD1" | uint16 largo del nombre | nombre (UTF-8) | uint16 largo de la llave cifrada |
 *               llave AES cifrada con RSA-OAEP-SHA256 | iv (12) | datos cifrados AES-256-GCM + etiqueta (16)
 * El servidor solo tiene la llave PÚBLICA: puede cifrar pero no descifrar. Se descifra en el
 * navegador del Administrador con su llave privada (panel de Administración → Abrir un respaldo).
 */
function llavePublica(spkiBase64) {
  return crypto.createPublicKey({ key: Buffer.from(spkiBase64, 'base64'), format: 'der', type: 'spki' });
}

function cifrarRespaldo(contenido, nombre, spkiBase64) {
  const clave = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', clave, iv);
  const cuerpo = Buffer.concat([c.update(contenido), c.final(), c.getAuthTag()]);
  const claveCifrada = crypto.publicEncrypt(
    { key: llavePublica(spkiBase64), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, clave);
  const bNombre = Buffer.from(nombre, 'utf8');
  const l1 = Buffer.alloc(2); l1.writeUInt16BE(bNombre.length);
  const l2 = Buffer.alloc(2); l2.writeUInt16BE(claveCifrada.length);
  return Buffer.concat([Buffer.from('RCD1'), l1, bNombre, l2, claveCifrada, iv, cuerpo]);
}

module.exports = {
  hashClave, verificarClave, problemaClave, claveTemporal, token, sha256, huella,
  nuevoSecretoTotp, codigoTotp, verificarTotp, uriTotp, llavePublica, cifrarRespaldo,
};
