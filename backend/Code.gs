/**
 * Base Integral de Contribuyentes — Municipalidad de General Rodríguez
 * Backend en Google Apps Script (API JSON + administración desde la planilla).
 *
 * Cómo se usa (ver README.md para el paso a paso):
 *  1. Crear una Google Sheet nueva (NO compartirla con nadie).
 *  2. Extensiones > Apps Script, pegar este archivo y guardar.
 *  3. Ejecutar `setup` una vez (pide permisos).
 *  4. Implementar > Nueva implementación > Aplicación web
 *       Ejecutar como: Yo   |   Quién tiene acceso: Cualquier usuario
 *  5. Copiar la URL /exec en frontend/assets/config.js
 *
 * La planilla solo es accesible para su dueño. Los usuarios de las secretarías
 * nunca ven la hoja: hablan con esta API, que valida todo del lado del servidor.
 */

const CONFIG = {
  HOJA_REGISTROS: 'Registros',
  HOJA_USUARIOS: 'Usuarios',
  SESION_SEGUNDOS: 6 * 60 * 60,      // 6 h (máximo de CacheService)
  MAX_INTENTOS_LOGIN: 5,
  BLOQUEO_LOGIN_SEGUNDOS: 15 * 60,
  CARPETA_RESPALDOS: 'Respaldos Base Contribuyentes',
  ZONA_HORARIA: 'America/Argentina/Buenos_Aires',
};

const PERFILES = ['Carga', 'Análisis'];
const VINCULOS = ['Titular', 'Destinatario', 'Inquilino', 'Familiar'];
const PARENTESCOS = ['Hijo/a', 'Esposo/a', 'Hermano/a', 'Padre/Madre', 'Otro'];

const L_ = 'A-Za-zÁÉÍÓÚÜÑáéíóúüñ';
const reNombre_ = new RegExp(`^[${L_}][${L_}' ]{1,59}$`);

/*
 * Campos del formulario (mismas reglas que el frontend, assets/app.js).
 *  clave: nombre en la API · columna: encabezado en la hoja · ok: validador
 *  opcional: puede quedar vacío sin aviso · texto: false para listas (se guardan sin ' inicial)
 *  noEsDato: no cuenta para decidir si el formulario está vacío
 */
const CAMPOS = [
  { clave: 'apellido', columna: 'Apellido', ok: v => reNombre_.test(v) },
  { clave: 'nombre', columna: 'Nombre', ok: v => reNombre_.test(v) },
  { clave: 'dni', columna: 'DNI', ok: v => /^[1-9]\d{6,7}$/.test(v) },
  { clave: 'cuit', columna: 'CUIT/CUIL', ok: v => cuitValido_(v) },
  { clave: 'celular', columna: 'Teléfono celular', ok: v => /^(11\d{8}|[23]\d{9})$/.test(v) },
  { clave: 'mail', columna: 'Mail', ok: v => /^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9_%+-])?@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(v) && v.indexOf('..') < 0 },
  { clave: 'calle', columna: 'Calle', ok: v => new RegExp(`^(\\d+ )?[${L_}][${L_}.' ]{1,79}$`).test(v) },
  { clave: 'numero', columna: 'Número', ok: v => v === 'S/N' || /^[1-9]\d{0,5}$/.test(v) },
  { clave: 'piso', columna: 'Piso/Depto', opcional: true, ok: v => /^[A-ZÑ0-9°º][A-ZÑ0-9°º ]{0,9}$/.test(v) },
  { clave: 'barrio', columna: 'Barrio', ok: v => new RegExp(`^[${L_}0-9][${L_}0-9.'°º ]{1,59}$`).test(v) },
  { clave: 'vinculo', columna: 'Vínculo', etiqueta: 'A quién corresponde', texto: false, noEsDato: true, ok: v => VINCULOS.indexOf(v) >= 0 },
  { clave: 'parentesco', columna: 'Parentesco', texto: false, noEsDato: true, ok: v => PARENTESCOS.indexOf(v) >= 0 },
  { clave: 'parentescoOtro', columna: 'Parentesco (otro)', noEsDato: true, ok: v => reNombre_.test(v) },
  { clave: 'partidaInmueble', columna: 'Partida Municipal Inmueble', opcional: true, ok: v => /^\d{1,12}$/.test(v) },
  { clave: 'partidaComercio', columna: 'Partida Municipal Comercio', opcional: true, ok: v => /^\d{1,12}$/.test(v) },
  { clave: 'comentarios', columna: 'Comentarios', opcional: true, noEsDato: true, ok: v => v.length <= 500 },
];

const COLUMNAS_REGISTROS = ['ID', 'Fecha de carga', 'Secretaría', 'Usuario']
  .concat(CAMPOS.map(c => c.columna), ['Última edición', 'Editado por']);
const COLUMNAS_USUARIOS = ['Usuario', 'Nombre', 'Perfil', 'Secretaría', 'Activo', 'Salt', 'Hash', 'Creado'];

/* ============================== API ============================== */

function doGet() {
  return json_({ ok: true, servicio: 'Base Integral de Contribuyentes', version: 2 });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Solicitud inválida.' });
  }
  try {
    switch (req.accion) {
      case 'login': return json_(login_(req));
      case 'sesion': return json_({ ok: true, usuario: sesion_(req.token) });
      case 'logout': cerrarSesion_(req.token); return json_({ ok: true });
      case 'guardar': return json_(guardar_(sesion_(req.token), req.datos));
      case 'editar': return json_(editar_(sesion_(req.token), req.id, req.datos));
      case 'buscarDni': return json_(buscarDni_(sesion_(req.token), req.dni, req.excluir));
      case 'estadisticas': return json_(estadisticas_(sesion_(req.token), req.desde, req.hasta));
      default: return json_({ ok: false, error: 'Acción desconocida.' });
    }
  } catch (err) {
    const msg = err && err.publico ? err.message : 'Error interno. Intentá nuevamente.';
    if (!(err && err.publico)) console.error(err && err.stack || err);
    return json_({ ok: false, error: msg, sesionVencida: !!(err && err.sesionVencida) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function errorPublico_(msg, extra) {
  const err = new Error(msg);
  err.publico = true;
  Object.assign(err, extra || {});
  return err;
}

/* ============================ Sesiones ============================ */

function login_(req) {
  const usuario = String(req.usuario || '').trim().toLowerCase();
  const clave = String(req.clave || '');
  if (!usuario || !clave) throw errorPublico_('Ingresá usuario y contraseña.');

  const cache = CacheService.getScriptCache();
  const claveFallos = 'fallos_' + usuario;
  const fallos = Number(cache.get(claveFallos) || 0);
  if (fallos >= CONFIG.MAX_INTENTOS_LOGIN) {
    throw errorPublico_('Demasiados intentos fallidos. Esperá 15 minutos o pedí que te restablezcan la contraseña.');
  }

  const u = buscarUsuario_(usuario);
  if (!u || !u.activo || hash_(u.salt, clave) !== u.hash) {
    cache.put(claveFallos, String(fallos + 1), CONFIG.BLOQUEO_LOGIN_SEGUNDOS);
    throw errorPublico_('Usuario o contraseña incorrectos.');
  }
  cache.remove(claveFallos);

  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  const datos = { usuario: u.usuario, nombre: u.nombre, perfil: u.perfil, secretaria: u.secretaria };
  cache.put('sesion_' + token, JSON.stringify(datos), CONFIG.SESION_SEGUNDOS);
  return { ok: true, token: token, usuario: datos };
}

function sesion_(token) {
  const crudo = token ? CacheService.getScriptCache().get('sesion_' + token) : null;
  if (!crudo) throw errorPublico_('Tu sesión venció. Volvé a ingresar.', { sesionVencida: true });
  return JSON.parse(crudo);
}

function cerrarSesion_(token) {
  if (token) CacheService.getScriptCache().remove('sesion_' + token);
}

function buscarUsuario_(usuario) {
  const filas = hoja_(CONFIG.HOJA_USUARIOS).getDataRange().getValues();
  for (let i = 1; i < filas.length; i++) {
    const f = filas[i];
    if (String(f[0]).trim().toLowerCase() === usuario) {
      return {
        fila: i + 1,
        usuario: usuario,
        nombre: String(f[1]),
        perfil: String(f[2]),
        secretaria: String(f[3]),
        activo: f[4] === true || String(f[4]).toUpperCase() === 'SI' || String(f[4]).toUpperCase() === 'SÍ',
        salt: String(f[5]),
        hash: String(f[6]),
      };
    }
  }
  return null;
}

function hash_(salt, clave) {
  let bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + clave, Utilities.Charset.UTF_8);
  // Estiramiento simple para encarecer ataques de fuerza bruta sobre la hoja.
  for (let i = 0; i < 200; i++) {
    bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes.concat(Utilities.newBlob(salt).getBytes()));
  }
  return Utilities.base64Encode(bytes);
}

/* ============================ Registros ============================ */

/**
 * Devuelve { encabezado: índice } de la hoja Registros. Las columnas se ubican por nombre,
 * así se pueden agregar campos nuevos (o reordenar columnas) sin romper los datos existentes.
 * Si falta alguna columna conocida, la agrega al final.
 */
function columnas_(hoja) {
  const ancho = hoja.getLastColumn();
  let enc = ancho ? hoja.getRange(1, 1, 1, ancho).getValues()[0].map(String) : [];
  const faltan = COLUMNAS_REGISTROS.filter(c => enc.indexOf(c) < 0);
  if (faltan.length) {
    hoja.getRange(1, enc.length + 1, 1, faltan.length).setValues([faltan])
      .setFontWeight('bold').setBackground('#0f766e').setFontColor('#ffffff');
    enc = enc.concat(faltan);
  }
  const mapa = { _ancho: enc.length };
  enc.forEach((n, i) => { if (n && !(n in mapa)) mapa[n] = i; });
  return mapa;
}

function normalizar_(datos) {
  datos = datos || {};
  const out = {};
  CAMPOS.forEach(c => { out[c.clave] = String(datos[c.clave] == null ? '' : datos[c.clave]).trim(); });
  out.mail = out.mail.toLowerCase();
  out.piso = out.piso.toUpperCase();
  out.comentarios = out.comentarios.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '');
  if (out.vinculo !== 'Familiar') out.parentesco = '';
  if (out.parentesco !== 'Otro') out.parentescoOtro = '';

  const invalidos = CAMPOS
    .filter(c => out[c.clave] !== '' && !c.ok(out[c.clave]))
    .map(c => c.etiqueta || c.columna);
  if (invalidos.length === 0 && out.dni && out.cuit && /^2[0347]/.test(out.cuit) && out.cuit.substr(2, 8) !== ('00000000' + out.dni).slice(-8)) {
    invalidos.push('CUIT/CUIL (no coincide con el DNI)');
  }
  if (invalidos.length) throw errorPublico_('Formato incorrecto en: ' + invalidos.join(', ') + '.');

  if (!CAMPOS.some(c => !c.noEsDato && out[c.clave] !== '')) throw errorPublico_('El formulario está vacío.');
  return out;
}

/** Valor a escribir en la celda. Texto con ' inicial: Sheets no convierte números ni interpreta fórmulas. */
function celda_(campo, v) {
  return v === '' || campo.texto === false ? v : "'" + v;
}

function guardar_(u, datosCrudos) {
  const datos = normalizar_(datosCrudos);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const hoja = hoja_(CONFIG.HOJA_REGISTROS);
    const m = columnas_(hoja);
    const props = PropertiesService.getScriptProperties();
    const id = Number(props.getProperty('ultimoId') || 0) + 1;
    const ahora = new Date();
    const fila = new Array(m._ancho).fill('');
    fila[m['ID']] = id;
    fila[m['Fecha de carga']] = ahora;
    fila[m['Secretaría']] = u.secretaria;
    fila[m['Usuario']] = u.usuario;
    CAMPOS.forEach(c => { fila[m[c.columna]] = celda_(c, datos[c.clave]); });
    hoja.appendRow(fila);
    props.setProperty('ultimoId', String(id));
    // Solo la última carga de cada usuario queda editable.
    props.setProperty('editable_' + u.usuario, String(id));
    return { ok: true, id: id, fecha: ahora.toISOString() };
  } finally {
    lock.releaseLock();
  }
}

function editar_(u, id, datosCrudos) {
  id = Number(id);
  const editable = Number(PropertiesService.getScriptProperties().getProperty('editable_' + u.usuario) || 0);
  if (!id || id !== editable) {
    throw errorPublico_('Ese registro ya no se puede editar: solo se puede modificar la última carga realizada.');
  }
  const datos = normalizar_(datosCrudos);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const hoja = hoja_(CONFIG.HOJA_REGISTROS);
    const m = columnas_(hoja);
    const fila = filaDeId_(hoja, m, id);
    if (!fila) throw errorPublico_('No se encontró el registro.');
    // Celda por celda: no se tocan otras columnas que el administrador haya agregado.
    CAMPOS.forEach(c => hoja.getRange(fila, m[c.columna] + 1).setValue(celda_(c, datos[c.clave])));
    hoja.getRange(fila, m['Última edición'] + 1).setValue(new Date());
    hoja.getRange(fila, m['Editado por'] + 1).setValue(u.usuario);
    return { ok: true, id: id };
  } finally {
    lock.releaseLock();
  }
}

function filaDeId_(hoja, m, id) {
  const n = hoja.getLastRow() - 1;
  if (n < 1) return 0;
  const celda = hoja.getRange(2, m['ID'] + 1, n, 1).createTextFinder(String(id)).matchEntireCell(true).findNext();
  return celda ? celda.getRow() : 0;
}

/** Aviso de DNI ya cargado (no bloquea el guardado). */
function buscarDni_(u, dni, excluir) {
  dni = String(dni || '');
  if (!/^[1-9]\d{6,7}$/.test(dni)) throw errorPublico_('DNI inválido.');
  const hoja = hoja_(CONFIG.HOJA_REGISTROS);
  const m = columnas_(hoja);
  const n = hoja.getLastRow() - 1;
  if (n < 1) return { ok: true, cantidad: 0 };
  const filas = hoja.getRange(2, m['DNI'] + 1, n, 1).createTextFinder(dni).matchEntireCell(true).findAll()
    .map(c => hoja.getRange(c.getRow(), 1, 1, m._ancho).getValues()[0])
    .filter(f => Number(f[m['ID']]) !== Number(excluir || 0));
  if (!filas.length) return { ok: true, cantidad: 0 };
  const ultima = filas.reduce((a, b) => (Number(b[m['ID']]) > Number(a[m['ID']]) ? b : a));
  const fecha = ultima[m['Fecha de carga']];
  return {
    ok: true,
    cantidad: filas.length,
    ultimo: {
      id: Number(ultima[m['ID']]),
      secretaria: String(ultima[m['Secretaría']]),
      fecha: fecha instanceof Date ? fecha.toISOString() : String(fecha),
    },
  };
}

/* ========================== Estadísticas ========================== */

function estadisticas_(u, desde, hasta) {
  if (u.perfil !== 'Análisis') throw errorPublico_('Tu perfil no tiene acceso a estadísticas.');
  const hoja = hoja_(CONFIG.HOJA_REGISTROS);
  const m = columnas_(hoja);
  const filas = hoja.getDataRange().getValues().slice(1).filter(f => f[m['ID']] !== '');
  const regs = filas.map(f => {
    const fecha = f[m['Fecha de carga']] instanceof Date ? f[m['Fecha de carga']] : new Date(f[m['Fecha de carga']]);
    return {
      fecha: fecha,
      clave: isNaN(fecha.getTime()) ? '' : Utilities.formatDate(fecha, CONFIG.ZONA_HORARIA, 'yyyy-MM-dd'),
      secretaria: String(f[m['Secretaría']] || 'Sin secretaría'),
      celular: String(f[m['Teléfono celular']]).trim(),
      mail: String(f[m['Mail']]).trim(),
      vinculo: String(f[m['Vínculo']] || ''),
    };
  });
  const hoy = Utilities.formatDate(new Date(), CONFIG.ZONA_HORARIA, 'yyyy-MM-dd');
  return Object.assign({ ok: true }, calcularEstadisticas_(regs, desde, hasta, hoy));
}

/**
 * Misma lógica que el modo demo del frontend (assets/app.js → calcularEstadisticas).
 * regs: [{ fecha: Date, clave: 'yyyy-MM-dd', secretaria, celular, mail, vinculo }]
 * desde / hasta: 'yyyy-MM-dd'. desde = 'inicio' toma desde la primera carga. Por defecto, últimos 30 días.
 */
function calcularEstadisticas_(regs, desde, hasta, hoy) {
  const esFecha = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const sumarDias = (k, n) => {
    const p = k.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
  };
  const validos = regs.filter(r => r.clave);
  let h = esFecha(hasta) ? hasta : hoy;
  let d = esFecha(desde) ? desde
    : desde === 'inicio' ? validos.reduce((min, r) => (r.clave < min ? r.clave : min), h)
    : sumarDias(h, -29);
  if (d > h) { const t = d; d = h; h = t; }

  const enRango = validos.filter(r => r.clave >= d && r.clave <= h);
  const porSecretaria = {}, porVinculo = {};
  let celulares = 0, mails = 0;
  enRango.forEach(r => {
    porSecretaria[r.secretaria] = (porSecretaria[r.secretaria] || 0) + 1;
    const v = r.vinculo || 'Sin especificar';
    porVinculo[v] = (porVinculo[v] || 0) + 1;
    if (r.celular) celulares++;
    if (r.mail) mails++;
  });

  // Serie temporal: por día hasta 62 días; por mes si el período es más largo.
  const dias = Math.round((Date.parse(h) - Date.parse(d)) / 86400000) + 1;
  const granularidad = dias <= 62 ? 'dia' : 'mes';
  const serie = {};
  if (granularidad === 'dia') {
    for (let k = d; k <= h; k = sumarDias(k, 1)) serie[k] = 0;
    enRango.forEach(r => { serie[r.clave]++; });
  } else {
    let y = Number(d.slice(0, 4)), mm = Number(d.slice(5, 7));
    const fin = h.slice(0, 7);
    for (let k = d.slice(0, 7); k <= fin; ) {
      serie[k] = 0;
      mm++; if (mm > 12) { mm = 1; y++; }
      k = y + '-' + ('0' + mm).slice(-2);
    }
    enRango.forEach(r => { serie[r.clave.slice(0, 7)]++; });
  }

  const ordenar = obj => Object.keys(obj).map(k => ({ nombre: k, cantidad: obj[k] })).sort((a, b) => b.cantidad - a.cantidad);
  return {
    desde: d,
    hasta: h,
    total: enRango.length,
    celulares: celulares,
    mails: mails,
    ultimos7: validos.filter(r => r.clave >= sumarDias(hoy, -6) && r.clave <= hoy).length, // hoy y los 6 días anteriores
    porSecretaria: ordenar(porSecretaria),
    porVinculo: ordenar(porVinculo),
    granularidad: granularidad,
    serie: Object.keys(serie).map(k => ({ clave: k, cantidad: serie[k] })),
    generado: new Date().toISOString(),
  };
}

/* ========================= Administración ========================= */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Contribuyentes')
    .addItem('Preparar hojas', 'setup')
    .addSeparator()
    .addItem('Crear usuario…', 'menuCrearUsuario')
    .addItem('Cambiar contraseña…', 'menuCambiarClave')
    .addItem('Activar / desactivar usuario…', 'menuActivarUsuario')
    .addSeparator()
    .addItem('Generar respaldo .xlsx ahora', 'respaldoXlsx')
    .addItem('Programar respaldo .xlsx diario', 'programarRespaldoDiario')
    .addToUi();
}

function setup() {
  const ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone(CONFIG.ZONA_HORARIA);
  const registros = prepararHoja_(ss, CONFIG.HOJA_REGISTROS, COLUMNAS_REGISTROS);
  const m = columnas_(registros); // agrega columnas nuevas si la hoja ya existía
  const filas = registros.getMaxRows() - 1;
  ['Fecha de carga', 'Última edición'].forEach(c => registros.getRange(2, m[c] + 1, filas, 1).setNumberFormat('dd/mm/yyyy hh:mm'));
  registros.getRange(2, m['Comentarios'] + 1, filas, 1).setWrap(true);
  prepararHoja_(ss, CONFIG.HOJA_USUARIOS, COLUMNAS_USUARIOS, h => {
    h.hideColumns(6, 2); // Salt y Hash
  });
  // Protección: solo el dueño puede editar (el script corre como el dueño).
  [CONFIG.HOJA_REGISTROS, CONFIG.HOJA_USUARIOS].forEach(n => {
    const h = ss.getSheetByName(n);
    if (h.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) return;
    const p = h.protect().setDescription('Solo administrador');
    p.removeEditors(p.getEditors());
  });
  const hoja1 = ss.getSheetByName('Hoja 1') || ss.getSheetByName('Sheet1');
  if (hoja1 && ss.getSheets().length > 2 && hoja1.getLastRow() === 0) ss.deleteSheet(hoja1);
  try { SpreadsheetApp.getUi().alert('Listo. Ahora creá los usuarios desde el menú Contribuyentes.'); } catch (e) { /* ejecutado desde el editor */ }
}

function prepararHoja_(ss, nombre, columnas, extra) {
  let h = ss.getSheetByName(nombre);
  if (!h) h = ss.insertSheet(nombre);
  if (h.getLastRow() === 0) {
    h.getRange(1, 1, 1, columnas.length).setValues([columnas])
      .setFontWeight('bold').setBackground('#0f766e').setFontColor('#ffffff');
    h.setFrozenRows(1);
    if (extra) extra(h);
  }
  return h;
}

function hoja_(nombre) {
  const h = SpreadsheetApp.getActive().getSheetByName(nombre);
  if (!h) throw errorPublico_('La base no está inicializada. El administrador debe ejecutar "Preparar hojas".');
  return h;
}

/** También se puede llamar desde el editor: crearUsuario('jperez', 'Clave123', 'Carga', 'Secretaría de Salud', 'Juan Pérez') */
function crearUsuario(usuario, clave, perfil, secretaria, nombre) {
  usuario = String(usuario || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) throw new Error('Usuario inválido (3 a 30 caracteres: letras, números, punto, guion).');
  if (String(clave || '').length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres.');
  if (PERFILES.indexOf(perfil) < 0) throw new Error('Perfil inválido. Usá "Carga" o "Análisis".');
  if (!secretaria) throw new Error('Indicá la secretaría.');
  if (buscarUsuario_(usuario)) throw new Error('Ese usuario ya existe.');
  const salt = Utilities.getUuid();
  hoja_(CONFIG.HOJA_USUARIOS).appendRow([usuario, nombre || usuario, perfil, secretaria, true, salt, hash_(salt, clave), new Date()]);
  return usuario;
}

function menuCrearUsuario() {
  const ui = SpreadsheetApp.getUi();
  const pedir = (t, m) => {
    const r = ui.prompt(t, m, ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) throw new Error('cancelado');
    return r.getResponseText().trim();
  };
  try {
    const usuario = pedir('Nuevo usuario (1/5)', 'Nombre de usuario (ej: jperez):');
    const nombre = pedir('Nuevo usuario (2/5)', 'Nombre y apellido de la persona:');
    const secretaria = pedir('Nuevo usuario (3/5)', 'Secretaría a la que pertenece:');
    const p = pedir('Nuevo usuario (4/5)', 'Perfil: escribí 1 para "Carga" o 2 para "Análisis":');
    const clave = pedir('Nuevo usuario (5/5)', 'Contraseña inicial (mínimo 8 caracteres):');
    crearUsuario(usuario, clave, p === '2' ? 'Análisis' : 'Carga', secretaria, nombre);
    ui.alert('Usuario "' + usuario.toLowerCase() + '" creado.');
  } catch (e) {
    if (e.message !== 'cancelado') ui.alert('No se pudo crear: ' + e.message);
  }
}

function menuCambiarClave() {
  const ui = SpreadsheetApp.getUi();
  const r1 = ui.prompt('Cambiar contraseña', 'Usuario:', ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  const u = buscarUsuario_(r1.getResponseText().trim().toLowerCase());
  if (!u) return ui.alert('No existe ese usuario.');
  const r2 = ui.prompt('Cambiar contraseña', 'Nueva contraseña (mínimo 8 caracteres):', ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  const clave = r2.getResponseText();
  if (clave.length < 8) return ui.alert('La contraseña debe tener al menos 8 caracteres.');
  const salt = Utilities.getUuid();
  hoja_(CONFIG.HOJA_USUARIOS).getRange(u.fila, 6, 1, 2).setValues([[salt, hash_(salt, clave)]]);
  CacheService.getScriptCache().remove('fallos_' + u.usuario);
  ui.alert('Contraseña actualizada.');
}

function menuActivarUsuario() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Activar / desactivar', 'Usuario:', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const u = buscarUsuario_(r.getResponseText().trim().toLowerCase());
  if (!u) return ui.alert('No existe ese usuario.');
  hoja_(CONFIG.HOJA_USUARIOS).getRange(u.fila, 5).setValue(!u.activo);
  ui.alert('Usuario ' + (u.activo ? 'desactivado' : 'activado') + '.');
}

/* ============================ Respaldos ============================ */

/** Exporta la planilla completa a .xlsx dentro de una carpeta privada de tu Drive. */
function respaldoXlsx() {
  const ss = SpreadsheetApp.getActive();
  const url = 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=xlsx';
  const blob = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } }).getBlob();
  const fecha = Utilities.formatDate(new Date(), CONFIG.ZONA_HORARIA, 'yyyy-MM-dd_HHmm');
  blob.setName('Base_Contribuyentes_' + fecha + '.xlsx');
  const carpetas = DriveApp.getFoldersByName(CONFIG.CARPETA_RESPALDOS);
  const carpeta = carpetas.hasNext() ? carpetas.next() : DriveApp.createFolder(CONFIG.CARPETA_RESPALDOS);
  carpeta.createFile(blob);
}

function programarRespaldoDiario() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'respaldoXlsx')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('respaldoXlsx').timeBased().everyDays(1).atHour(23).create();
  try { SpreadsheetApp.getUi().alert('Respaldo diario programado (23 h) en la carpeta "' + CONFIG.CARPETA_RESPALDOS + '".'); } catch (e) { /* editor */ }
}

/* ============================ Utilidades ============================ */

function cuitValido_(v) {
  if (!/^(20|23|24|27|30|33|34)\d{9}$/.test(v)) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let suma = 0;
  for (let i = 0; i < 10; i++) suma += Number(v[i]) * pesos[i];
  let dv = 11 - (suma % 11);
  if (dv === 11) dv = 0;
  if (dv === 10) return false;
  return dv === Number(v[10]);
}
