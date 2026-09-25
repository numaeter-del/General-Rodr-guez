'use strict';
/*
 * Planilla completa (.xlsx) y respaldos cifrados.
 * Los respaldos se cifran con la llave PÚBLICA del Administrador: quien tenga acceso al
 * servidor o a la carpeta de respaldos no puede leerlos. Solo se abren con la llave privada,
 * que el Administrador guarda fuera del servidor.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { CAMPOS } = require('./campos');
const { libro } = require('./xlsx');
const { cifrarRespaldo } = require('./seguridad');
const { ajuste, fijarAjuste } = require('./db');
const { verificar } = require('./auditoria');

const dosDig = n => String(n).padStart(2, '0');
const fechaLocal = iso => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? iso : `${dosDig(d.getDate())}/${dosDig(d.getMonth() + 1)}/${d.getFullYear()} ${dosDig(d.getHours())}:${dosDig(d.getMinutes())}`;
};
const sello = d => `${d.getFullYear()}-${dosDig(d.getMonth() + 1)}-${dosDig(d.getDate())}_${dosDig(d.getHours())}${dosDig(d.getMinutes())}`;

function planilla(db) {
  const registros = db.prepare('SELECT * FROM registros ORDER BY id').all();
  const historial = [];
  for (const e of db.prepare('SELECT * FROM historial ORDER BY n').iterate()) {
    let c = [];
    try { c = JSON.parse(e.cambios); } catch (_) { /* se muestra vacío */ }
    const base = [String(e.n), fechaLocal(e.fecha), e.usuario, e.secretaria, e.objeto, e.accion];
    if (Array.isArray(c)) {
      c.forEach(x => historial.push(base.concat([(CAMPOS.find(k => k.clave === x.campo) || { etiqueta: x.campo }).etiqueta, x.antes, x.despues, e.hash])));
    } else {
      historial.push(base.concat(['', '', JSON.stringify(c.estado || c), e.hash]));
    }
  }
  return libro([
    {
      nombre: 'Registros',
      columnas: ['ID', 'Fecha de carga', 'Secretaría', 'Usuario'].concat(CAMPOS.map(c => c.etiqueta), ['Última edición', 'Editado por']),
      filas: registros.map(r => [String(r.id), fechaLocal(r.fecha), r.secretaria, r.usuario].concat(CAMPOS.map(c => r[c.clave]), [fechaLocal(r.ultima_edicion), r.editado_por])),
      anchos: [7, 17, 26, 14].concat(CAMPOS.map(c => (c.clave === 'comentarios' ? 50 : 18)), [17, 14]),
    },
    {
      nombre: 'Historial',
      columnas: ['N°', 'Fecha', 'Usuario', 'Secretaría', 'Objeto', 'Acción', 'Campo', 'Valor anterior', 'Valor nuevo', 'Huella'],
      filas: historial,
      anchos: [7, 17, 14, 26, 18, 26, 22, 30, 30, 66],
    },
    {
      nombre: 'Accesos',
      columnas: ['N°', 'Fecha', 'Usuario', 'IP', 'Evento', 'Detalle'],
      filas: db.prepare('SELECT * FROM accesos ORDER BY n').all().map(a => [String(a.n), fechaLocal(a.fecha), a.usuario, a.ip, a.evento, a.detalle]),
      anchos: [7, 17, 14, 16, 26, 60],
    },
    {
      nombre: 'Usuarios',
      columnas: ['Usuario', 'Nombre', 'Perfil', 'Secretaría', 'Activo', 'Creado', 'Último ingreso', 'Doble factor'],
      filas: db.prepare('SELECT * FROM usuarios ORDER BY usuario').all().map(u => [u.usuario, u.nombre, u.perfil, u.secretaria, u.activo ? 'Sí' : 'No', fechaLocal(u.creado), fechaLocal(u.ultimo_ingreso), u.totp_secreto ? 'Sí' : 'No']),
      anchos: [16, 28, 14, 30, 8, 17, 17, 12],
    },
  ]);
}

function crearRespaldos({ db, config, log }) {
  const carpeta = path.resolve(config.carpetaRespaldos);

  function respaldar(motivo) {
    const llave = ajuste(db, 'llave_respaldo');
    if (!llave) return { ok: false, error: 'Todavía no se configuró la llave de los respaldos (panel de Administración).' };
    fs.mkdirSync(carpeta, { recursive: true });
    const ahora = new Date();
    const base = `respaldo_${sello(ahora)}`;
    // 1) Planilla legible en Excel.
    fs.writeFileSync(path.join(carpeta, base + '_planilla.rcd'), cifrarRespaldo(planilla(db), `Red_Central_de_Datos_${sello(ahora)}.xlsx`, llave));
    // 2) Copia exacta de la base (para restaurar el sistema completo).
    const tmp = path.join(os.tmpdir(), `rcd_${process.pid}_${Date.now()}.db`);
    try {
      db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      fs.writeFileSync(path.join(carpeta, base + '_base.rcd'), cifrarRespaldo(fs.readFileSync(tmp), `red-central_${sello(ahora)}.db`, llave));
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    // Se conservan los más recientes.
    const archivos = listar();
    const sobran = [...new Set(archivos.map(a => a.nombre.replace(/_(planilla|base)\.rcd$/, '')))].slice(config.respaldosAConservar);
    archivos.filter(a => sobran.includes(a.nombre.replace(/_(planilla|base)\.rcd$/, ''))).forEach(a => fs.rmSync(path.join(carpeta, a.nombre), { force: true }));
    fijarAjuste(db, 'ultimo_respaldo', ahora.toISOString());
    log('sistema', '', 'respaldo', `${motivo}: ${base}`);
    return { ok: true, nombre: base };
  }

  function listar() {
    if (!fs.existsSync(carpeta)) return [];
    return fs.readdirSync(carpeta).filter(n => /^respaldo_[\d_-]+_(planilla|base)\.rcd$/.test(n))
      .map(n => ({ nombre: n, bytes: fs.statSync(path.join(carpeta, n)).size }))
      .sort((a, b) => (a.nombre < b.nombre ? 1 : -1));
  }

  function leer(nombre) {
    if (!/^respaldo_[\d_-]+_(planilla|base)\.rcd$/.test(String(nombre))) return null;
    const ruta = path.join(carpeta, nombre);
    return fs.existsSync(ruta) ? fs.readFileSync(ruta) : null;
  }

  /* Tarea nocturna: verificación de integridad + respaldo, una vez por día a la hora configurada. */
  function programar() {
    const tarea = () => {
      const ahora = new Date();
      const hoy = sello(ahora).slice(0, 10);
      const [h, m] = String(config.horaRespaldo).split(':').map(Number);
      if (ahora.getHours() * 60 + ahora.getMinutes() < h * 60 + m || ajuste(db, 'tarea_nocturna') === hoy) return;
      fijarAjuste(db, 'tarea_nocturna', hoy);
      try {
        const v = verificar(db);
        fijarAjuste(db, 'ultima_verificacion', JSON.stringify({ ok: v.ok, eventos: v.eventos, hash: v.hash, fecha: v.fecha, problemas: v.problemas.slice(0, 20) }));
        if (!v.ok) log('sistema', '', 'ALERTA de integridad', v.problemas.slice(0, 3).join(' | '));
        const r = respaldar('Respaldo diario');
        if (!r.ok) log('sistema', '', 'respaldo no realizado', r.error);
      } catch (e) {
        console.error('[tarea nocturna]', e);
        log('sistema', '', 'error en tarea nocturna', String(e.message || e));
      }
    };
    setInterval(tarea, 60 * 1000).unref();
    setTimeout(tarea, 5000).unref();
  }

  return { respaldar, listar, leer, programar, carpeta };
}

module.exports = { planilla, crearRespaldos, fechaLocal };
