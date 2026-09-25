/**
 * Red Central de Datos — Municipalidad de General Rodríguez
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
  HOJA_HISTORIAL: 'Historial',
  HOJA_BARRIOS: 'Barrios',
  SESION_SEGUNDOS: 6 * 60 * 60,      // 6 h (máximo de CacheService)
  MAX_INTENTOS_LOGIN: 5,
  BLOQUEO_LOGIN_SEGUNDOS: 15 * 60,
  CARPETA_RESPALDOS: 'Respaldos Red Central de Datos',
  ZONA_HORARIA: 'America/Argentina/Buenos_Aires',
};

const PERFILES = ['Carga', 'Análisis'];
const VINCULOS = ['Titular', 'Destinatario', 'Inquilino', 'Familiar'];
const PARENTESCOS = ['Hijo/a', 'Esposo/a', 'Hermano/a', 'Padre/Madre', 'Otro'];

/*
 * Listado inicial de barrios (se copia a la hoja «Barrios» al ejecutar setup).
 * Es PROVISORIO: reemplazarlo por el listado oficial directamente en la hoja «Barrios»;
 * la app toma siempre lo que haya en esa hoja.
 */
const BARRIOS_INICIALES = ['Agua de Oro', 'Centro', 'El Rincón', 'General Güemes', 'Ruta 24 Km 10'];

const L_ = 'A-Za-zÁÉÍÓÚÜÑáéíóúüñ';
const reNombre_ = new RegExp(`^[${L_}][${L_}' ]{1,59}$`);
const reBarrio_ = new RegExp(`^[${L_}0-9][${L_}0-9.'°º ]{1,59}$`);
const reCelular_ = /^(11\d{8}|[23]\d{9})$/;

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
  { clave: 'celular', columna: 'Teléfono celular', ok: v => reCelular_.test(v) },
  { clave: 'celular2', columna: 'Teléfono celular 2', opcional: true, ok: v => reCelular_.test(v) },
  { clave: 'mail', columna: 'Mail', ok: v => /^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9_%+-])?@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(v) && v.indexOf('..') < 0 },
  { clave: 'calle', columna: 'Calle', ok: v => new RegExp(`^(\\d+ )?[${L_}][${L_}.' ]{1,79}$`).test(v) },
  { clave: 'numero', columna: 'Número', ok: v => v === 'S/N' || /^[1-9]\d{0,5}$/.test(v) },
  { clave: 'piso', columna: 'Piso/Depto', opcional: true, ok: v => /^[A-ZÑ0-9°º][A-ZÑ0-9°º ]{0,9}$/.test(v) },
  { clave: 'barrio', columna: 'Barrio', ok: v => v === 'Otro' || (barrios_().length ? barrios_().indexOf(v) >= 0 : reBarrio_.test(v)) },
  { clave: 'barrioOtro', columna: 'Barrio (otro)', ok: v => reBarrio_.test(v) },
  { clave: 'vinculo', columna: 'Vínculo', etiqueta: 'A quién corresponde', texto: false, noEsDato: true, ok: v => VINCULOS.indexOf(v) >= 0 },
  { clave: 'parentesco', columna: 'Parentesco', texto: false, noEsDato: true, ok: v => PARENTESCOS.indexOf(v) >= 0 },
  { clave: 'parentescoOtro', columna: 'Parentesco (otro)', noEsDato: true, ok: v => reNombre_.test(v) },
  { clave: 'partidaInmueble', columna: 'Partida Municipal Inmueble', opcional: true, ok: v => /^\d{1,12}$/.test(v) },
  { clave: 'partidaComercio', columna: 'Partida Municipal Comercio', opcional: true, ok: v => /^\d{1,12}$/.test(v) },
  { clave: 'comentarios', columna: 'Comentarios', opcional: true, noEsDato: true, ok: v => v.length <= 500 },
];
const CAMPO_ = {};
CAMPOS.forEach(c => { CAMPO_[c.clave] = c; });

/* Campos que dependen de otro: si se modifica el primero, también se validan / guardan estos. */
const DEPENDIENTES = { barrio: ['barrioOtro'], vinculo: ['parentesco', 'parentescoOtro'], parentesco: ['parentescoOtro'], dni: ['cuit'], cuit: ['dni'] };

/* Actualizaciones sobre una ficha existente: qué campos puede tocar cada acción. */
const ACCIONES = {
  telefono: { nombre: 'Nuevo teléfono', campos: ['celular', 'celular2'] },
  domicilio: { nombre: 'Nuevo domicilio', campos: ['calle', 'numero', 'piso', 'barrio', 'barrioOtro'] },
  correccion: { nombre: 'Corrección de datos', campos: CAMPOS.map(c => c.clave) },
};

/* Búsquedas permitidas (siempre por coincidencia exacta). */
const BUSQUEDAS = { dni: 'dni', cuit: 'cuit', partidaInmueble: 'partidaInmueble', partidaComercio: 'partidaComercio' };

const COLUMNAS_REGISTROS = ['ID', 'Ref', 'Fecha de carga', 'Secretaría', 'Usuario']
  .concat(CAMPOS.map(c => c.columna), ['Última edición', 'Editado por']);
const COLUMNAS_USUARIOS = ['Usuario', 'Nombre', 'Perfil', 'Secretaría', 'Activo', 'Salt', 'Hash', 'Creado'];
const COLUMNAS_HISTORIAL = ['Fecha', 'Usuario', 'Secretaría', 'ID', 'Acción', 'Campo', 'Valor anterior', 'Valor nuevo'];

/* ============================== API ============================== */

function doGet() {
  return json_({ ok: true, servicio: 'Red Central de Datos', version: 3 });
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
      case 'sesion': return json_({ ok: true, usuario: sesion_(req.token), config: config_() });
      case 'logout': cerrarSesion_(req.token); return json_({ ok: true });
      case 'guardar': return json_(guardar_(sesion_(req.token), req.datos));
      case 'editar': return json_(editar_(sesion_(req.token), req.ref, req.datos));
      case 'buscar': return json_(buscar_(sesion_(req.token), req.tipo, req.valor, req.excluir));
      case 'actualizar': return json_(actualizar_(sesion_(req.token), req.ref, req.accion, req.cambios));
      case 'estadisticas': return json_(estadisticas_(sesion_(req.token), req.desde, req.hasta));
      default: return json_({ ok: false, error: 'Acción desconocida.' });
    }
  } catch (err) {
    const msg = err && err.publico ? err.message : 'Error interno. Intentá nuevamente.';
    if (!(err && err.publico)) console.error(err && err.stack || err);
    return json_({
      ok: false, error: msg,
      sesionVencida: !!(err && err.sesionVencida),
      existe: !!(err && err.existe),
      coincidencias: (err && err.coincidencias) || undefined,
    });
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
  return { ok: true, token: token, usuario: datos, config: config_() };
}

/** Datos de configuración que necesita el formulario (listas editables desde la planilla). */
function config_() {
  return { barrios: barrios_() };
}

let barriosCache_ = null;
function barrios_() {
  if (barriosCache_) return barriosCache_;
  const h = SpreadsheetApp.getActive().getSheetByName(CONFIG.HOJA_BARRIOS);
  barriosCache_ = h && h.getLastRow() > 1
    ? h.getRange(2, 1, h.getLastRow() - 1, 1).getValues().map(f => String(f[0]).trim()).filter(Boolean)
    : [];
  return barriosCache_;
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

/**
 * Limpia y valida los datos. opciones.validar: claves a validar (por defecto, todas).
 * opciones.alta: exige que haya al menos un dato del contribuyente.
 */
function normalizar_(datos, opciones) {
  opciones = opciones || {};
  datos = datos || {};
  const out = {};
  CAMPOS.forEach(c => { out[c.clave] = String(datos[c.clave] == null ? '' : datos[c.clave]).trim(); });
  out.mail = out.mail.toLowerCase();
  out.piso = out.piso.toUpperCase();
  out.comentarios = out.comentarios.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '');
  if (out.barrio !== 'Otro') out.barrioOtro = '';
  if (out.vinculo !== 'Familiar') out.parentesco = '';
  if (out.parentesco !== 'Otro') out.parentescoOtro = '';

  const aValidar = opciones.validar ? conDependientes_(opciones.validar) : CAMPOS.map(c => c.clave);
  const invalidos = aValidar
    .filter(k => out[k] !== '' && !CAMPO_[k].ok(out[k]))
    .map(k => CAMPO_[k].etiqueta || CAMPO_[k].columna);
  if (invalidos.length === 0 && aValidar.indexOf('dni') >= 0 && out.dni && out.cuit && /^2[0347]/.test(out.cuit) && out.cuit.substr(2, 8) !== ('00000000' + out.dni).slice(-8)) {
    invalidos.push('CUIT/CUIL (no coincide con el DNI)');
  }
  if (invalidos.length) throw errorPublico_('Formato incorrecto en: ' + invalidos.join(', ') + '.');

  if (opciones.alta && !CAMPOS.some(c => !c.noEsDato && out[c.clave] !== '')) throw errorPublico_('El formulario está vacío.');
  return out;
}

function conDependientes_(claves) {
  const set = {};
  claves.forEach(k => { set[k] = true; (DEPENDIENTES[k] || []).forEach(d => { set[d] = true; }); });
  return Object.keys(set).filter(k => CAMPO_[k]);
}

/** Valor a escribir en la celda. Texto con ' inicial: Sheets no convierte números ni interpreta fórmulas. */
function celda_(campo, v) {
  return v === '' || campo.texto === false ? v : "'" + v;
}

/* ---------- Acceso a filas ---------- */

function refNueva_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 16);
}

function filasDe_(hoja, m, columna, valor) {
  const n = hoja.getLastRow() - 1;
  if (n < 1 || !(columna in m)) return [];
  return hoja.getRange(2, m[columna] + 1, n, 1).createTextFinder(String(valor)).matchEntireCell(true).findAll()
    .map(c => c.getRow());
}

function filaDeRef_(hoja, m, ref) {
  if (!ref || !/^[a-f0-9]{16}$/.test(String(ref))) return 0;
  const filas = filasDe_(hoja, m, 'Ref', ref);
  return filas.length ? filas[0] : 0;
}

/** Ficha de una fila, tal como la ve el usuario. El ID interno solo se envía al perfil Análisis. */
function ficha_(hoja, m, fila, u) {
  const v = hoja.getRange(fila, 1, 1, m._ancho).getValues()[0];
  let ref = String(v[m['Ref']] || '');
  if (!ref) { // registros anteriores a la columna Ref
    ref = refNueva_();
    hoja.getRange(fila, m['Ref'] + 1).setValue(ref);
  }
  const datos = {};
  CAMPOS.forEach(c => { datos[c.clave] = String(v[m[c.columna]] == null ? '' : v[m[c.columna]]); });
  const fecha = v[m['Fecha de carga']];
  const f = {
    ref: ref,
    fecha: fecha instanceof Date ? fecha.toISOString() : String(fecha),
    secretaria: String(v[m['Secretaría']]),
    datos: datos,
  };
  if (u.perfil === 'Análisis') f.id = Number(v[m['ID']]);
  return { ficha: f, id: Number(v[m['ID']]) };
}

/** Lanza un error "existe" si el DNI o el CUIT ya están en otra ficha. */
function verificarUnico_(hoja, m, datos, u, excluirFila) {
  const filas = {};
  [['dni', 'DNI'], ['cuit', 'CUIT/CUIL']].forEach(([k, col]) => {
    if (datos[k]) filasDe_(hoja, m, col, datos[k]).forEach(f => { if (f !== excluirFila) filas[f] = true; });
  });
  const lista = Object.keys(filas).map(Number);
  if (!lista.length) return;
  throw errorPublico_('Ya existe una ficha con ese DNI o CUIT/CUIL. Actualizá la ficha existente en lugar de crear otra.', {
    existe: true,
    coincidencias: lista.slice(0, 5).map(f => ficha_(hoja, m, f, u).ficha),
  });
}

function registrarHistorial_(u, id, accion, cambios) {
  if (!cambios.length) return;
  const h = hoja_(CONFIG.HOJA_HISTORIAL);
  const ahora = new Date();
  const t = v => (v === '' ? '' : "'" + v);
  const filas = cambios.map(c => [ahora, u.usuario, u.secretaria, id, accion, c.campo, t(c.antes), t(c.despues)]);
  h.getRange(h.getLastRow() + 1, 1, filas.length, COLUMNAS_HISTORIAL.length).setValues(filas);
}

/** Escribe solo las celdas que cambian y deja constancia en el Historial. */
function aplicarCambios_(hoja, m, fila, u, accion, actual, nuevo) {
  const cambios = CAMPOS.filter(c => (actual[c.clave] || '') !== (nuevo[c.clave] || ''));
  cambios.forEach(c => hoja.getRange(fila, m[c.columna] + 1).setValue(celda_(c, nuevo[c.clave])));
  if (cambios.length) {
    hoja.getRange(fila, m['Última edición'] + 1).setValue(new Date());
    hoja.getRange(fila, m['Editado por'] + 1).setValue(u.usuario);
    const id = Number(hoja.getRange(fila, m['ID'] + 1).getValue());
    registrarHistorial_(u, id, accion, cambios.map(c => ({ campo: c.columna, antes: actual[c.clave] || '', despues: nuevo[c.clave] || '' })));
  }
  return cambios.length;
}

/* ---------- Acciones ---------- */

function guardar_(u, datosCrudos) {
  const datos = normalizar_(datosCrudos, { alta: true });
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const hoja = hoja_(CONFIG.HOJA_REGISTROS);
    const m = columnas_(hoja);
    verificarUnico_(hoja, m, datos, u, 0);
    const props = PropertiesService.getScriptProperties();
    const id = Number(props.getProperty('ultimoId') || 0) + 1;
    const ref = refNueva_();
    const ahora = new Date();
    const fila = new Array(m._ancho).fill('');
    fila[m['ID']] = id;
    fila[m['Ref']] = ref;
    fila[m['Fecha de carga']] = ahora;
    fila[m['Secretaría']] = u.secretaria;
    fila[m['Usuario']] = u.usuario;
    CAMPOS.forEach(c => { fila[m[c.columna]] = celda_(c, datos[c.clave]); });
    hoja.appendRow(fila);
    props.setProperty('ultimoId', String(id));
    // Solo la última carga de cada usuario queda editable por completo.
    props.setProperty('editable_' + u.usuario, String(id));
    const r = { ok: true, ref: ref, fecha: ahora.toISOString() };
    if (u.perfil === 'Análisis') r.id = id;
    return r;
  } finally {
    lock.releaseLock();
  }
}

/** Edición completa de la última carga del usuario (hasta que haga una nueva). */
function editar_(u, ref, datosCrudos) {
  const datos = normalizar_(datosCrudos, { alta: true });
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const hoja = hoja_(CONFIG.HOJA_REGISTROS);
    const m = columnas_(hoja);
    const fila = filaDeRef_(hoja, m, ref);
    const editable = Number(PropertiesService.getScriptProperties().getProperty('editable_' + u.usuario) || 0);
    const actual = fila ? ficha_(hoja, m, fila, u) : null;
    if (!actual || actual.id !== editable) {
      throw errorPublico_('Esa carga ya no se puede editar: solo se puede modificar la última carga realizada. Para cambiar datos, buscá la ficha y elegí «Corregir o completar un dato».');
    }
    verificarUnico_(hoja, m, datos, u, fila);
    aplicarCambios_(hoja, m, fila, u, 'Edición de la última carga', actual.ficha.datos, datos);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/** Búsqueda exacta por DNI, CUIT/CUIL o partida. Devuelve hasta 10 fichas, la más reciente primero. */
function buscar_(u, tipo, valor, excluirRef) {
  const clave = BUSQUEDAS[tipo];
  valor = String(valor || '').trim();
  if (!clave || !valor || !CAMPO_[clave].ok(valor)) throw errorPublico_('Dato de búsqueda inválido.');
  const hoja = hoja_(CONFIG.HOJA_REGISTROS);
  const m = columnas_(hoja);
  const resultados = filasDe_(hoja, m, CAMPO_[clave].columna, valor)
    .map(f => ficha_(hoja, m, f, u).ficha)
    .filter(f => f.ref !== excluirRef)
    .sort((a, b) => (a.fecha < b.fecha ? 1 : -1))
    .slice(0, 10);
  return { ok: true, resultados: resultados };
}

/** Suma o corrige datos de una ficha existente. Solo se aceptan los campos de la acción elegida. */
function actualizar_(u, ref, accion, cambios) {
  const def = ACCIONES[accion];
  if (!def) throw errorPublico_('Acción inválida.');
  cambios = cambios || {};
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const hoja = hoja_(CONFIG.HOJA_REGISTROS);
    const m = columnas_(hoja);
    const fila = filaDeRef_(hoja, m, ref);
    if (!fila) throw errorPublico_('No se encontró la ficha.');
    const actual = ficha_(hoja, m, fila, u).ficha.datos;

    const mezcla = Object.assign({}, actual);
    def.campos.forEach(k => { if (k in cambios) mezcla[k] = cambios[k]; });
    const tocados = def.campos.filter(k => (k in cambios) && String(cambios[k] == null ? '' : cambios[k]).trim() !== (actual[k] || ''));
    if (!tocados.length) throw errorPublico_('No hay cambios para guardar.');
    const nuevo = normalizar_(mezcla, { validar: tocados });

    if (accion === 'telefono' && !def.campos.some(k => nuevo[k] && nuevo[k] !== actual[k])) throw errorPublico_('Escribí el teléfono nuevo.');
    if (accion === 'domicilio' && !nuevo.calle && !nuevo.barrio) throw errorPublico_('Escribí el nuevo domicilio.');
    if (tocados.indexOf('dni') >= 0 || tocados.indexOf('cuit') >= 0) verificarUnico_(hoja, m, nuevo, u, fila);

    aplicarCambios_(hoja, m, fila, u, def.nombre, actual, nuevo);
    return { ok: true, datos: nuevo };
  } finally {
    lock.releaseLock();
  }
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
      celular: String(f[m['Teléfono celular']]).trim() || String(f[m['Teléfono celular 2']] || '').trim(),
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
    .createMenu('Red Central de Datos')
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
  prepararHoja_(ss, CONFIG.HOJA_HISTORIAL, COLUMNAS_HISTORIAL, h => {
    h.getRange('A:A').setNumberFormat('dd/mm/yyyy hh:mm');
  });
  prepararHoja_(ss, CONFIG.HOJA_BARRIOS, ['Barrio'], h => {
    h.getRange(2, 1, BARRIOS_INICIALES.length, 1).setValues(BARRIOS_INICIALES.map(b => [b]));
    h.setColumnWidth(1, 280);
  });
  // Protección: solo el dueño puede editar (el script corre como el dueño).
  [CONFIG.HOJA_REGISTROS, CONFIG.HOJA_USUARIOS, CONFIG.HOJA_HISTORIAL, CONFIG.HOJA_BARRIOS].forEach(n => {
    const h = ss.getSheetByName(n);
    if (h.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) return;
    const p = h.protect().setDescription('Solo administrador');
    p.removeEditors(p.getEditors());
  });
  const hoja1 = ss.getSheetByName('Hoja 1') || ss.getSheetByName('Sheet1');
  if (hoja1 && ss.getSheets().length > 4 && hoja1.getLastRow() === 0) ss.deleteSheet(hoja1);
  try { SpreadsheetApp.getUi().alert('Listo. Ahora creá los usuarios desde el menú Red Central de Datos.'); } catch (e) { /* ejecutado desde el editor */ }
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
  blob.setName('Red_Central_de_Datos_' + fecha + '.xlsx');
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
