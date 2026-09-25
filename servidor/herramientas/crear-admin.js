'use strict';
/*
 * Crea un usuario Administrador desde la consola del servidor.
 *
 *   node herramientas/crear-admin.js                      crea un Administrador nuevo
 *   node herramientas/crear-admin.js --restablecer USUARIO  restablece contraseña y doble factor
 *                                                           de un Administrador que perdió el acceso
 *
 * Todo lo que se hace desde acá queda en el historial y aparece como ALERTA en el panel de
 * Administración: si alguien con acceso al servidor la usara sin autorización, se nota.
 */
process.removeAllListeners('warning');
const readline = require('node:readline/promises');
const { cargarConfig } = require('../lib/config');
const { abrir, transaccion } = require('../lib/db');
const S = require('../lib/seguridad');
const A = require('../lib/auditoria');
const { inicializar } = require('../lib/inicio');

(async () => {
  const config = cargarConfig();
  const db = abrir(config.baseDeDatos);
  inicializar(db);
  // Consola interactiva o respuestas enviadas por entrada estándar (para automatizar).
  const lineas = process.stdin.isTTY ? null : require('node:fs').readFileSync(0, 'utf8').split(/\r?\n/);
  const rl = lineas ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  const preguntar = async q => {
    if (!lineas) return rl.question(q);
    const l = lineas.length ? lineas.shift() : '';
    process.stdout.write(q + l + '\n');
    return l;
  };
  const autor = { usuario: 'consola-servidor', secretaria: '' };
  const log = (evento, detalle) => db.prepare('INSERT INTO accesos (fecha, usuario, ip, evento, detalle) VALUES (?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), 'consola-servidor', 'local', evento, detalle);
  const evento = (usuario, accion) => A.registrarEvento(db, {
    usuario: autor.usuario, secretaria: '', objeto: 'usuario:' + usuario, accion,
    cambios: { estado: A.estadoUsuario(db.prepare('SELECT * FROM usuarios WHERE usuario = ?').get(usuario)) },
  });

  try {
    const i = process.argv.indexOf('--restablecer');
    if (i >= 0) {
      const usuario = String(process.argv[i + 1] || '').toLowerCase();
      const u = db.prepare('SELECT * FROM usuarios WHERE usuario = ?').get(usuario);
      if (!u || u.perfil !== 'Administrador') throw new Error('No existe un Administrador con ese usuario.');
      const ok = await preguntar(`Se va a restablecer la contraseña y el doble factor de «${usuario}». Queda registrado. ¿Continuar? (si/no) `);
      if (!/^s/i.test(ok.trim())) return console.log('Cancelado.');
      const temporal = S.claveTemporal();
      transaccion(db, () => {
        db.prepare("UPDATE usuarios SET clave_hash = ?, debe_cambiar_clave = 1, totp_secreto = '', fallos = 0, bloqueado_hasta = 0, activo = 1 WHERE usuario = ?")
          .run(S.hashClave(temporal), usuario);
        evento(usuario, 'Usuario: restablecido desde la consola del servidor');
        log('ALERTA: Administrador restablecido desde la consola del servidor', usuario);
      });
      console.log(`\nContraseña temporal de «${usuario}»: ${temporal}\nAl ingresar deberá elegir una contraseña nueva y volver a configurar el doble factor.`);
      return;
    }

    console.log('Crear usuario Administrador de la Red Central de Datos\n');
    const usuario = (await preguntar('Usuario (ej: jperez): ')).trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) throw new Error('Usuario inválido: de 3 a 30 caracteres, letras minúsculas, números, punto o guion.');
    if (db.prepare('SELECT 1 FROM usuarios WHERE usuario = ?').get(usuario)) throw new Error('Ya existe ese usuario.');
    const nombre = (await preguntar('Nombre y apellido: ')).trim();
    const secretaria = (await preguntar('Secretaría: ')).trim();
    if (nombre.length < 3 || secretaria.length < 3) throw new Error('Completá nombre y secretaría.');
    const temporal = S.claveTemporal();
    const hayAdmins = db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE perfil = 'Administrador'").get().n;
    transaccion(db, () => {
      db.prepare("INSERT INTO usuarios (usuario, nombre, perfil, secretaria, clave_hash, creado) VALUES (?, ?, 'Administrador', ?, ?, ?)")
        .run(usuario, nombre, secretaria, S.hashClave(temporal), new Date().toISOString());
      evento(usuario, 'Usuario: alta de Administrador desde la consola del servidor');
      log(hayAdmins ? 'ALERTA: Administrador creado desde la consola del servidor' : 'primer Administrador creado desde la consola del servidor', usuario);
    });
    console.log(`\nListo. Contraseña temporal: ${temporal}`);
    console.log('Al ingresar por primera vez, el sistema pide elegir una contraseña propia y activar el doble factor');
    console.log('(Microsoft Authenticator o Google Authenticator en el celular).');
  } catch (e) {
    console.error('Error:', e.message);
    process.exitCode = 1;
  } finally {
    if (rl) rl.close();
    db.close();
  }
})();
