'use strict';
/*
 * Base de datos SQLite (un único archivo en el servidor municipal).
 * Usa el módulo SQLite incluido en Node.js: no hay que instalar ningún motor aparte.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { CAMPOS } = require('./campos');

const columnasCampos = CAMPOS.map(c => `"${c.clave}" TEXT NOT NULL DEFAULT ''`).join(',\n    ');

const ESQUEMA = `
  CREATE TABLE IF NOT EXISTS usuarios (
    usuario TEXT PRIMARY KEY,
    nombre TEXT NOT NULL,
    perfil TEXT NOT NULL CHECK (perfil IN ('Carga', 'Análisis', 'Administrador')),
    secretaria TEXT NOT NULL,
    activo INTEGER NOT NULL DEFAULT 1,
    clave_hash TEXT NOT NULL,
    debe_cambiar_clave INTEGER NOT NULL DEFAULT 1,
    totp_secreto TEXT NOT NULL DEFAULT '',
    creado TEXT NOT NULL,
    ultimo_ingreso TEXT NOT NULL DEFAULT '',
    fallos INTEGER NOT NULL DEFAULT 0,
    bloqueado_hasta INTEGER NOT NULL DEFAULT 0,
    ultima_carga INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS registros (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT NOT NULL UNIQUE,
    fecha TEXT NOT NULL,
    secretaria TEXT NOT NULL,
    usuario TEXT NOT NULL,
    ${columnasCampos},
    ultima_edicion TEXT NOT NULL DEFAULT '',
    editado_por TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS ix_registros_dni ON registros(dni);
  CREATE INDEX IF NOT EXISTS ix_registros_cuit ON registros(cuit);
  CREATE INDEX IF NOT EXISTS ix_registros_pinm ON registros(partidaInmueble);
  CREATE INDEX IF NOT EXISTS ix_registros_pcom ON registros(partidaComercio);
  CREATE INDEX IF NOT EXISTS ix_registros_fecha ON registros(fecha);

  -- Historial encadenado: cada evento guarda la huella (hash) del anterior.
  CREATE TABLE IF NOT EXISTS historial (
    n INTEGER PRIMARY KEY,
    fecha TEXT NOT NULL,
    usuario TEXT NOT NULL,
    secretaria TEXT NOT NULL,
    objeto TEXT NOT NULL,
    accion TEXT NOT NULL,
    cambios TEXT NOT NULL,
    hash_anterior TEXT NOT NULL,
    hash TEXT NOT NULL
  );

  -- Registro de accesos: ingresos, búsquedas, exportaciones, tareas de administración.
  CREATE TABLE IF NOT EXISTS accesos (
    n INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL,
    usuario TEXT NOT NULL,
    ip TEXT NOT NULL,
    evento TEXT NOT NULL,
    detalle TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS ix_accesos_usuario ON accesos(usuario, fecha);

  CREATE TABLE IF NOT EXISTS barrios (nombre TEXT PRIMARY KEY, orden INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS ajustes (clave TEXT PRIMARY KEY, valor TEXT NOT NULL);

  -- Nada se borra ni se reescribe desde la aplicación.
  CREATE TRIGGER IF NOT EXISTS historial_sin_cambios BEFORE UPDATE ON historial
    BEGIN SELECT RAISE(ABORT, 'El historial no se puede modificar'); END;
  CREATE TRIGGER IF NOT EXISTS historial_sin_borrado BEFORE DELETE ON historial
    BEGIN SELECT RAISE(ABORT, 'El historial no se puede borrar'); END;
  CREATE TRIGGER IF NOT EXISTS registros_sin_borrado BEFORE DELETE ON registros
    BEGIN SELECT RAISE(ABORT, 'Las fichas no se pueden borrar'); END;
  CREATE TRIGGER IF NOT EXISTS accesos_sin_cambios BEFORE UPDATE ON accesos
    BEGIN SELECT RAISE(ABORT, 'El registro de accesos no se puede modificar'); END;
  CREATE TRIGGER IF NOT EXISTS accesos_sin_borrado BEFORE DELETE ON accesos
    BEGIN SELECT RAISE(ABORT, 'El registro de accesos no se puede borrar'); END;
`;

function abrir(ruta) {
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  const db = new DatabaseSync(ruta);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec(ESQUEMA);
  // Columnas de campos agregadas en versiones posteriores (la base existente se actualiza sola).
  const existentes = new Set(db.prepare('PRAGMA table_info(registros)').all().map(c => c.name));
  CAMPOS.filter(c => !existentes.has(c.clave))
    .forEach(c => db.exec(`ALTER TABLE registros ADD COLUMN "${c.clave}" TEXT NOT NULL DEFAULT ''`));
  return db;
}

/** Ejecuta fn dentro de una transacción (todo o nada). */
function transaccion(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const ajuste = (db, clave, def = '') => {
  const f = db.prepare('SELECT valor FROM ajustes WHERE clave = ?').get(clave);
  return f ? f.valor : def;
};
const fijarAjuste = (db, clave, valor) =>
  db.prepare('INSERT INTO ajustes (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor').run(clave, String(valor));

module.exports = { abrir, transaccion, ajuste, fijarAjuste };
