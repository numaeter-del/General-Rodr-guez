'use strict';
/*
 * Red Central de Datos — servidor municipal.
 *
 *   node servidor.js                       inicia el servidor (usa config.json)
 *   node herramientas/crear-admin.js       crea el primer Administrador (una sola vez)
 *
 * Requisito: Node.js 22.13 o posterior (versión LTS). No usa librerías externas.
 */
process.removeAllListeners('warning');
process.on('warning', w => { if (w.name !== 'ExperimentalWarning') console.warn(w); });

const [mayor, menor] = process.versions.node.split('.').map(Number);
if (mayor < 22 || (mayor === 22 && menor < 13)) {
  console.error(`Se necesita Node.js 22.13 o posterior (versión LTS). Esta computadora tiene ${process.version}.`);
  process.exit(1);
}

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { cargarConfig } = require('./lib/config');
const { abrir } = require('./lib/db');
const { crearApi } = require('./lib/api');
const { crearRespaldos } = require('./lib/respaldos');
const { inicializar } = require('./lib/inicio');

const config = cargarConfig();
const db = abrir(config.baseDeDatos);
inicializar(db);

function log(usuario, ip, evento, detalle) {
  try {
    db.prepare('INSERT INTO accesos (fecha, usuario, ip, evento, detalle) VALUES (?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), String(usuario || ''), String(ip || ''), String(evento), String(detalle || '').slice(0, 500));
  } catch (e) {
    console.error('[registro de accesos]', e.message);
  }
}

const respaldos = crearRespaldos({ db, config, log });
const api = crearApi({ db, config, respaldos, log });
respaldos.programar();

/* ---------- archivos de la página ---------- */
const RAIZ = path.resolve(config.carpetaFrontend);
const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
};
const configJs = `window.APP_CONFIG = ${JSON.stringify({ API_URL: '/api', NOMBRE_APP: 'Red Central de Datos', ORGANISMO: config.organismo })};\n`;

function encabezadosSeguridad(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'",
    "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
  ].join('; '));
  if (config.https) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

function servirArchivo(req, res) {
  let ruta = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (ruta === '/') ruta = '/index.html';
  if (ruta === '/assets/config.js') {
    res.writeHead(200, { 'Content-Type': TIPOS['.js'], 'Cache-Control': 'no-cache' });
    return res.end(configJs);
  }
  const completo = path.resolve(RAIZ, '.' + ruta);
  if (!completo.startsWith(RAIZ + path.sep) || !TIPOS[path.extname(completo)] || !fs.existsSync(completo) || !fs.statSync(completo).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('No encontrado');
  }
  res.writeHead(200, { 'Content-Type': TIPOS[path.extname(completo)], 'Cache-Control': 'no-cache' });
  fs.createReadStream(completo).pipe(res);
}

/* ---------- API ---------- */
function ipDe(req) {
  if (config.detrasDeProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function atenderApi(req, res) {
  let tam = 0;
  const partes = [];
  req.on('data', d => {
    tam += d.length;
    if (tam > 2 * 1024 * 1024) { res.writeHead(413); res.end(); req.destroy(); return; }
    partes.push(d);
  });
  req.on('end', async () => {
    if (res.writableEnded) return;
    const responder = (codigo, obj) => {
      res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    let p;
    try { p = JSON.parse(Buffer.concat(partes).toString('utf8')); } catch (_) { return responder(400, { ok: false, error: 'Solicitud inválida.' }); }
    if (!p || typeof p !== 'object') return responder(400, { ok: false, error: 'Solicitud inválida.' });
    try {
      const r = await api(p, ipDe(req));
      if (r && r._archivo) {
        res.writeHead(200, {
          'Content-Type': r._tipo, 'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="${r._nombre.replace(/[^\w.-]/g, '_')}"`,
        });
        return res.end(r._archivo);
      }
      responder(200, Object.assign({ ok: true }, r));
    } catch (e) {
      if (!e.publico) console.error(`[${new Date().toISOString()}] ${p.accion}:`, e);
      responder(200, {
        ok: false,
        error: e.publico ? e.message : 'Error interno del servidor. Intentá de nuevo.',
        sesionVencida: !!e.sesionVencida,
        existe: !!e.existe,
        coincidencias: e.coincidencias || undefined,
      });
    }
  });
}

function manejador(req, res) {
  encabezadosSeguridad(res);
  const ruta = new URL(req.url, 'http://x').pathname;
  if (ruta === '/api') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    return atenderApi(req, res);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  servirArchivo(req, res);
}

let servidor;
if (config.https) {
  const opciones = config.https.pfx
    ? { pfx: fs.readFileSync(path.resolve(__dirname, config.https.pfx)), passphrase: config.https.clave || undefined }
    : { cert: fs.readFileSync(path.resolve(__dirname, config.https.cert)), key: fs.readFileSync(path.resolve(__dirname, config.https.key)) };
  servidor = https.createServer(Object.assign(opciones, { minVersion: 'TLSv1.2' }), manejador);
} else {
  servidor = http.createServer(manejador);
}
servidor.headersTimeout = 20000;
servidor.requestTimeout = 60000;
servidor.listen(config.puerto, config.direccion, () => {
  const proto = config.https ? 'https' : 'http';
  console.log(`Red Central de Datos en ${proto}://${config.direccion === '0.0.0.0' ? 'localhost' : config.direccion}:${config.puerto}`);
  console.log(`Base de datos: ${path.resolve(config.baseDeDatos)}`);
  if (!config.https) console.log('ATENCIÓN: sin HTTPS. Usar solo para pruebas o detrás de un servidor con HTTPS (ver README).');
  const hayUsuarios = db.prepare('SELECT COUNT(*) AS n FROM usuarios').get().n;
  if (!hayUsuarios) console.log('No hay usuarios todavía: ejecutar  node herramientas/crear-admin.js');
});

const cerrar = () => { servidor.close(); try { db.close(); } catch (_) { /* ya cerrada */ } process.exit(0); };
process.on('SIGINT', cerrar);
process.on('SIGTERM', cerrar);
