'use strict';
/*
 * API de la Red Central de Datos. Mismo contrato que usa el navegador (frontend/assets/app.js):
 * POST /api con { accion, token, ... } → { ok: true, ... } o { ok: false, error }.
 */
const crypto = require('node:crypto');
const C = require('./campos');
const S = require('./seguridad');
const { transaccion, ajuste, fijarAjuste } = require('./db');
const A = require('./auditoria');
const { planilla } = require('./respaldos');

const { ErrorPublico } = C;
const PERFILES = ['Carga', 'Análisis', 'Administrador'];
const MAX_FALLOS = 5;
const BLOQUEO_MS = 15 * 60 * 1000;

function crearApi({ db, config, respaldos, log }) {
  const sesiones = new Map();         // token → sesión
  const busquedas = new Map();        // usuario → [marcas de tiempo]
  const fallosIp = new Map();         // ip → [marcas de tiempo]

  /* ---------- utilidades ---------- */
  const barrios = () => db.prepare('SELECT nombre FROM barrios ORDER BY orden').all().map(b => b.nombre);
  const configUi = () => ({ barrios: barrios() });
  const publico = u => ({ usuario: u.usuario, nombre: u.nombre, perfil: u.perfil, secretaria: u.secretaria });
  const buscarUsuario = usuario => db.prepare('SELECT * FROM usuarios WHERE usuario = ?').get(String(usuario || '').trim().toLowerCase());
  const ahoraIso = () => new Date().toISOString();

  function eventoUsuario(autor, u, accion) {
    const actual = db.prepare('SELECT * FROM usuarios WHERE usuario = ?').get(u);
    A.registrarEvento(db, { usuario: autor.usuario, secretaria: autor.secretaria, objeto: 'usuario:' + u, accion, cambios: { estado: A.estadoUsuario(actual) } });
  }

  function limpiarSesiones() {
    const ahora = Date.now();
    for (const [t, s] of sesiones) {
      if (ahora - s.ultimo > config.sesionInactividadMin * 60000 || ahora - s.creado > config.sesionMaximaHoras * 3600000) sesiones.delete(t);
    }
  }
  setInterval(limpiarSesiones, 60000).unref();

  function sesion(token, fases = ['completa']) {
    const s = token && sesiones.get(String(token));
    const ahora = Date.now();
    if (!s || ahora - s.ultimo > config.sesionInactividadMin * 60000 || ahora - s.creado > config.sesionMaximaHoras * 3600000) {
      if (s) sesiones.delete(String(token));
      throw new ErrorPublico('Tu sesión venció. Volvé a ingresar.', { sesionVencida: true });
    }
    if (!fases.includes(s.fase)) throw new ErrorPublico('Completá primero el paso de ingreso pendiente.', { sesionVencida: true });
    const u = buscarUsuario(s.usuario);
    if (!u || !u.activo) { sesiones.delete(String(token)); throw new ErrorPublico('Tu usuario está desactivado.', { sesionVencida: true }); }
    s.ultimo = ahora;
    return Object.assign(s, { u });
  }
  const exigir = (s, perfiles) => {
    if (!perfiles.includes(s.u.perfil)) throw new ErrorPublico('Tu perfil no tiene permiso para esta acción.');
  };

  /* Paso siguiente del ingreso para una sesión recién validada con contraseña. */
  function siguientePaso(s, u) {
    if (u.debe_cambiar_clave) { s.fase = 'cambiarClave'; return { paso: 'cambiarClave' }; }
    if (u.perfil === 'Administrador' || config.dobleFactorParaTodos) {
      if (!u.totp_secreto) {
        s.fase = 'configurar2fa';
        s.totpPendiente = s.totpPendiente || S.nuevoSecretoTotp();
        return { paso: 'configurar2fa', secreto: s.totpPendiente, uri: S.uriTotp(s.totpPendiente, u.usuario, 'Red Central de Datos') };
      }
      if (!s.segundoFactor) { s.fase = 'codigo'; return { paso: 'codigo' }; }
    }
    s.fase = 'completa';
    db.prepare('UPDATE usuarios SET ultimo_ingreso = ? WHERE usuario = ?').run(ahoraIso(), u.usuario);
    return { usuario: publico(u), config: configUi() };
  }

  function contarFallo(u, ip, detalle) {
    const lista = (fallosIp.get(ip) || []).filter(t => Date.now() - t < BLOQUEO_MS);
    lista.push(Date.now());
    fallosIp.set(ip, lista);
    if (u) {
      const fallos = u.fallos + 1;
      db.prepare('UPDATE usuarios SET fallos = ?, bloqueado_hasta = ? WHERE usuario = ?')
        .run(fallos >= MAX_FALLOS ? 0 : fallos, fallos >= MAX_FALLOS ? Date.now() + BLOQUEO_MS : u.bloqueado_hasta, u.usuario);
      if (fallos >= MAX_FALLOS) log(u.usuario, ip, 'usuario bloqueado 15 minutos', 'demasiados intentos fallidos');
    }
    log(u ? u.usuario : '(desconocido)', ip, 'ingreso fallido', detalle);
  }

  /* ---------- fichas ---------- */
  function ficha(r, s) {
    const datos = Object.fromEntries(C.CLAVES.map(k => [k, r[k] || '']));
    const f = { ref: r.ref, fecha: r.fecha, secretaria: r.secretaria, datos };
    if (s.u.perfil !== 'Administrador') {
      const m = C.enmascarar(datos);
      f.datos = m.datos;
      if (m.ocultos.length) f.ocultos = m.ocultos;
    }
    if (s.u.perfil !== 'Carga') f.id = r.id; // el perfil Carga no ve números de carga
    return f;
  }

  function verificarUnico(datos, s, excluirId) {
    const filas = db.prepare(`SELECT * FROM registros WHERE id <> ? AND ((dni <> '' AND dni = ?) OR (cuit <> '' AND cuit = ?)) ORDER BY fecha DESC LIMIT 5`)
      .all(excluirId || 0, datos.dni || '\u0000', datos.cuit || '\u0000');
    if (filas.length) {
      throw new ErrorPublico('Ya existe una ficha con ese DNI o CUIT/CUIL. Actualizá la ficha existente en lugar de crear otra.',
        { existe: true, coincidencias: filas.map(r => ficha(r, s)) });
    }
  }

  function aplicarCambios(s, r, nuevo, accion) {
    const cambios = C.CLAVES.filter(k => (r[k] || '') !== (nuevo[k] || '')).map(k => ({ campo: k, antes: r[k] || '', despues: nuevo[k] || '' }));
    if (!cambios.length) return 0;
    const sets = cambios.map(c => `"${c.campo}" = ?`).join(', ');
    db.prepare(`UPDATE registros SET ${sets}, ultima_edicion = ?, editado_por = ? WHERE id = ?`)
      .run(...cambios.map(c => c.despues), ahoraIso(), s.u.usuario, r.id);
    A.registrarEvento(db, { usuario: s.u.usuario, secretaria: s.u.secretaria, objeto: 'registro:' + r.id, accion, cambios });
    return cambios.length;
  }

  function limiteBusquedas(s, ip) {
    if (s.u.perfil === 'Administrador') return;
    const hora = Date.now() - 3600000;
    const lista = (busquedas.get(s.u.usuario) || []).filter(t => t > hora);
    if (lista.length >= config.limiteBusquedasPorHora) {
      if (!s.avisoLimite || Date.now() - s.avisoLimite > 3600000) {
        s.avisoLimite = Date.now();
        log(s.u.usuario, ip, 'ALERTA: límite de búsquedas alcanzado', `${lista.length} búsquedas en la última hora`);
      }
      throw new ErrorPublico(`Alcanzaste el límite de ${config.limiteBusquedasPorHora} búsquedas por hora. Si lo necesitás, pedile al Administrador que lo amplíe.`);
    }
    lista.push(Date.now());
    busquedas.set(s.u.usuario, lista);
  }

  /* ---------- estadísticas (misma lógica que el frontend) ---------- */
  const dosDig = n => String(n).padStart(2, '0');
  const claveFecha = d => { const x = new Date(d); return `${x.getFullYear()}-${dosDig(x.getMonth() + 1)}-${dosDig(x.getDate())}`; };
  const sumarDias = (k, n) => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

  function estadisticas(desde, hasta) {
    const hoy = claveFecha(Date.now());
    const esFecha = t => /^\d{4}-\d{2}-\d{2}$/.test(String(t || ''));
    const regs = db.prepare('SELECT fecha, secretaria, celular, celular2, mail, vinculo FROM registros').all()
      .map(r => Object.assign(r, { clave: claveFecha(r.fecha) }));
    let h = esFecha(hasta) ? hasta : hoy;
    let d = esFecha(desde) ? desde : desde === 'inicio' ? regs.reduce((m, r) => (r.clave < m ? r.clave : m), h) : sumarDias(h, -29);
    if (d > h) [d, h] = [h, d];
    const enRango = regs.filter(r => r.clave >= d && r.clave <= h);
    const porSecretaria = {}, porVinculo = {};
    let celulares = 0, mails = 0;
    enRango.forEach(r => {
      porSecretaria[r.secretaria] = (porSecretaria[r.secretaria] || 0) + 1;
      const v = r.vinculo || 'Sin especificar';
      porVinculo[v] = (porVinculo[v] || 0) + 1;
      if (r.celular || r.celular2) celulares++;
      if (r.mail) mails++;
    });
    const dias = Math.round((Date.parse(h) - Date.parse(d)) / 86400000) + 1;
    const granularidad = dias <= 62 ? 'dia' : 'mes';
    const serie = {};
    if (granularidad === 'dia') {
      for (let k = d; k <= h; k = sumarDias(k, 1)) serie[k] = 0;
      enRango.forEach(r => { serie[r.clave]++; });
    } else {
      let y = Number(d.slice(0, 4)), mm = Number(d.slice(5, 7));
      for (let k = d.slice(0, 7); k <= h.slice(0, 7);) {
        serie[k] = 0;
        if (++mm > 12) { mm = 1; y++; }
        k = `${y}-${dosDig(mm)}`;
      }
      enRango.forEach(r => { serie[r.clave.slice(0, 7)]++; });
    }
    const ordenar = o => Object.keys(o).map(k => ({ nombre: k, cantidad: o[k] })).sort((a, b) => b.cantidad - a.cantidad);
    const desde7 = sumarDias(hoy, -6);
    return {
      desde: d, hasta: h, total: enRango.length, celulares, mails,
      ultimos7: regs.filter(r => r.clave >= desde7 && r.clave <= hoy).length,
      porSecretaria: ordenar(porSecretaria), porVinculo: ordenar(porVinculo),
      granularidad, serie: Object.keys(serie).map(k => ({ clave: k, cantidad: serie[k] })),
      generado: ahoraIso(),
    };
  }

  /* ---------- administración ---------- */
  function exigirCodigo(s, codigo, ip, que) {
    if (!S.verificarTotp(s.u.totp_secreto, codigo)) {
      log(s.u.usuario, ip, 'código de doble factor incorrecto', que);
      throw new ErrorPublico('El código de verificación no es correcto. Mirá el que muestra tu aplicación de autenticación.');
    }
  }

  function resumenAdmin() {
    let ultimaVerif = null;
    try { ultimaVerif = JSON.parse(ajuste(db, 'ultima_verificacion', 'null')); } catch (_) { /* sin dato */ }
    const llave = ajuste(db, 'llave_respaldo');
    const alertas = db.prepare(`SELECT * FROM accesos WHERE (evento LIKE 'ALERTA%' OR evento LIKE 'usuario bloqueado%')
      AND fecha >= ? ORDER BY n DESC LIMIT 30`).all(new Date(Date.now() - 30 * 86400000).toISOString());
    const fallidos = db.prepare(`SELECT COUNT(*) AS n FROM accesos WHERE evento = 'ingreso fallido' AND fecha >= ?`).get(new Date(Date.now() - 86400000).toISOString()).n;
    return {
      registros: db.prepare('SELECT COUNT(*) AS n FROM registros').get().n,
      usuarios: db.prepare('SELECT COUNT(*) AS n FROM usuarios WHERE activo = 1').get().n,
      ultimaVerificacion: ultimaVerif,
      respaldo: {
        llave: llave ? S.huella(llave) : '',
        ultimo: ajuste(db, 'ultimo_respaldo'),
        hora: config.horaRespaldo,
        carpeta: respaldos.carpeta,
        archivos: respaldos.listar().slice(0, 40),
      },
      alertas, ingresosFallidos24h: fallidos,
      limiteBusquedasPorHora: config.limiteBusquedasPorHora,
    };
  }

  function guardarUsuario(s, datos, ip) {
    const usuario = String(datos.usuario || '').trim().toLowerCase();
    const nombre = String(datos.nombre || '').trim();
    const secretaria = String(datos.secretaria || '').trim();
    const perfil = String(datos.perfil || '');
    if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) throw new ErrorPublico('Usuario inválido: de 3 a 30 caracteres, solo letras minúsculas, números, punto o guion.');
    if (nombre.length < 3 || nombre.length > 80) throw new ErrorPublico('Escribí el nombre y apellido de la persona.');
    if (secretaria.length < 3 || secretaria.length > 80) throw new ErrorPublico('Indicá la secretaría.');
    if (!PERFILES.includes(perfil)) throw new ErrorPublico('Perfil inválido.');
    const existente = buscarUsuario(usuario);
    return transaccion(db, () => {
      if (datos.nuevo) {
        if (existente) throw new ErrorPublico('Ya existe un usuario con ese nombre.');
        const temporal = S.claveTemporal();
        db.prepare('INSERT INTO usuarios (usuario, nombre, perfil, secretaria, clave_hash, creado) VALUES (?, ?, ?, ?, ?, ?)')
          .run(usuario, nombre, perfil, secretaria, S.hashClave(temporal), ahoraIso());
        eventoUsuario(s.u, usuario, 'Usuario: alta');
        log(s.u.usuario, ip, 'admin: alta de usuario', `${usuario} (${perfil}, ${secretaria})`);
        return { claveTemporal: temporal };
      }
      if (!existente) throw new ErrorPublico('No existe ese usuario.');
      if (existente.perfil === 'Administrador' && perfil !== 'Administrador') controlarUltimoAdmin(usuario);
      db.prepare('UPDATE usuarios SET nombre = ?, perfil = ?, secretaria = ? WHERE usuario = ?').run(nombre, perfil, secretaria, usuario);
      eventoUsuario(s.u, usuario, 'Usuario: modificación');
      log(s.u.usuario, ip, 'admin: modificación de usuario', `${usuario} (${perfil}, ${secretaria})`);
      return {};
    });
  }

  function controlarUltimoAdmin(usuario) {
    const otros = db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE perfil = 'Administrador' AND activo = 1 AND usuario <> ?").get(usuario).n;
    if (!otros) throw new ErrorPublico('Tiene que quedar al menos un Administrador activo.');
  }

  /* ---------- acciones ---------- */
  const acciones = {
    /* Ingreso: contraseña → (cambio de contraseña) → (doble factor) → sesión completa */
    login(p, ip) {
      const recientes = (fallosIp.get(ip) || []).filter(t => Date.now() - t < BLOQUEO_MS);
      if (recientes.length >= 20) throw new ErrorPublico('Demasiados intentos fallidos desde esta conexión. Esperá 15 minutos.');
      const u = buscarUsuario(p.usuario);
      if (u && u.bloqueado_hasta > Date.now()) throw new ErrorPublico('Usuario bloqueado por intentos fallidos. Esperá 15 minutos o pedile al Administrador que lo desbloquee.');
      const ok = S.verificarClave(p.clave, u ? u.clave_hash : '');
      if (!u || !ok || !u.activo) {
        contarFallo(u, ip, !u ? `usuario inexistente: ${String(p.usuario || '').slice(0, 40)}` : !u.activo ? 'usuario desactivado' : 'contraseña incorrecta');
        throw new ErrorPublico('Usuario o contraseña incorrectos.');
      }
      db.prepare('UPDATE usuarios SET fallos = 0, bloqueado_hasta = 0 WHERE usuario = ?').run(u.usuario);
      const t = S.token();
      const s = { usuario: u.usuario, fase: '', creado: Date.now(), ultimo: Date.now(), ip };
      sesiones.set(t, s);
      const r = siguientePaso(s, u);
      if (s.fase === 'completa') log(u.usuario, ip, 'ingreso', '');
      return Object.assign({ token: t }, r);
    },

    cambiarClave(p, ip) {
      const s = sesion(p.token, ['cambiarClave', 'completa']);
      if (s.fase === 'completa' && !S.verificarClave(p.actual, s.u.clave_hash)) throw new ErrorPublico('La contraseña actual no es correcta.');
      const problema = S.problemaClave(p.nueva);
      if (problema) throw new ErrorPublico(problema);
      if (S.verificarClave(p.nueva, s.u.clave_hash)) throw new ErrorPublico('La contraseña nueva tiene que ser distinta de la anterior.');
      transaccion(db, () => {
        db.prepare('UPDATE usuarios SET clave_hash = ?, debe_cambiar_clave = 0 WHERE usuario = ?').run(S.hashClave(p.nueva), s.u.usuario);
        eventoUsuario(s.u, s.u.usuario, 'Usuario: cambio de contraseña');
      });
      log(s.u.usuario, ip, 'cambio de contraseña', '');
      if (s.fase === 'completa') return {};
      const r = siguientePaso(s, buscarUsuario(s.u.usuario));
      if (s.fase === 'completa') log(s.u.usuario, ip, 'ingreso', '');
      return r;
    },

    configurar2fa(p, ip) {
      const s = sesion(p.token, ['configurar2fa']);
      if (!S.verificarTotp(s.totpPendiente, p.codigo)) throw new ErrorPublico('El código no es correcto. Revisá que la hora del celular sea la correcta y probá con el código nuevo.');
      transaccion(db, () => {
        db.prepare('UPDATE usuarios SET totp_secreto = ? WHERE usuario = ?').run(s.totpPendiente, s.u.usuario);
        eventoUsuario(s.u, s.u.usuario, 'Usuario: doble factor activado');
      });
      delete s.totpPendiente;
      s.segundoFactor = true;
      log(s.u.usuario, ip, 'doble factor activado', '');
      const r = siguientePaso(s, buscarUsuario(s.u.usuario));
      if (s.fase === 'completa') log(s.u.usuario, ip, 'ingreso', 'con doble factor');
      return r;
    },

    codigo2fa(p, ip) {
      const s = sesion(p.token, ['codigo']);
      if (!S.verificarTotp(s.u.totp_secreto, p.codigo)) {
        s.intentosCodigo = (s.intentosCodigo || 0) + 1;
        contarFallo(s.u, ip, 'código de doble factor incorrecto');
        if (s.intentosCodigo >= MAX_FALLOS) sesiones.delete(String(p.token));
        throw new ErrorPublico('El código no es correcto.', { sesionVencida: s.intentosCodigo >= MAX_FALLOS });
      }
      s.segundoFactor = true;
      const r = siguientePaso(s, s.u);
      log(s.u.usuario, ip, 'ingreso', 'con doble factor');
      return r;
    },

    sesion(p) {
      const s = sesion(p.token);
      return { usuario: publico(s.u), config: configUi() };
    },

    logout(p, ip) {
      const s = sesiones.get(String(p.token || ''));
      if (s) { sesiones.delete(String(p.token)); log(s.usuario, ip, 'salida', ''); }
      return {};
    },

    guardar(p, ip) {
      const s = sesion(p.token);
      const datos = C.normalizar(p.datos, { alta: true, barrios: barrios() });
      return transaccion(db, () => {
        verificarUnico(datos, s, 0);
        const ref = crypto.randomBytes(8).toString('hex');
        const fecha = ahoraIso();
        const cols = C.CLAVES.map(k => `"${k}"`).join(', ');
        const r = db.prepare(`INSERT INTO registros (ref, fecha, secretaria, usuario, ${cols}) VALUES (?, ?, ?, ?, ${C.CLAVES.map(() => '?').join(', ')})`)
          .run(ref, fecha, s.u.secretaria, s.u.usuario, ...C.CLAVES.map(k => datos[k]));
        const id = Number(r.lastInsertRowid);
        A.registrarEvento(db, {
          usuario: s.u.usuario, secretaria: s.u.secretaria, objeto: 'registro:' + id, accion: 'Alta',
          cambios: C.CLAVES.filter(k => datos[k]).map(k => ({ campo: k, antes: '', despues: datos[k] })),
        });
        db.prepare('UPDATE usuarios SET ultima_carga = ? WHERE usuario = ?').run(id, s.u.usuario);
        const out = { ref, fecha };
        if (s.u.perfil !== 'Carga') out.id = id;
        return out;
      });
    },

    editar(p) {
      const s = sesion(p.token);
      const datos = C.normalizar(p.datos, { alta: true, barrios: barrios() });
      return transaccion(db, () => {
        const r = db.prepare('SELECT * FROM registros WHERE ref = ?').get(String(p.ref || ''));
        if (!r || r.id !== s.u.ultima_carga) {
          throw new ErrorPublico('Esa carga ya no se puede editar: solo se puede modificar la última carga realizada. Para cambiar datos, buscá la ficha y elegí «Corregir o completar un dato».');
        }
        verificarUnico(datos, s, r.id);
        aplicarCambios(s, r, datos, 'Edición de la última carga');
        return {};
      });
    },

    buscar(p, ip) {
      const s = sesion(p.token);
      const tipo = String(p.tipo || '');
      const valor = String(p.valor || '').trim();
      if (!C.BUSQUEDAS.includes(tipo) || !valor || !C.CAMPO[tipo].ok(valor, { barrios: [] })) throw new ErrorPublico('Dato de búsqueda inválido.');
      limiteBusquedas(s, ip);
      const filas = db.prepare(`SELECT * FROM registros WHERE "${tipo}" = ? AND ref <> ? ORDER BY fecha DESC LIMIT 10`).all(valor, String(p.excluir || ''));
      log(s.u.usuario, ip, 'búsqueda', `${C.CAMPO[tipo].etiqueta} ${valor} → ${filas.length} resultado(s)`);
      return { resultados: filas.map(r => ficha(r, s)) };
    },

    actualizar(p) {
      const s = sesion(p.token);
      const def = C.ACCIONES[p.que];
      if (!def) throw new ErrorPublico('Acción inválida.');
      const cambios = p.cambios && typeof p.cambios === 'object' ? p.cambios : {};
      return transaccion(db, () => {
        const r = db.prepare('SELECT * FROM registros WHERE ref = ?').get(String(p.ref || ''));
        if (!r) throw new ErrorPublico('No se encontró la ficha.');
        const actual = Object.fromEntries(C.CLAVES.map(k => [k, r[k] || '']));
        const tocados = def.campos.filter(k => k in cambios && String(cambios[k] == null ? '' : cambios[k]).trim() !== actual[k]);
        if (!tocados.length) throw new ErrorPublico('No hay cambios para guardar.');
        const mezcla = Object.assign({}, actual);
        tocados.forEach(k => { mezcla[k] = cambios[k]; });
        const nuevo = C.normalizar(mezcla, { validar: tocados, barrios: barrios() });
        if (p.que === 'telefono' && !def.campos.some(k => nuevo[k] && nuevo[k] !== actual[k])) throw new ErrorPublico('Escribí el teléfono nuevo.');
        if (p.que === 'domicilio' && !nuevo.calle && !nuevo.barrio) throw new ErrorPublico('Escribí el nuevo domicilio.');
        if (tocados.includes('dni') || tocados.includes('cuit')) verificarUnico(nuevo, s, r.id);
        aplicarCambios(s, r, nuevo, def.nombre);
        const f = ficha(Object.assign({}, r, nuevo), s);
        return { datos: f.datos, ocultos: f.ocultos };
      });
    },

    estadisticas(p) {
      const s = sesion(p.token);
      exigir(s, ['Análisis', 'Administrador']);
      return estadisticas(p.desde, p.hasta);
    },

    /* ----- Administración ----- */
    adminResumen(p, ip) {
      const s = sesion(p.token);
      exigir(s, ['Administrador']);
      const v = A.verificar(db);
      fijarAjuste(db, 'ultima_verificacion', JSON.stringify({ ok: v.ok, eventos: v.eventos, hash: v.hash, fecha: v.fecha, problemas: v.problemas.slice(0, 20) }));
      if (!v.ok) log(s.u.usuario, ip, 'ALERTA de integridad', v.problemas.slice(0, 3).join(' | '));
      const sello = p.sello && Number.isInteger(p.sello.eventos) ? { eventos: p.sello.eventos, hashGuardado: String(p.sello.hash || ''), hashActual: A.hashEn(db, p.sello.eventos) } : null;
      return Object.assign(resumenAdmin(), { verificacion: v, sello });
    },

    adminUsuarios(p) {
      exigir(sesion(p.token), ['Administrador']);
      return {
        usuarios: db.prepare('SELECT usuario, nombre, perfil, secretaria, activo, creado, ultimo_ingreso, debe_cambiar_clave, totp_secreto <> \'\' AS doble_factor, bloqueado_hasta FROM usuarios ORDER BY activo DESC, perfil, usuario').all()
          .map(u => Object.assign(u, { bloqueado: u.bloqueado_hasta > Date.now() })),
      };
    },

    adminUsuarioGuardar(p, ip) {
      const s = sesion(p.token);
      exigir(s, ['Administrador']);
      return guardarUsuario(s, p.datos || {}, ip);
    },

    adminUsuarioAccion(p, ip) {
      const s = sesion(p.token);
      exigir(s, ['Administrador']);
      const u = buscarUsuario(p.usuario);
      if (!u) throw new ErrorPublico('No existe ese usuario.');
      return transaccion(db, () => {
        switch (p.que) {
          case 'clave': {
            const temporal = S.claveTemporal();
            db.prepare('UPDATE usuarios SET clave_hash = ?, debe_cambiar_clave = 1, fallos = 0, bloqueado_hasta = 0 WHERE usuario = ?').run(S.hashClave(temporal), u.usuario);
            eventoUsuario(s.u, u.usuario, 'Usuario: contraseña restablecida');
            log(s.u.usuario, ip, 'admin: contraseña restablecida', u.usuario);
            cerrarSesionesDe(u.usuario);
            return { claveTemporal: temporal };
          }
          case 'activar':
          case 'desactivar': {
            const activo = p.que === 'activar' ? 1 : 0;
            if (!activo && u.usuario === s.u.usuario) throw new ErrorPublico('No podés desactivar tu propio usuario.');
            if (!activo && u.perfil === 'Administrador') controlarUltimoAdmin(u.usuario);
            db.prepare('UPDATE usuarios SET activo = ? WHERE usuario = ?').run(activo, u.usuario);
            eventoUsuario(s.u, u.usuario, activo ? 'Usuario: activado' : 'Usuario: desactivado');
            log(s.u.usuario, ip, activo ? 'admin: usuario activado' : 'admin: usuario desactivado', u.usuario);
            if (!activo) cerrarSesionesDe(u.usuario);
            return {};
          }
          case 'desbloquear':
            db.prepare('UPDATE usuarios SET fallos = 0, bloqueado_hasta = 0 WHERE usuario = ?').run(u.usuario);
            log(s.u.usuario, ip, 'admin: usuario desbloqueado', u.usuario);
            return {};
          case 'reiniciar2fa':
            if (u.usuario === s.u.usuario) throw new ErrorPublico('No podés reiniciar tu propio doble factor desde acá.');
            db.prepare("UPDATE usuarios SET totp_secreto = '' WHERE usuario = ?").run(u.usuario);
            eventoUsuario(s.u, u.usuario, 'Usuario: doble factor reiniciado');
            log(s.u.usuario, ip, 'admin: doble factor reiniciado', u.usuario);
            cerrarSesionesDe(u.usuario);
            return {};
          default:
            throw new ErrorPublico('Acción inválida.');
        }
      });
    },

    adminBarrios(p, ip) {
      const s = sesion(p.token);
      exigir(s, ['Administrador']);
      if (!Array.isArray(p.lista)) return { barrios: barrios() };
      const lista = [...new Set(p.lista.map(b => String(b).trim().replace(/\s+/g, ' ')).filter(Boolean))];
      const malos = lista.filter(b => !C.reBarrio.test(b) || b.toLowerCase() === 'otro');
      if (malos.length) throw new ErrorPublico('Nombres de barrio inválidos: ' + malos.slice(0, 5).join(', ') + '. Solo letras, números, espacios y puntos.');
      if (lista.length > 2000) throw new ErrorPublico('La lista es demasiado larga.');
      transaccion(db, () => guardarBarrios(db, lista, s.u));
      log(s.u.usuario, ip, 'admin: lista de barrios actualizada', `${lista.length} barrios`);
      return { barrios: lista };
    },

    adminActividad(p) {
      exigir(sesion(p.token), ['Administrador']);
      const limite = Math.min(500, Math.max(10, Number(p.limite) || 100));
      const filtro = String(p.usuario || '').trim().toLowerCase();
      if (p.tipo === 'historial') {
        const filas = filtro
          ? db.prepare('SELECT * FROM historial WHERE usuario = ? ORDER BY n DESC LIMIT ?').all(filtro, limite)
          : db.prepare('SELECT * FROM historial ORDER BY n DESC LIMIT ?').all(limite);
        return { filas: filas.map(e => ({ n: e.n, fecha: e.fecha, usuario: e.usuario, secretaria: e.secretaria, objeto: e.objeto, accion: e.accion, cambios: e.cambios, hash: e.hash })) };
      }
      const filas = filtro
        ? db.prepare('SELECT * FROM accesos WHERE usuario = ? ORDER BY n DESC LIMIT ?').all(filtro, limite)
        : db.prepare('SELECT * FROM accesos ORDER BY n DESC LIMIT ?').all(limite);
      return { filas };
    },

    adminExportar(p, ip) {
      const s = sesion(p.token);
      exigir(s, ['Administrador']);
      exigirCodigo(s, p.codigo, ip, 'exportación');
      log(s.u.usuario, ip, 'exportación de la planilla completa', '');
      const d = new Date();
      return { _archivo: planilla(db), _nombre: `Red_Central_de_Datos_${d.getFullYear()}-${dosDig(d.getMonth() + 1)}-${dosDig(d.getDate())}.xlsx`, _tipo: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    },

    adminLlave(p, ip) {
      const s = sesion(p.token);
      exigir(s, ['Administrador']);
      exigirCodigo(s, p.codigo, ip, 'cambio de llave de respaldos');
      const spki = String(p.spki || '');
      let k;
      try { k = S.llavePublica(spki); } catch (_) { throw new ErrorPublico('La llave pública no es válida.'); }
      if (k.asymmetricKeyType !== 'rsa' || k.asymmetricKeyDetails.modulusLength < 3072) throw new ErrorPublico('La llave debe ser RSA de al menos 3072 bits.');
      const habiaLlave = !!ajuste(db, 'llave_respaldo');
      transaccion(db, () => {
        fijarAjuste(db, 'llave_respaldo', spki);
        A.registrarEvento(db, { usuario: s.u.usuario, secretaria: s.u.secretaria, objeto: 'ajuste:llave_respaldo', accion: 'Ajuste: llave de respaldos', cambios: { estado: { huella: S.huella(spki) } } });
      });
      log(s.u.usuario, ip, habiaLlave ? 'ALERTA: llave de respaldos cambiada' : 'llave de respaldos creada', 'huella ' + S.huella(spki));
      const r = respaldos.respaldar('Primer respaldo con la llave nueva');
      return { huella: S.huella(spki), respaldo: r };
    },

    adminRespaldar(p, ip) {
      const s = sesion(p.token);
      exigir(s, ['Administrador']);
      const r = respaldos.respaldar(`Respaldo manual (${s.u.usuario})`);
      if (!r.ok) throw new ErrorPublico(r.error);
      return r;
    },

    adminRespaldoDescargar(p, ip) {
      const s = sesion(p.token);
      exigir(s, ['Administrador']);
      const b = respaldos.leer(p.nombre);
      if (!b) throw new ErrorPublico('No se encontró ese respaldo.');
      log(s.u.usuario, ip, 'descarga de respaldo cifrado', String(p.nombre));
      return { _archivo: b, _nombre: String(p.nombre), _tipo: 'application/octet-stream' };
    },
  };

  function cerrarSesionesDe(usuario) {
    for (const [t, s] of sesiones) if (s.usuario === usuario) sesiones.delete(t);
  }

  return async function manejar(p, ip) {
    const fn = Object.prototype.hasOwnProperty.call(acciones, p.accion) ? acciones[p.accion] : null;
    if (!fn) throw new ErrorPublico('Acción desconocida.');
    return fn(p, ip);
  };
}

/** Guarda la lista de barrios y deja constancia en el historial. Llamar dentro de una transacción. */
function guardarBarrios(db, lista, autor) {
  db.exec('DELETE FROM barrios');
  const ins = db.prepare('INSERT INTO barrios (nombre, orden) VALUES (?, ?)');
  lista.forEach((b, i) => ins.run(b, i));
  A.registrarEvento(db, {
    usuario: autor.usuario, secretaria: autor.secretaria || '', objeto: 'ajuste:barrios', accion: 'Ajuste: lista de barrios',
    cambios: { estado: { huella: A.huellaBarrios(lista), cantidad: lista.length } },
  });
}

module.exports = { crearApi, guardarBarrios, PERFILES };
