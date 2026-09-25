'use strict';
/*
 * Reglas de los campos del formulario. Son las mismas que aplica el navegador
 * (frontend/assets/app.js): el servidor las vuelve a controlar porque no se puede
 * confiar en lo que llega desde afuera.
 */

const VINCULOS = ['Titular', 'Destinatario', 'Inquilino', 'Familiar'];
const PARENTESCOS = ['Hijo/a', 'Esposo/a', 'Hermano/a', 'Padre/Madre', 'Otro'];

/* Listado PROVISORIO: se reemplaza desde el panel de Administración por el oficial. */
const BARRIOS_INICIALES = ['Agua de Oro', 'Centro', 'El Rincón', 'General Güemes', 'Ruta 24 Km 10'];

const L = 'A-Za-zÁÉÍÓÚÜÑáéíóúüñ';
const reNombre = new RegExp(`^[${L}][${L}' ]{1,59}$`);
const reBarrio = new RegExp(`^[${L}0-9][${L}0-9.'°º ]{1,59}$`);
const reCalle = new RegExp(`^(\\d+ )?[${L}][${L}.' ]{1,79}$`);
const reCelular = /^(11\d{8}|[23]\d{9})$/;
const reMail = /^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9_%+-])?@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

function cuitValido(v) {
  if (!/^(20|23|24|27|30|33|34)\d{9}$/.test(v)) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let suma = 0;
  for (let i = 0; i < 10; i++) suma += Number(v[i]) * pesos[i];
  let dv = 11 - (suma % 11);
  if (dv === 11) dv = 0;
  return dv !== 10 && dv === Number(v[10]);
}

/*
 * clave: nombre en la API y en la base · etiqueta: nombre visible (planilla, historial)
 * ok(valor, ctx): validador (ctx.barrios = lista vigente) · noEsDato: no cuenta para "formulario vacío"
 * mascara: cómo se muestra a quien no es Administrador
 */
const CAMPOS = [
  { clave: 'apellido', etiqueta: 'Apellido', ok: v => reNombre.test(v) },
  { clave: 'nombre', etiqueta: 'Nombre', ok: v => reNombre.test(v) },
  { clave: 'dni', etiqueta: 'DNI', ok: v => /^[1-9]\d{6,7}$/.test(v) },
  { clave: 'cuit', etiqueta: 'CUIT/CUIL', ok: cuitValido },
  { clave: 'celular', etiqueta: 'Teléfono celular', ok: v => reCelular.test(v), mascara: 'telefono' },
  { clave: 'celular2', etiqueta: 'Teléfono celular 2', ok: v => reCelular.test(v), mascara: 'telefono' },
  { clave: 'mail', etiqueta: 'Mail', ok: v => reMail.test(v) && !v.includes('..'), mascara: 'mail' },
  { clave: 'calle', etiqueta: 'Calle', ok: v => reCalle.test(v) },
  { clave: 'numero', etiqueta: 'Número', ok: v => v === 'S/N' || /^[1-9]\d{0,5}$/.test(v) },
  { clave: 'piso', etiqueta: 'Piso/Depto', ok: v => /^[A-ZÑ0-9°º][A-ZÑ0-9°º ]{0,9}$/.test(v) },
  { clave: 'barrio', etiqueta: 'Barrio', ok: (v, ctx) => v === 'Otro' || (ctx.barrios.length ? ctx.barrios.includes(v) : reBarrio.test(v)) },
  { clave: 'barrioOtro', etiqueta: 'Barrio (otro)', ok: v => reBarrio.test(v) },
  { clave: 'vinculo', etiqueta: 'Vínculo', noEsDato: true, ok: v => VINCULOS.includes(v) },
  { clave: 'parentesco', etiqueta: 'Parentesco', noEsDato: true, ok: v => PARENTESCOS.includes(v) },
  { clave: 'parentescoOtro', etiqueta: 'Parentesco (otro)', noEsDato: true, ok: v => reNombre.test(v) },
  { clave: 'partidaInmueble', etiqueta: 'Partida Municipal Inmueble', ok: v => /^\d{1,12}$/.test(v) },
  { clave: 'partidaComercio', etiqueta: 'Partida Municipal Comercio', ok: v => /^\d{1,12}$/.test(v) },
  { clave: 'comentarios', etiqueta: 'Comentarios', noEsDato: true, ok: v => v.length <= 500, mascara: 'texto' },
];
const CAMPO = Object.fromEntries(CAMPOS.map(c => [c.clave, c]));
const CLAVES = CAMPOS.map(c => c.clave);

/* Si se modifica el primero, también se validan y guardan estos. */
const DEPENDIENTES = { barrio: ['barrioOtro'], vinculo: ['parentesco', 'parentescoOtro'], parentesco: ['parentescoOtro'], dni: ['cuit'], cuit: ['dni'] };

/* Actualizaciones sobre una ficha existente: qué campos puede tocar cada acción. */
const ACCIONES = {
  telefono: { nombre: 'Nuevo teléfono', campos: ['celular', 'celular2'] },
  domicilio: { nombre: 'Nuevo domicilio', campos: ['calle', 'numero', 'piso', 'barrio', 'barrioOtro'] },
  correccion: { nombre: 'Corrección de datos', campos: CLAVES },
};

/* Búsquedas permitidas: siempre por coincidencia exacta. */
const BUSQUEDAS = ['dni', 'cuit', 'partidaInmueble', 'partidaComercio'];

class ErrorPublico extends Error {
  constructor(mensaje, extra) {
    super(mensaje);
    this.publico = true;
    Object.assign(this, extra || {});
  }
}

function conDependientes(claves) {
  const s = new Set();
  claves.forEach(k => { s.add(k); (DEPENDIENTES[k] || []).forEach(d => s.add(d)); });
  return [...s].filter(k => CAMPO[k]);
}

/**
 * Limpia y valida. opciones.validar: claves a validar (por defecto todas);
 * opciones.alta: exige al menos un dato del contribuyente; opciones.barrios: lista vigente.
 */
function normalizar(datos, opciones = {}) {
  datos = datos && typeof datos === 'object' ? datos : {};
  const out = {};
  CAMPOS.forEach(c => { out[c.clave] = String(datos[c.clave] == null ? '' : datos[c.clave]).trim(); });
  out.mail = out.mail.toLowerCase();
  out.piso = out.piso.toUpperCase();
  out.comentarios = out.comentarios.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '');
  if (out.barrio !== 'Otro') out.barrioOtro = '';
  if (out.vinculo !== 'Familiar') out.parentesco = '';
  if (out.parentesco !== 'Otro') out.parentescoOtro = '';

  const ctx = { barrios: opciones.barrios || [] };
  const aValidar = opciones.validar ? conDependientes(opciones.validar) : CLAVES;
  const invalidos = aValidar.filter(k => out[k] !== '' && !CAMPO[k].ok(out[k], ctx)).map(k => CAMPO[k].etiqueta);
  if (!invalidos.length && aValidar.includes('dni') && out.dni && out.cuit && /^2[0347]/.test(out.cuit)
      && out.cuit.substr(2, 8) !== out.dni.padStart(8, '0')) {
    invalidos.push('CUIT/CUIL (no coincide con el DNI)');
  }
  if (invalidos.length) throw new ErrorPublico('Formato incorrecto en: ' + invalidos.join(', ') + '.');
  if (opciones.alta && !CAMPOS.some(c => !c.noEsDato && out[c.clave] !== '')) throw new ErrorPublico('El formulario está vacío.');
  return out;
}

/* Oculta parte de los datos de contacto a quien no es Administrador (evita "descargar" la base de a poco). */
function enmascarar(datos) {
  const d = Object.assign({}, datos);
  const ocultos = [];
  CAMPOS.forEach(c => {
    const v = d[c.clave];
    if (!c.mascara || !v) return;
    if (c.mascara === 'telefono') d[c.clave] = v.slice(0, 2) + '****' + v.slice(-4);
    if (c.mascara === 'mail') { const [u, dom] = v.split('@'); d[c.clave] = u[0] + '***@' + dom; }
    if (c.mascara === 'texto') d[c.clave] = '(oculto)';
    ocultos.push(c.clave);
  });
  return { datos: d, ocultos };
}

module.exports = {
  VINCULOS, PARENTESCOS, BARRIOS_INICIALES, CAMPOS, CAMPO, CLAVES, DEPENDIENTES, ACCIONES, BUSQUEDAS,
  ErrorPublico, normalizar, enmascarar, cuitValido, reBarrio,
};
