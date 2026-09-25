'use strict';
/*
 * Historial encadenado y verificación de integridad.
 *
 * Cada cambio (alta o modificación de una ficha, de un usuario o de un ajuste crítico)
 * se guarda como un evento que incluye la huella (SHA-256) del evento anterior. Si alguien
 * modifica la base "por fuera" de la aplicación —editando el archivo directamente—, la
 * verificación lo detecta de dos formas:
 *   1. la cadena se rompe (se alteró o borró un evento), o
 *   2. el estado actual de una ficha/usuario/ajuste no coincide con lo que dice el historial.
 * El Administrador guarda además un "sello" (cantidad de eventos + huella) en su navegador:
 * si la cadena se reescribe entera, el sello deja de coincidir.
 */
const { CAMPOS } = require('./campos');
const { sha256, huella } = require('./seguridad');

const GENESIS = '0'.repeat(64);

function hashEvento(anterior, e) {
  return sha256(anterior + '\n' + JSON.stringify([e.n, e.fecha, e.usuario, e.secretaria, e.objeto, e.accion, e.cambios]));
}

/** Agrega un evento a la cadena. Llamar dentro de una transacción. */
function registrarEvento(db, { usuario, secretaria, objeto, accion, cambios }) {
  const ultimo = db.prepare('SELECT n, hash FROM historial ORDER BY n DESC LIMIT 1').get();
  const e = {
    n: ultimo ? ultimo.n + 1 : 1,
    fecha: new Date().toISOString(),
    usuario, secretaria: secretaria || '', objeto, accion,
    cambios: JSON.stringify(cambios),
  };
  const anterior = ultimo ? ultimo.hash : GENESIS;
  const hash = hashEvento(anterior, e);
  db.prepare('INSERT INTO historial (n, fecha, usuario, secretaria, objeto, accion, cambios, hash_anterior, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(e.n, e.fecha, e.usuario, e.secretaria, e.objeto, e.accion, e.cambios, anterior, hash);
  return { n: e.n, hash };
}

/* Estado de un usuario tal como queda en el historial (sin secretos: solo sus huellas). */
const estadoUsuario = u => ({
  nombre: u.nombre, perfil: u.perfil, secretaria: u.secretaria, activo: u.activo ? 1 : 0,
  clave: huella(u.clave_hash), totp: huella(u.totp_secreto),
});
const huellaBarrios = lista => sha256(JSON.stringify(lista));

function verificar(db) {
  const problemas = [];
  const agregar = p => { if (problemas.length < 200) problemas.push(p); };
  const fichas = new Map(), usuarios = new Map(), ajustes = {};
  let anterior = GENESIS, esperado = 1, eventos = 0;

  for (const e of db.prepare('SELECT * FROM historial ORDER BY n').iterate()) {
    eventos++;
    if (e.n !== esperado) agregar(`Faltan eventos del historial entre el ${esperado - 1} y el ${e.n}.`);
    if (e.hash_anterior !== anterior) agregar(`El evento ${e.n} no continúa la cadena: se borró o reemplazó un evento anterior.`);
    if (hashEvento(e.hash_anterior, e) !== e.hash) agregar(`El evento ${e.n} (${e.accion}, ${e.fecha.slice(0, 10)}) fue alterado.`);
    anterior = e.hash;
    esperado = e.n + 1;
    let c;
    try { c = JSON.parse(e.cambios); } catch (_) { agregar(`El evento ${e.n} tiene datos ilegibles.`); continue; }
    const [tipo, id] = e.objeto.split(':');
    if (tipo === 'registro') {
      const f = fichas.get(id) || {};
      (Array.isArray(c) ? c : []).forEach(x => { f[x.campo] = x.despues; });
      fichas.set(id, f);
    } else if (tipo === 'usuario') {
      usuarios.set(id, c.estado);
    } else if (tipo === 'ajuste') {
      ajustes[id] = c.estado;
    }
  }

  const campos = CAMPOS.map(c => c.clave);
  const vistos = new Set();
  for (const r of db.prepare('SELECT * FROM registros').iterate()) {
    const id = String(r.id);
    vistos.add(id);
    const f = fichas.get(id);
    if (!f) { agregar(`La ficha #${id} no tiene alta en el historial: fue agregada por fuera del sistema.`); continue; }
    const distintos = campos.filter(k => (r[k] || '') !== (f[k] || ''));
    if (distintos.length) agregar(`La ficha #${id} fue modificada por fuera del sistema (${distintos.map(k => CAMPOS.find(c => c.clave === k).etiqueta).join(', ')}).`);
  }
  for (const id of fichas.keys()) if (!vistos.has(id)) agregar(`La ficha #${id} fue borrada por fuera del sistema.`);

  const usVistos = new Set();
  for (const u of db.prepare('SELECT * FROM usuarios').iterate()) {
    usVistos.add(u.usuario);
    const h = usuarios.get(u.usuario);
    if (!h) { agregar(`El usuario «${u.usuario}» fue creado por fuera del sistema.`); continue; }
    const actual = estadoUsuario(u);
    const distintos = Object.keys(actual).filter(k => actual[k] !== h[k]);
    if (distintos.length) {
      const nombres = { clave: 'contraseña', totp: 'doble factor', activo: 'estado', perfil: 'perfil', secretaria: 'secretaría', nombre: 'nombre' };
      agregar(`El usuario «${u.usuario}» fue modificado por fuera del sistema (${distintos.map(k => nombres[k]).join(', ')}).`);
    }
  }
  for (const u of usuarios.keys()) if (!usVistos.has(u)) agregar(`El usuario «${u}» fue borrado por fuera del sistema.`);

  const llave = db.prepare("SELECT valor FROM ajustes WHERE clave = 'llave_respaldo'").get();
  if ((llave ? huella(llave.valor) : '') !== ((ajustes.llave_respaldo && ajustes.llave_respaldo.huella) || '')) {
    agregar('La llave de los respaldos fue cambiada por fuera del sistema.');
  }
  const barrios = db.prepare('SELECT nombre FROM barrios ORDER BY orden').all().map(b => b.nombre);
  if (huellaBarrios(barrios) !== ((ajustes.barrios && ajustes.barrios.huella) || huellaBarrios([]))) {
    agregar('La lista de barrios fue cambiada por fuera del sistema.');
  }

  return { ok: problemas.length === 0, eventos, hash: anterior, problemas, fecha: new Date().toISOString() };
}

const hashEn = (db, n) => {
  const f = db.prepare('SELECT hash FROM historial WHERE n = ?').get(n);
  return f ? f.hash : null;
};

module.exports = { registrarEvento, verificar, hashEn, estadoUsuario, huellaBarrios, GENESIS };
