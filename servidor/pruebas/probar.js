'use strict';
/*
 * Prueba completa del servidor: levanta una copia temporal (base y respaldos en una carpeta
 * temporal), recorre ingreso, doble factor, fichas, búsquedas, límites, exportación, respaldos
 * cifrados y detección de manipulaciones.
 *
 *   node pruebas/probar.js
 */
process.removeAllListeners('warning');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const S = require('../lib/seguridad');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcd-prueba-'));
const PUERTO = 18000 + Math.floor(Math.random() * 1000);
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
  puerto: PUERTO, direccion: '127.0.0.1', baseDeDatos: path.join(dir, 'rcd.db'),
  carpetaRespaldos: path.join(dir, 'respaldos'), limiteBusquedasPorHora: 5,
}));
const env = Object.assign({}, process.env, { RCD_CONFIG: path.join(dir, 'config.json') });
const salida = execFileSync(process.execPath, [path.join(__dirname, '../herramientas/crear-admin.js')],
  { env, input: 'admin\nAna Administradora\nSecretaría de Gobierno\n' }).toString();
const tmp = salida.match(/temporal: (\S+)/)[1];
const srv = spawn(process.execPath, [path.join(__dirname, '../servidor.js')], { env, stdio: 'ignore' });

const URL = `http://127.0.0.1:${PUERTO}/api`;
let fallas = 0;
const llamar = async (accion, datos = {}) => {
  const r = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(Object.assign({ accion }, datos)) });
  if ((r.headers.get('content-type') || '').includes('json')) return r.json();
  return { archivo: Buffer.from(await r.arrayBuffer()), tipo: r.headers.get('content-type') };
};
const ok = (n, c, x) => {
  if (!c) fallas++;
  console.log((c ? '✓ ' : '✗ ') + n + (x !== undefined ? ' → ' + (typeof x === 'string' ? x : JSON.stringify(x)) : ''));
};

(async () => {
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PUERTO}/`); break; } catch (_) { await new Promise(r => setTimeout(r, 100)); } }

  // Admin: contraseña temporal → cambio → configurar 2FA
  let r = await llamar('login', { usuario: 'admin', clave: 'mala' }); ok('login con clave mala rechazado', !r.ok, r.error);
  r = await llamar('login', { usuario: 'admin', clave: tmp }); ok('login admin pide cambiar clave', r.paso === 'cambiarClave');
  let T = r.token;
  r = await llamar('guardar', { token: T, datos: {} }); ok('sin completar pasos no puede operar', !r.ok, r.error);
  r = await llamar('cambiarClave', { token: T, nueva: 'corta' }); ok('política de clave', !r.ok, r.error);
  r = await llamar('cambiarClave', { token: T, nueva: 'ClaveSegura2026' }); ok('cambio de clave → configurar 2FA', r.paso === 'configurar2fa' && !!r.secreto, r.uri && r.uri.slice(0, 40));
  const secreto = r.secreto;
  r = await llamar('configurar2fa', { token: T, codigo: '000000' }); ok('código 2FA incorrecto', !r.ok, r.error);
  r = await llamar('configurar2fa', { token: T, codigo: S.codigoTotp(secreto, Math.floor(Date.now() / 30000)) }); ok('2FA configurado, sesión completa', r.ok && r.usuario && r.usuario.perfil === 'Administrador');
  // nuevo login con 2FA
  r = await llamar('login', { usuario: 'admin', clave: 'ClaveSegura2026' }); ok('login admin pide código', r.paso === 'codigo');
  T = r.token;
  r = await llamar('codigo2fa', { token: T, codigo: S.codigoTotp(secreto, Math.floor(Date.now() / 30000)) }); ok('código aceptado', r.ok && !!r.usuario);
  // crear usuario de carga
  r = await llamar('adminUsuarioGuardar', { token: T, datos: { nuevo: true, usuario: 'op1', nombre: 'Operador Uno', perfil: 'Carga', secretaria: 'Secretaría de Ingresos Públicos' } });
  ok('alta de usuario con clave temporal', r.ok && !!r.claveTemporal, r.claveTemporal);
  let r2 = await llamar('login', { usuario: 'op1', clave: r.claveTemporal }); let TC = r2.token;
  r2 = await llamar('cambiarClave', { token: TC, nueva: 'Operador2026x' }); ok('operador: cambio de clave → sesión completa (sin 2FA)', r2.ok && !!r2.usuario);
  // fichas
  const base = { apellido: 'Gómez', nombre: 'Laura', dni: '20111222', cuit: '27201112228', celular: '1133445566', mail: 'laura@mail.com', calle: 'Rivadavia', numero: '1154', barrio: 'Centro', vinculo: 'Titular', comentarios: 'vive con su madre' };
  r = await llamar('guardar', { token: TC, datos: base }); ok('alta de ficha (operador no recibe ID)', r.ok && !('id' in r), r);
  const ref = r.ref;
  r = await llamar('guardar', { token: TC, datos: Object.assign({}, base, { cuit: '' }) }); ok('DNI duplicado rechazado con coincidencias', !r.ok && r.existe && r.coincidencias.length === 1);
  ok('  coincidencia enmascarada', r.coincidencias[0].datos.celular === '11****5566' && r.coincidencias[0].datos.mail === 'l***@mail.com' && r.coincidencias[0].datos.comentarios === '(oculto)', r.coincidencias[0].datos.celular + ' ' + r.coincidencias[0].datos.mail);
  r = await llamar('buscar', { token: TC, tipo: 'dni', valor: '20111222' }); ok('búsqueda del operador enmascarada y sin ID', r.ok && r.resultados[0].ocultos && !('id' in r.resultados[0]), r.resultados[0].ocultos);
  r = await llamar('buscar', { token: T, tipo: 'dni', valor: '20111222' }); ok('búsqueda del admin completa y con ID', r.resultados[0].datos.celular === '1133445566' && r.resultados[0].id === 1);
  r = await llamar('actualizar', { token: TC, ref, que: 'telefono', cambios: { celular2: '2374001122', mail: 'robo@x.com' } }); ok('agregar teléfono (ignora mail)', r.ok && r.datos.celular2 === '23****1122');
  r = await llamar('actualizar', { token: TC, ref, que: 'domicilio', cambios: { calle: 'Mitre', numero: '55', barrio: 'Inventado' } }); ok('barrio fuera de lista rechazado', !r.ok, r.error);
  r = await llamar('actualizar', { token: TC, ref, que: 'domicilio', cambios: { calle: 'Mitre', numero: '55', barrio: 'El Rincón' } }); ok('nuevo domicilio', r.ok && r.datos.calle === 'Mitre');
  r = await llamar('editar', { token: TC, ref, datos: Object.assign({}, base, { nombre: 'Laura Beatriz' }) }); ok('editar la última carga', r.ok);
  r = await llamar('estadisticas', { token: TC }); ok('operador sin estadísticas', !r.ok, r.error);
  r = await llamar('estadisticas', { token: T }); ok('admin con estadísticas', r.ok && r.total === 1 && r.celulares === 1);
  for (let i = 0; i < 4; i++) await llamar('buscar', { token: TC, tipo: 'dni', valor: '30111222' });
  r = await llamar('buscar', { token: TC, tipo: 'dni', valor: '30111222' }); ok('límite de búsquedas por hora (5 en la prueba)', !r.ok, r.error);
  // exportar
  r = await llamar('adminExportar', { token: T, codigo: '123456' }); ok('exportar exige código 2FA', r.ok === false, r.error);
  r = await llamar('adminExportar', { token: T, codigo: S.codigoTotp(secreto, Math.floor(Date.now() / 30000)) }); ok('exportar .xlsx', !!r.archivo && r.archivo.slice(0, 2).toString() === 'PK', r.tipo);
    // llave de respaldo
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  r = await llamar('adminLlave', { token: T, spki, codigo: S.codigoTotp(secreto, Math.floor(Date.now() / 30000)) }); ok('llave de respaldo + primer respaldo', r.ok && r.respaldo.ok, r.respaldo);
  r = await llamar('adminResumen', { token: T }); ok('resumen: integridad OK', r.ok && r.verificacion.ok, { eventos: r.verificacion.eventos, archivos: r.respaldo.archivos.length });
  const sello = { eventos: r.verificacion.eventos, hash: r.verificacion.hash };
    // descifrar respaldo con la llave privada (mismo algoritmo que usará el navegador)
  const planilla = r.respaldo.archivos.find(a => a.nombre.endsWith('_planilla.rcd'));
  const bin = (await llamar('adminRespaldoDescargar', { token: T, nombre: planilla.nombre })).archivo;
  let o = 4; const ln = bin.readUInt16BE(o); o += 2; const nombre = bin.slice(o, o + ln).toString(); o += ln;
  const lk = bin.readUInt16BE(o); o += 2; const kc = bin.slice(o, o + lk); o += lk; const iv = bin.slice(o, o + 12); o += 12;
  const aes = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, kc);
  const cuerpo = bin.slice(o); const d = crypto.createDecipheriv('aes-256-gcm', aes, iv); d.setAuthTag(cuerpo.slice(-16));
  const plano = Buffer.concat([d.update(cuerpo.slice(0, -16)), d.final()]);
  ok('respaldo descifrado con la llave privada', plano.slice(0, 2).toString() === 'PK', nombre + ' ' + plano.length + ' bytes');
    r = await llamar('adminRespaldoDescargar', { token: T, nombre: '../config.json' }); ok('no permite descargar otros archivos', !r.ok, r.error);
  r = await llamar('adminUsuarioAccion', { token: T, usuario: 'admin', que: 'desactivar' }); ok('no puede desactivarse a sí mismo', !r.ok, r.error);
  r = await llamar('logout', { token: TC }); r = await llamar('buscar', { token: TC, tipo: 'dni', valor: '20111222' }); ok('después de salir, el token no sirve', !r.ok && r.sesionVencida);

  // Manipulación directa de la base (por fuera de la aplicación)
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'rcd.db'));
  db.exec("UPDATE registros SET celular = '1199999999' WHERE id = 1");
  db.prepare("INSERT INTO usuarios (usuario, nombre, perfil, secretaria, clave_hash, creado) VALUES ('intruso','X','Administrador','X',?, 'x')").run(S.hashClave('Intruso12345'));
  let borro = true;
  try { db.exec('DELETE FROM historial'); } catch (_) { borro = false; }
  ok('la base no permite borrar el historial', !borro);
  r = await llamar('adminResumen', { token: T, sello });
  ok('detecta la ficha modificada por fuera', r.verificacion.problemas.some(p => p.includes('#1 fue modificada')));
  ok('detecta el usuario creado por fuera', r.verificacion.problemas.some(p => p.includes('«intruso»')));
  db.exec('DROP TRIGGER historial_sin_cambios');
  db.exec("UPDATE historial SET hash = 'f' || substr(hash, 2) WHERE n = " + sello.eventos);
  r = await llamar('adminResumen', { token: T, sello });
  ok('el sello detecta la reescritura del historial', r.sello.hashActual !== r.sello.hashGuardado);
  db.close();

  srv.kill();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fallas ? `\n${fallas} prueba(s) fallaron.` : '\nTodas las pruebas pasaron.');
  process.exit(fallas ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
