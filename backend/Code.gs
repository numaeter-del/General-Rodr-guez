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

const COLUMNAS_REGISTROS = [
  'ID', 'Fecha de carga', 'Secretaría', 'Usuario',
  'Apellido', 'Nombre', 'DNI', 'CUIT/CUIL',
  'Teléfono celular', 'Mail', 'Calle', 'Número',
  'Vínculo', 'Parentesco', 'Última edición', 'Editado por',
];
const COLUMNAS_USUARIOS = ['Usuario', 'Nombre', 'Perfil', 'Secretaría', 'Activo', 'Salt', 'Hash', 'Creado'];

/* Campos del formulario: [clave, etiqueta, validador]. Mismas reglas que el frontend. */
const CAMPOS = [
  ['apellido', 'Apellido', v => /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ' ]{2,60}$/.test(v)],
  ['nombre', 'Nombre', v => /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ' ]{2,60}$/.test(v)],
  ['dni', 'DNI', v => /^[1-9]\d{6,7}$/.test(v)],
  ['cuit', 'CUIT/CUIL', v => cuitValido_(v)],
  ['celular', 'Teléfono celular', v => /^(11\d{8}|[23]\d{9})$/.test(v)],
  ['mail', 'Mail', v => /^[A-Za-z0-9](?:[A-Za-z0-9._%+-]{0,62}[A-Za-z0-9_%+-])?@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/.test(v) && v.indexOf('..') < 0],
  ['calle', 'Calle', v => /^(\d+ )?[A-Za-zÁÉÍÓÚÜÑáéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ.' ]{1,79}$/.test(v)],
  ['numero', 'Número', v => v === 'S/N' || /^[1-9]\d{0,5}$/.test(v)],
  ['vinculo', 'A quién corresponde', v => VINCULOS.indexOf(v) >= 0],
  ['parentesco', 'Parentesco', v => PARENTESCOS.indexOf(v) >= 0],
];

/* ============================== API ============================== */

function doGet() {
  return json_({ ok: true, servicio: 'Base Integral de Contribuyentes', version: 1 });
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
      case 'estadisticas': return json_(estadisticas_(sesion_(req.token)));
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

function normalizar_(datos) {
  datos = datos || {};
  const out = {};
  CAMPOS.forEach(([clave]) => { out[clave] = String(datos[clave] == null ? '' : datos[clave]).trim(); });
  out.mail = out.mail.toLowerCase();
  if (out.vinculo !== 'Familiar') out.parentesco = '';

  const invalidos = CAMPOS
    .filter(([clave, , ok]) => out[clave] !== '' && !ok(out[clave]))
    .map(([, etiqueta]) => etiqueta);
  if (invalidos.length === 0 && out.dni && out.cuit && /^2[0347]/.test(out.cuit) && out.cuit.substr(2, 8) !== ('00000000' + out.dni).slice(-8)) {
    invalidos.push('CUIT/CUIL (no coincide con el DNI)');
  }
  if (invalidos.length) throw errorPublico_('Formato incorrecto en: ' + invalidos.join(', ') + '.');

  const hayDatos = CAMPOS.some(([clave]) => clave !== 'vinculo' && clave !== 'parentesco' && out[clave] !== '');
  if (!hayDatos) throw errorPublico_('El formulario está vacío.');
  return out;
}

function fila_(datos) {
  // Texto plano: se antepone ' para que Sheets no convierta números ni interprete fórmulas.
  const t = v => (v === '' ? '' : "'" + v);
  return [
    t(datos.apellido), t(datos.nombre), t(datos.dni), t(datos.cuit),
    t(datos.celular), t(datos.mail), t(datos.calle), t(datos.numero),
    datos.vinculo, datos.parentesco,
  ];
}

function guardar_(u, datosCrudos) {
  const datos = normalizar_(datosCrudos);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const props = PropertiesService.getScriptProperties();
    const id = Number(props.getProperty('ultimoId') || 0) + 1;
    const ahora = new Date();
    hoja_(CONFIG.HOJA_REGISTROS).appendRow([id, ahora, u.secretaria, u.usuario].concat(fila_(datos), ['', '']));
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
    const celda = hoja.getRange('A:A').createTextFinder(String(id)).matchEntireCell(true).findNext();
    if (!celda) throw errorPublico_('No se encontró el registro.');
    const fila = celda.getRow();
    hoja.getRange(fila, 5, 1, 10).setValues([fila_(datos)]);
    hoja.getRange(fila, 15, 1, 2).setValues([[new Date(), u.usuario]]);
    return { ok: true, id: id };
  } finally {
    lock.releaseLock();
  }
}

/* ========================== Estadísticas ========================== */

function estadisticas_(u) {
  if (u.perfil !== 'Análisis') throw errorPublico_('Tu perfil no tiene acceso a estadísticas.');
  const filas = hoja_(CONFIG.HOJA_REGISTROS).getDataRange().getValues().slice(1).filter(f => f[0] !== '');
  return Object.assign({ ok: true }, calcularEstadisticas_(filas.map(f => ({
    fecha: f[1] instanceof Date ? f[1] : new Date(f[1]),
    secretaria: String(f[2] || 'Sin secretaría'),
    celular: String(f[8]).trim(),
    mail: String(f[9]).trim(),
    vinculo: String(f[12] || ''),
  }))));
}

/** Misma lógica que el modo demo del frontend (assets/app.js → calcularEstadisticas). */
function calcularEstadisticas_(regs) {
  const DIA = 86400000;
  const clave = d => Utilities.formatDate(d, CONFIG.ZONA_HORARIA, 'yyyy-MM-dd');
  const hace7 = Date.now() - 7 * DIA;

  const porSecretaria = {};
  const porVinculo = {};
  const porDia = {};
  for (let i = 29; i >= 0; i--) porDia[clave(new Date(Date.now() - i * DIA))] = 0;

  let celulares = 0, mails = 0, ultimos7 = 0;
  regs.forEach(r => {
    porSecretaria[r.secretaria] = (porSecretaria[r.secretaria] || 0) + 1;
    const v = r.vinculo || 'Sin especificar';
    porVinculo[v] = (porVinculo[v] || 0) + 1;
    if (r.celular) celulares++;
    if (r.mail) mails++;
    const t = r.fecha.getTime();
    if (!isNaN(t)) {
      if (t >= hace7) ultimos7++;
      const k = clave(r.fecha);
      if (k in porDia) porDia[k]++;
    }
  });
  const ordenar = obj => Object.keys(obj).map(k => ({ nombre: k, cantidad: obj[k] })).sort((a, b) => b.cantidad - a.cantidad);
  return {
    total: regs.length,
    celulares: celulares,
    mails: mails,
    ultimos7: ultimos7,
    porSecretaria: ordenar(porSecretaria),
    porVinculo: ordenar(porVinculo),
    porDia: Object.keys(porDia).map(k => ({ fecha: k, cantidad: porDia[k] })),
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
  prepararHoja_(ss, CONFIG.HOJA_REGISTROS, COLUMNAS_REGISTROS, h => {
    h.getRange('B:B').setNumberFormat('dd/mm/yyyy hh:mm');
    h.getRange('O:O').setNumberFormat('dd/mm/yyyy hh:mm');
  });
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
