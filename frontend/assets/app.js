/* =====================================================================
   Red Central de Datos — General Rodríguez
   Lógica del frontend: login, formulario con validación estricta,
   guardado / edición y panel de estadísticas.
   ===================================================================== */
(() => {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const MODO_DEMO = !CFG.API_URL;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const icono = (id, clase = '') => `<svg class="${clase}"><use href="#i-${id}"/></svg>`;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtNum = n => Number(n).toLocaleString('es-AR');

  /* Almacenamiento del navegador (puede no estar disponible: modo privado, etc.) */
  const almacen = {
    area: a => (a === 'local' ? window.localStorage : window.sessionStorage),
    get(k, def, a) { try { const v = this.area(a).getItem(k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } },
    set(k, v, a) { try { this.area(a).setItem(k, JSON.stringify(v)); } catch (e) { /* sin almacenamiento */ } },
    del(k, a) { try { this.area(a).removeItem(k); } catch (e) { /* sin almacenamiento */ } },
  };

  /* ============================ SONIDOS ============================ */
  const Sonido = (() => {
    let ctx = null;
    let activo = almacen.get('gr_sonido', true, 'local');
    let ultimo = 0;
    function tocar(notas) {
      if (!activo) return;
      try {
        ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === 'suspended') ctx.resume();
        const t0 = ctx.currentTime + 0.01;
        notas.forEach(([frec, ini, dur, vol, tipo]) => {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.type = tipo || 'sine';
          o.frequency.setValueAtTime(frec, t0 + ini);
          g.gain.setValueAtTime(0.0001, t0 + ini);
          g.gain.exponentialRampToValueAtTime(vol, t0 + ini + 0.012);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + ini + dur);
          o.connect(g).connect(ctx.destination);
          o.start(t0 + ini);
          o.stop(t0 + ini + dur + 0.05);
        });
      } catch (e) { /* audio no disponible */ }
    }
    return {
      /* Aviso de error, al estilo del "ding" de Windows (dos notas descendentes). */
      error() {
        const ahora = Date.now();
        if (ahora - ultimo < 140) return;
        ultimo = ahora;
        tocar([[784, 0, 0.26, 0.2, 'triangle'], [1568, 0, 0.1, 0.035], [587, 0.1, 0.4, 0.2, 'triangle'], [1174, 0.1, 0.16, 0.03]]);
      },
      exito() { tocar([[659, 0, 0.22, 0.12], [988, 0.09, 0.4, 0.12]]); },
      get activo() { return activo; },
      set activo(v) { activo = v; almacen.set('gr_sonido', v, 'local'); },
    };
  })();

  /* ============================ VALIDACIONES ============================ */
  const LETRAS = 'A-Za-zÁÉÍÓÚÜÑáéíóúüñ';
  const VINCULOS = ['Titular', 'Destinatario', 'Inquilino', 'Familiar'];
  const PARENTESCOS = ['Hijo/a', 'Esposo/a', 'Hermano/a', 'Padre/Madre', 'Otro'];
  /*
   * Barrios del modo demo. Con el servidor real, la lista sale de la hoja «Barrios» de la planilla
   * (así se puede corregir o ampliar sin tocar el código). Listado PROVISORIO: reemplazar por el oficial.
   */
  const BARRIOS_DEMO = ['Agua de Oro', 'Centro', 'El Rincón', 'General Güemes', 'Ruta 24 Km 10'];

  function cuitValido(v) {
    if (!/^(20|23|24|27|30|33|34)\d{9}$/.test(v)) return false;
    const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    let suma = 0;
    for (let i = 0; i < 10; i++) suma += Number(v[i]) * pesos[i];
    let dv = 11 - (suma % 11);
    if (dv === 11) dv = 0;
    return dv !== 10 && dv === Number(v[10]);
  }

  function filtroNombre(v) {
    if (/\d/.test(v)) return 'Solo letras: no se permiten números.';
    if (new RegExp(`[^${LETRAS}' ]`).test(v)) return 'Solo letras y espacios.';
    if (/^[ ']/.test(v)) return 'Empezá con una letra.';
    if (/ {2}/.test(v)) return 'Sin espacios dobles.';
    if (v.length > 60) return 'Máximo 60 caracteres.';
    return null;
  }
  function filtroCelular(v) {
    if (/[\s\-()+.]/.test(v)) return 'Sin espacios, guiones, paréntesis ni signos: solo los 10 números (ej: 1122334455).';
    if (/\D/.test(v)) return 'Solo números.';
    if (v[0] === '0') return 'Sin el 0 inicial: empezá por el código de área (ej: 11).';
    if (!/^[123]/.test(v)) return 'El código de área empieza con 11, 2 o 3.';
    if (/^1[^1]/.test(v)) return 'Código de área inválido. Para CABA / GBA es 11 (sin 15).';
    if (v.length > 10) return 'Son exactamente 10 dígitos (área + número, sin 0 ni 15).';
    return null;
  }
  const validarCelular = v => (/^(11\d{8}|[23]\d{9})$/.test(v) ? null : `Son 10 dígitos en total (faltan ${Math.max(0, 10 - v.length)}).`);

  function filtroBarrio(v) {
    if (new RegExp(`[^0-9${LETRAS}.'°º ]`).test(v)) return 'Solo letras, números, espacios y puntos (sin comas, guiones ni símbolos).';
    if (/^[ .'°º]/.test(v)) return 'Empezá con el nombre del barrio.';
    if (/ {2}/.test(v)) return 'Sin espacios dobles.';
    if (v.length > 60) return 'Máximo 60 caracteres.';
    return null;
  }
  const validarBarrio = v => (v.replace(new RegExp(`[^0-9${LETRAS}]`, 'g'), '').length < 2 ? 'Nombre de barrio demasiado corto.' : null);

  function filtroPartida(v) {
    if (/[.\-/,\s]/.test(v)) return 'Sin puntos, guiones, barras ni espacios: escribí solo los números.';
    if (/\D/.test(v)) return 'Solo números.';
    if (v.length > 12) return 'Máximo 12 dígitos.';
    return null;
  }
  const validarNombre = v => (v.replace(/[ ']/g, '').length < 2 ? 'Escribí al menos 2 letras.' : null);
  const capitalizar = v => v.trim().toLowerCase().replace(new RegExp(`(^|[ '])([${LETRAS}])`, 'g'), (m, a, b) => a + b.toUpperCase());

  /*
   * Definición de campos. Cada campo de texto tiene:
   *  - filtro(valor): se evalúa en cada tecla. Si devuelve un mensaje, la tecla se rechaza
   *    (no se puede seguir escribiendo), el campo se pone en rojo y suena el aviso.
   *  - validar(valor): se evalúa al salir del campo y al guardar (formato completo).
   * opcional: true → no se reclama si queda vacío.  esDato: false → no cuenta como dato del contribuyente.
   */
  const CAMPOS = [
    {
      id: 'apellido', grupo: 'personal', etiqueta: 'Apellido', icono: 'user',
      formato: 'Solo letras', ejemplo: 'González', capitalizar: true,
      filtro: filtroNombre, validar: validarNombre,
    },
    {
      id: 'nombre', grupo: 'personal', etiqueta: 'Nombre', icono: 'user',
      formato: 'Solo letras', ejemplo: 'María José', capitalizar: true,
      filtro: filtroNombre, validar: validarNombre,
    },
    {
      id: 'dni', grupo: 'personal', etiqueta: 'DNI', icono: 'idcard', teclado: 'numeric',
      formato: 'Solo números, sin puntos', ejemplo: '12345678',
      filtro(v) {
        if (/[.\-,\s]/.test(v)) return 'Sin puntos, guiones ni espacios: escribí el número corrido (ej: 12345678).';
        if (/\D/.test(v)) return 'Solo números.';
        if (v[0] === '0') return 'El DNI no empieza con 0.';
        if (v.length > 8) return 'El DNI tiene como máximo 8 dígitos.';
        return null;
      },
      validar: v => (/^[1-9]\d{6,7}$/.test(v) ? null : 'El DNI tiene 7 u 8 dígitos.'),
    },
    {
      id: 'cuit', grupo: 'personal', etiqueta: 'CUIT / CUIL', icono: 'file', teclado: 'numeric',
      formato: '11 números, sin guiones', ejemplo: '20123456786',
      filtro(v) {
        if (/[.\-/,\s]/.test(v)) return 'Sin guiones, puntos ni espacios: escribí los 11 números corridos (ej: 20123456786).';
        if (/\D/.test(v)) return 'Solo números.';
        if (!/^[23]/.test(v)) return 'El CUIT/CUIL empieza con 20, 23, 24, 27, 30, 33 o 34.';
        if (v.length >= 2 && !/^(20|23|24|27|30|33|34)/.test(v)) return 'Prefijo inválido: debe ser 20, 23, 24, 27, 30, 33 o 34.';
        if (v.length > 11) return 'El CUIT/CUIL tiene exactamente 11 dígitos.';
        return null;
      },
      validar(v) {
        if (v.length !== 11) return `El CUIT/CUIL tiene 11 dígitos (faltan ${11 - v.length}).`;
        if (!cuitValido(v)) return 'El número no es válido (dígito verificador incorrecto). Revisalo.';
        const dni = estado.valores.dni;
        if (dni && /^2[0347]/.test(v) && v.substr(2, 8) !== dni.padStart(8, '0')) return 'No coincide con el DNI cargado.';
        return null;
      },
    },
    {
      id: 'celular', grupo: 'contacto', etiqueta: 'Teléfono celular', icono: 'phone', teclado: 'numeric', tipo: 'tel',
      formato: 'Código de área + número, sin 0 ni 15', ejemplo: '1122334455',
      filtro: filtroCelular, validar: validarCelular,
    },
    {
      id: 'celular2', grupo: 'contacto', etiqueta: 'Teléfono celular 2', icono: 'phone', teclado: 'numeric', tipo: 'tel', opcional: true,
      formato: 'Otro número de contacto, mismo formato', ejemplo: '2374556677',
      filtro: filtroCelular,
      validar: v => validarCelular(v) || (v === estado.valores.celular ? 'Es igual al Teléfono celular.' : null),
    },
    {
      id: 'mail', grupo: 'contacto', etiqueta: 'Mail', icono: 'mail', teclado: 'email',
      formato: 'usuario@dominio', ejemplo: 'hola@net.com', transformar: v => v.toLowerCase(),
      filtro(v) {
        if (/\s/.test(v)) return 'El mail no lleva espacios.';
        if (/[^a-z0-9._%+\-@]/.test(v)) return 'Carácter no permitido en un mail (sin tildes, ñ, comas ni barras).';
        if ((v.match(/@/g) || []).length > 1) return 'El mail lleva una sola @.';
        if (/^[@.]/.test(v)) return 'Escribí primero el usuario (lo que va antes de la @).';
        if (/\.\./.test(v)) return 'No puede haber dos puntos seguidos.';
        if (/\.@|@\./.test(v)) return 'No puede haber un punto pegado a la @.';
        if (/@.*[_%+]/.test(v)) return 'Después de la @ solo van letras, números, puntos y guiones.';
        if (v.length > 100) return 'Mail demasiado largo.';
        return null;
      },
      validar(v) {
        if (!v.includes('@')) return 'Falta la @ (ej: hola@net.com).';
        if (!/^[a-z0-9](?:[a-z0-9._%+-]*[a-z0-9_%+-])?@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(v)) {
          return 'Mail incompleto o incorrecto (ej: hola@net.com).';
        }
        return null;
      },
    },
    {
      id: 'calle', grupo: 'domicilio', etiqueta: 'Domicilio (calle)', icono: 'pin',
      formato: 'Solo el nombre de la calle; la altura va en «Nro.»', ejemplo: 'Rivadavia  ·  25 de Mayo', placeholder: 'Rivadavia',
      filtro(v) {
        const conNumero = /^\d/.test(v);
        if (/\d/.test(v.replace(/^\d+/, ''))) {
          return conNumero && /^\d+[^\d ]/.test(v)
            ? 'Dejá un espacio después del número (ej: 25 de Mayo).'
            : 'La numeración va en el campo «Nro.». Aquí solo el nombre de la calle.';
        }
        if (conNumero && /^\d+[^\d ]/.test(v)) return 'Dejá un espacio después del número (ej: 25 de Mayo).';
        if (/^[ .']/.test(v)) return 'Empezá con el nombre de la calle.';
        if (new RegExp(`[^0-9${LETRAS}.' ]`).test(v)) return 'Solo letras, espacios y puntos (sin comas, guiones ni símbolos).';
        if (/ {2}/.test(v)) return 'Sin espacios dobles.';
        if (v.length > 80) return 'Máximo 80 caracteres.';
        return null;
      },
      validar(v) {
        if (/^\d+ ?$/.test(v)) return 'Completá el nombre de la calle (ej: 25 de Mayo).';
        if (!new RegExp(`^(\\d+ )?[${LETRAS}]`).test(v)) return 'Después del número va el nombre de la calle (ej: 25 de Mayo).';
        return v.replace(/[\d .']/g, '').length < 2 ? 'Nombre de calle demasiado corto.' : null;
      },
    },
    {
      id: 'numero', grupo: 'domicilio', etiqueta: 'Nro.', icono: 'hash', teclado: 'numeric', sinNumero: true,
      formato: 'Solo números', ejemplo: '1154',
      filtro(v) {
        if (/\D/.test(v)) return 'Solo números, sin letras ni símbolos. Si no tiene numeración, marcá «S/N».';
        if (v[0] === '0') return 'La numeración no empieza con 0.';
        if (v.length > 6) return 'Máximo 6 dígitos.';
        return null;
      },
      validar: v => (v === 'S/N' || /^[1-9]\d{0,5}$/.test(v) ? null : 'Numeración inválida.'),
    },
    {
      id: 'barrio', grupo: 'domicilio', etiqueta: 'Barrio', icono: 'map', tipo: 'combo',
      formato: 'Escribí y elegí de la lista. Si no está, elegí «Otro»', placeholder: 'Escribí para buscar el barrio…',
      opciones: () => estado.barrios,
      filtro: filtroBarrio,
      validar: v => (v === 'Otro' || estado.barrios.includes(v) ? null : 'Elegí un barrio de la lista. Si no está, elegí «Otro».'),
    },
    {
      id: 'piso', grupo: 'domicilio', etiqueta: 'Piso / Depto.', icono: 'building', opcional: true,
      formato: 'Piso y departamento', ejemplo: '3 B', transformar: v => v.toUpperCase(),
      filtro(v) {
        if (/[^0-9A-ZÑ°º ]/.test(v)) return 'Solo letras y números, sin guiones ni barras (ej: 3 B, PB 2).';
        if (/^[ °º]/.test(v)) return 'Empezá con el piso (ej: 3 B).';
        if (/ {2}/.test(v)) return 'Sin espacios dobles.';
        if (v.length > 10) return 'Máximo 10 caracteres.';
        return null;
      },
    },
    {
      id: 'barrioOtro', grupo: 'domicilio', etiqueta: 'Nombre del barrio', icono: 'pencil', capitalizar: true,
      formato: 'Escribilo tal como se llama', ejemplo: 'Vista Linda',
      filtro: filtroBarrio, validar: validarBarrio,
      visible: () => estado.valores.barrio === 'Otro',
    },
    {
      id: 'vinculo', grupo: 'vinculo', etiqueta: '¿A quién corresponden los datos?', icono: 'users', tipo: 'select',
      formato: 'Elegí una opción de la lista', opciones: VINCULOS,
    },
    {
      id: 'parentesco', grupo: 'vinculo', etiqueta: 'Parentesco', icono: 'heart', tipo: 'select',
      formato: 'Relación con el titular', opciones: PARENTESCOS,
      visible: () => estado.valores.vinculo === 'Familiar',
    },
    {
      id: 'parentescoOtro', grupo: 'vinculo', etiqueta: 'Especificá el parentesco', icono: 'pencil', esDato: false,
      formato: 'Solo letras', ejemplo: 'Abuela', capitalizar: true,
      filtro: filtroNombre, validar: validarNombre,
      visible: () => estado.valores.vinculo === 'Familiar' && estado.valores.parentesco === 'Otro',
    },
    {
      id: 'partidaInmueble', grupo: 'complementarios', etiqueta: 'Partida Municipal Inmueble', icono: 'home', teclado: 'numeric', opcional: true,
      formato: 'Solo números, sin puntos ni guiones', ejemplo: '123456', filtro: filtroPartida,
    },
    {
      id: 'partidaComercio', grupo: 'complementarios', etiqueta: 'Partida Municipal Comercio', icono: 'store', teclado: 'numeric', opcional: true,
      formato: 'Solo números, sin puntos ni guiones', ejemplo: '654321', filtro: filtroPartida,
    },
    {
      id: 'comentarios', grupo: 'comentarios', etiqueta: 'Comentarios u observaciones', icono: 'message', tipo: 'textarea',
      opcional: true, esDato: false, maximo: 500,
      formato: 'Texto libre: cualquier dato que quieras agregar', placeholder: 'Escribí aquí lo que quieras agregar…',
      filtro: v => (v.length > 500 ? 'Máximo 500 caracteres.' : null),
    },
  ];
  const CAMPO = Object.fromEntries(CAMPOS.map(c => [c.id, c]));
  const GRUPOS = [
    { id: 'personal', titulo: 'Datos personales', icono: 'idcard' },
    { id: 'contacto', titulo: 'Contacto', icono: 'phone' },
    { id: 'domicilio', titulo: 'Domicilio', icono: 'home' },
    { id: 'vinculo', titulo: 'Vínculo', icono: 'users' },
    { id: 'complementarios', titulo: 'Datos complementarios', icono: 'folder', opcional: true },
    { id: 'comentarios', titulo: 'Comentarios', icono: 'message', opcional: true },
  ];

  /* Validación completa de un conjunto de datos (se usa también en el modo demo como "servidor"). */
  function erroresDeFormato(datos, claves) {
    return CAMPOS.filter(c => {
      if (claves && !claves.includes(c.id)) return false;
      const v = datos[c.id];
      if (!v) return false;
      if (c.tipo === 'select') return !c.opciones.includes(v);
      if (c.tipo === 'combo') return !!c.validar(v);
      return !!(c.filtro(v === 'S/N' ? '' : v) || (c.validar && c.validar(v)));
    });
  }

  /* Acciones posibles sobre una ficha que ya existe. */
  const ACCIONES = {
    telefono: {
      titulo: 'Agregar un teléfono', icono: 'phone',
      desc: d => (!d.celular ? 'Se habilita el Teléfono celular.'
        : d.celular2 ? 'Se reemplaza el Teléfono celular 2 (el actual queda en el historial).'
        : 'Se habilita el Teléfono celular 2.'),
      campos: d => [d.celular ? 'celular2' : 'celular'],
    },
    domicilio: {
      titulo: 'Cargar un nuevo domicilio', icono: 'home',
      desc: () => 'Reemplaza el domicilio actual. El anterior queda guardado en el historial.',
      campos: () => ['calle', 'numero', 'barrio', 'barrioOtro', 'piso'],
    },
    correccion: {
      titulo: 'Corregir o completar un dato', icono: 'pencil',
      desc: () => 'Elegís qué campo modificar; el resto queda bloqueado.',
      campos: () => [],
    },
  };
  /* Si se habilita un campo, también se habilitan los que dependen de él. */
  const DEPENDIENTES = { vinculo: ['parentesco', 'parentescoOtro'], parentesco: ['parentescoOtro'], barrio: ['barrioOtro'] };

  const BUSQUEDAS = {
    dni: { etiqueta: 'DNI', ejemplo: '12345678', ok: v => /^[1-9]\d{6,7}$/.test(v), mal: 'El DNI tiene 7 u 8 dígitos.' },
    cuit: { etiqueta: 'CUIT/CUIL', ejemplo: '20123456786', ok: v => cuitValido(v), mal: 'El CUIT/CUIL tiene 11 dígitos y un dígito verificador válido.' },
    partidaInmueble: { etiqueta: 'Partida inmueble', ejemplo: '123456', ok: v => /^\d{1,12}$/.test(v), mal: 'Solo números, hasta 12 dígitos.' },
    partidaComercio: { etiqueta: 'Partida comercio', ejemplo: '654321', ok: v => /^\d{1,12}$/.test(v), mal: 'Solo números, hasta 12 dígitos.' },
  };

  /* ============================ API ============================ */
  function crearApiRemota() {
    return async function llamar(accion, datos = {}) {
      let r;
      try {
        r = await fetch(CFG.API_URL, {
          method: 'POST',
          // text/plain evita el "preflight" CORS (necesario para la versión en Google Apps Script).
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(Object.assign({ accion, token: estado.sesion && estado.sesion.token }, datos)),
          redirect: 'follow',
        });
      } catch (e) {
        throw new Error('No se pudo conectar con el servidor. Revisá tu conexión a internet e intentá de nuevo.');
      }
      const tipo = r.headers.get('Content-Type') || '';
      if (r.ok && !tipo.includes('json')) {
        // Descargas (planilla, respaldos): se devuelve el archivo.
        const nombre = ((r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/) || [])[1] || 'archivo';
        return { ok: true, archivo: await r.blob(), nombre };
      }
      let j;
      try { j = await r.json(); } catch (e) { throw new Error('El servidor respondió de forma inesperada. Intentá de nuevo en unos minutos.'); }
      if (!j.ok) {
        const err = new Error(j.error || 'Error desconocido.');
        err.sesionVencida = !!j.sesionVencida;
        err.existe = !!j.existe;
        err.coincidencias = j.coincidencias || [];
        throw err;
      }
      return j;
    };
  }

  /* Oculta parte de los datos de contacto a quien no es Administrador (igual que el servidor). */
  function enmascarar(datos) {
    const d = Object.assign({}, datos);
    const ocultos = [];
    ['celular', 'celular2'].forEach(k => { if (d[k]) { d[k] = d[k].slice(0, 2) + '****' + d[k].slice(-4); ocultos.push(k); } });
    if (d.mail) { const [u, dom] = d.mail.split('@'); d.mail = u[0] + '***@' + dom; ocultos.push('mail'); }
    if (d.comentarios) { d.comentarios = '(oculto)'; ocultos.push('comentarios'); }
    return { datos: d, ocultos };
  }

  function crearApiDemo() {
    const USUARIOS_INICIALES = [
      { usuario: 'carga', nombre: 'Operador de Carga', perfil: 'Carga', secretaria: 'Secretaría de Ingresos Públicos' },
      { usuario: 'analisis', nombre: 'Analista de Datos', perfil: 'Análisis', secretaria: 'Secretaría de Gobierno' },
      { usuario: 'admin', nombre: 'Administración de la Red', perfil: 'Administrador', secretaria: 'Secretaría de Gobierno' },
    ];
    const SECRETARIAS = ['Secretaría de Ingresos Públicos', 'Secretaría de Gobierno', 'Secretaría de Salud', 'Secretaría de Desarrollo Social', 'Secretaría de Obras Públicas'];
    const K = 'gr_demo_registros_v4'; // cambiar la versión regenera los datos de ejemplo
    const pausa = ms => new Promise(r => setTimeout(r, ms));
    const refNueva = () => Array.from({ length: 16 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
    const vacio = () => Object.fromEntries(CAMPOS.map(c => [c.id, '']));
    const soloServidor = () => { throw new Error('En el modo demo no hay servidor: esta función se usa en el servidor municipal.'); };

    const usuarios = () => almacen.get('gr_demo_usuarios', null, 'local')
      || USUARIOS_INICIALES.map(u => Object.assign({ activo: 1, creado: new Date().toISOString(), ultimo_ingreso: '', doble_factor: u.perfil === 'Administrador' ? 1 : 0, bloqueado: false }, u));
    const guardarUsuarios = l => almacen.set('gr_demo_usuarios', l, 'local');
    const barrios = () => almacen.get('gr_demo_barrios', null, 'local') || BARRIOS_DEMO;
    const accesos = () => almacen.get('gr_demo_accesos', [], 'local');
    const log = (usuario, evento, detalle) => {
      const l = accesos();
      l.push({ n: (l.length ? l[l.length - 1].n : 0) + 1, fecha: new Date().toISOString(), usuario, ip: 'demo', evento, detalle: detalle || '' });
      almacen.set('gr_demo_accesos', l.slice(-300), 'local');
    };

    function registros() {
      let regs = almacen.get(K, null, 'local');
      if (!regs) {
        // Datos de ejemplo para que el panel de estadísticas tenga contenido.
        let s = 7;
        const azar = () => ((s = (s * 16807) % 2147483647) / 2147483647);
        regs = [];
        const pesos = [0.3, 0.22, 0.2, 0.17, 0.11];
        for (let i = 0; i < 260; i++) {
          let r = azar(), k = 0;
          while (r > pesos[k] && k < pesos.length - 1) { r -= pesos[k]; k++; }
          regs.push(Object.assign(vacio(), {
            id: i + 1, ref: refNueva(),
            fecha: new Date(Date.now() - Math.floor(azar() * azar() * (i < 180 ? 30 : 200) * 86400000)).toISOString(),
            secretaria: SECRETARIAS[k], usuario: 'ejemplo',
            celular: azar() < 0.82 ? '1100000000' : '', mail: azar() < 0.58 ? 'ejemplo@mail.com' : '',
            vinculo: VINCULOS[Math.floor(azar() * azar() * 4)],
          }));
        }
        // Fichas completas para probar el buscador (DNI 20111222 y 25333444).
        regs.push(Object.assign(vacio(), {
          id: 261, ref: refNueva(), fecha: new Date(Date.now() - 3 * 86400000).toISOString(), secretaria: 'Secretaría de Salud', usuario: 'ejemplo',
          apellido: 'Gómez', nombre: 'Laura', dni: '20111222', cuit: '27201112228', celular: '1133445566', mail: 'laura.gomez@mail.com',
          calle: 'Rivadavia', numero: '1154', barrio: 'Centro', vinculo: 'Titular', partidaInmueble: '100200',
        }));
        regs.push(Object.assign(vacio(), {
          id: 262, ref: refNueva(), fecha: new Date(Date.now() - 1 * 86400000).toISOString(), secretaria: 'Secretaría de Ingresos Públicos', usuario: 'ejemplo',
          apellido: 'Fernández', nombre: 'Carlos', dni: '25333444', celular: '2374556677',
          calle: '25 de Mayo', numero: '480', barrio: 'Agua de Oro', vinculo: 'Inquilino', partidaComercio: '300400',
        }));
        almacen.set(K, regs, 'local');
      }
      return regs;
    }
    const sesion = () => {
      const u = estado.sesion && usuarios().find(x => x.usuario === estado.sesion.usuario.usuario && x.activo);
      if (!u) { const e = new Error('Tu sesión venció. Volvé a ingresar.'); e.sesionVencida = true; throw e; }
      return u;
    };
    const publico = u => ({ usuario: u.usuario, nombre: u.nombre, perfil: u.perfil, secretaria: u.secretaria });
    const exigir = (u, perfiles) => { if (!perfiles.includes(u.perfil)) throw new Error('Tu perfil no tiene permiso para esta acción.'); };
    const ficha = (r, u) => {
      const f = { ref: r.ref, fecha: r.fecha, secretaria: r.secretaria, datos: Object.fromEntries(CAMPOS.map(c => [c.id, r[c.id] || ''])) };
      if (u.perfil !== 'Administrador') {
        const m = enmascarar(f.datos);
        f.datos = m.datos;
        if (m.ocultos.length) f.ocultos = m.ocultos;
      }
      if (u.perfil !== 'Carga') f.id = r.id;
      return f;
    };
    const validar = (datos, claves) => {
      const malos = erroresDeFormato(datos, claves);
      if (malos.length) throw new Error('Formato incorrecto en: ' + malos.map(c => c.etiqueta).join(', ') + '.');
    };
    const limpiarDependientes = d => {
      if (d.barrio !== 'Otro') d.barrioOtro = '';
      if (d.vinculo !== 'Familiar') d.parentesco = '';
      if (d.parentesco !== 'Otro') d.parentescoOtro = '';
      return d;
    };
    const verificarUnico = (regs, datos, u, excluir) => {
      const iguales = regs.filter(r => r.ref !== excluir && ((datos.dni && r.dni === datos.dni) || (datos.cuit && r.cuit === datos.cuit)));
      if (!iguales.length) return;
      const e = new Error('Ya existe una ficha con ese DNI o CUIT/CUIL. Actualizá la ficha existente en lugar de crear otra.');
      e.existe = true;
      e.coincidencias = iguales.slice(0, 5).map(r => ficha(r, u));
      throw e;
    };
    const config = () => ({ barrios: barrios() });

    return async function llamar(accion, p = {}) {
      await pausa(accion === 'estadisticas' || accion === 'adminResumen' ? 500 : 350);
      switch (accion) {
        case 'login': {
          const u = usuarios().find(x => x.usuario === String(p.usuario || '').trim().toLowerCase());
          if (!u || !u.activo || p.clave !== 'demo1234') { log(u ? u.usuario : '(desconocido)', 'ingreso fallido', ''); throw new Error('Usuario o contraseña incorrectos.'); }
          log(u.usuario, 'ingreso', '');
          return { ok: true, token: 'demo-' + Date.now(), usuario: publico(u), config: config() };
        }
        case 'sesion': return { ok: true, usuario: publico(sesion()), config: config() };
        case 'logout': return { ok: true };
        case 'cambiarClave': sesion(); soloServidor(); break;
        case 'buscar': {
          const u = sesion();
          const b = BUSQUEDAS[p.tipo];
          if (!b || !b.ok(String(p.valor || ''))) throw new Error('Dato de búsqueda inválido.');
          const resultados = registros().filter(r => r[p.tipo] === p.valor && r.ref !== p.excluir)
            .sort((a, b) => (a.fecha < b.fecha ? 1 : -1)).slice(0, 10).map(r => ficha(r, u));
          log(u.usuario, 'búsqueda', `${b.etiqueta} ${p.valor} → ${resultados.length} resultado(s)`);
          return { ok: true, resultados };
        }
        case 'guardar': {
          const u = sesion();
          const datos = limpiarDependientes(Object.assign(vacio(), p.datos));
          validar(datos);
          const regs = registros();
          verificarUnico(regs, datos, u, null);
          const id = regs.reduce((m, r) => Math.max(m, r.id), 0) + 1;
          const ref = refNueva();
          const fecha = new Date().toISOString();
          regs.push(Object.assign({ id, ref, fecha, secretaria: u.secretaria, usuario: u.usuario }, datos));
          almacen.set(K, regs, 'local');
          almacen.set('gr_demo_editable_' + u.usuario, id, 'local');
          const r = { ok: true, ref, fecha };
          if (u.perfil !== 'Carga') r.id = id;
          return r;
        }
        case 'editar': {
          const u = sesion();
          const regs = registros();
          const r = regs.find(x => x.ref === p.ref);
          if (!r || r.id !== almacen.get('gr_demo_editable_' + u.usuario, 0, 'local')) {
            throw new Error('Esa carga ya no se puede editar: solo se puede modificar la última carga realizada.');
          }
          const datos = limpiarDependientes(Object.assign(vacio(), p.datos));
          validar(datos);
          verificarUnico(regs, datos, u, r.ref);
          Object.assign(r, datos, { editado: new Date().toISOString() });
          almacen.set(K, regs, 'local');
          return { ok: true };
        }
        case 'actualizar': {
          const u = sesion();
          const permitidos = { telefono: ['celular', 'celular2'], domicilio: ['calle', 'numero', 'piso', 'barrio', 'barrioOtro'], correccion: CAMPOS.map(c => c.id) }[p.que];
          if (!permitidos) throw new Error('Acción inválida.');
          const regs = registros();
          const r = regs.find(x => x.ref === p.ref);
          if (!r) throw new Error('No se encontró la ficha.');
          const cambios = p.cambios || {};
          const tocados = permitidos.filter(k => k in cambios && String(cambios[k]).trim() !== (r[k] || ''));
          if (!tocados.length) throw new Error('No hay cambios para guardar.');
          const actual = Object.fromEntries(CAMPOS.map(c => [c.id, r[c.id] || '']));
          const nuevo = limpiarDependientes(Object.assign(actual, ...tocados.map(k => ({ [k]: String(cambios[k]).trim() }))));
          validar(nuevo, tocados.flatMap(k => [k].concat(DEPENDIENTES[k] || [])));
          if (tocados.includes('dni') || tocados.includes('cuit')) verificarUnico(regs, nuevo, u, r.ref);
          Object.assign(r, nuevo, { editado: new Date().toISOString() });
          almacen.set(K, regs, 'local');
          const f = ficha(r, u);
          return { ok: true, datos: f.datos, ocultos: f.ocultos };
        }
        case 'estadisticas': {
          exigir(sesion(), ['Análisis', 'Administrador']);
          const regs = registros().map(r => Object.assign({}, r, { fecha: new Date(r.fecha), clave: claveFecha(r.fecha), celular: r.celular || r.celular2 }));
          return Object.assign({ ok: true }, calcularEstadisticas(regs, p.desde, p.hasta, claveFecha(Date.now())));
        }
        /* ----- Administración (simulada: sin servidor no hay cadena de auditoría real ni respaldos) ----- */
        case 'adminResumen': {
          exigir(sesion(), ['Administrador']);
          const regs = registros();
          const eventos = regs.length + 3;
          const hash = ('d3m0' + eventos.toString(16)).padEnd(64, '0');
          return {
            ok: true, registros: regs.length, usuarios: usuarios().filter(u => u.activo).length,
            verificacion: { ok: true, eventos, hash, problemas: [], fecha: new Date().toISOString() },
            sello: p.sello ? { eventos: p.sello.eventos, hashGuardado: p.sello.hash, hashActual: p.sello.hash } : null,
            respaldo: { llave: '', ultimo: '', hora: '23:00', carpeta: '(modo demo)', archivos: [] },
            alertas: accesos().filter(a => /^ALERTA/.test(a.evento)).reverse(),
            ingresosFallidos24h: accesos().filter(a => a.evento === 'ingreso fallido').length,
            limiteBusquedasPorHora: 60,
          };
        }
        case 'adminUsuarios': exigir(sesion(), ['Administrador']); return { ok: true, usuarios: usuarios() };
        case 'adminUsuarioGuardar': {
          const yo = sesion(); exigir(yo, ['Administrador']);
          const d = p.datos || {};
          const lista = usuarios();
          const usuario = String(d.usuario || '').trim().toLowerCase();
          if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) throw new Error('Usuario inválido: de 3 a 30 caracteres, solo letras minúsculas, números, punto o guion.');
          if (String(d.nombre || '').trim().length < 3) throw new Error('Escribí el nombre y apellido de la persona.');
          if (String(d.secretaria || '').trim().length < 3) throw new Error('Indicá la secretaría.');
          const existente = lista.find(x => x.usuario === usuario);
          if (d.nuevo) {
            if (existente) throw new Error('Ya existe un usuario con ese nombre.');
            lista.push({ usuario, nombre: d.nombre.trim(), perfil: d.perfil, secretaria: d.secretaria.trim(), activo: 1, creado: new Date().toISOString(), ultimo_ingreso: '', doble_factor: 0, bloqueado: false, debe_cambiar_clave: 1 });
            guardarUsuarios(lista);
            log(yo.usuario, 'admin: alta de usuario', `${usuario} (${d.perfil})`);
            return { ok: true, claveTemporal: 'demo1234' };
          }
          Object.assign(existente, { nombre: d.nombre.trim(), perfil: d.perfil, secretaria: d.secretaria.trim() });
          guardarUsuarios(lista);
          return { ok: true };
        }
        case 'adminUsuarioAccion': {
          const yo = sesion(); exigir(yo, ['Administrador']);
          const lista = usuarios();
          const u = lista.find(x => x.usuario === p.usuario);
          if (!u) throw new Error('No existe ese usuario.');
          if (p.que === 'desactivar' && u.usuario === yo.usuario) throw new Error('No podés desactivar tu propio usuario.');
          if (p.que === 'activar' || p.que === 'desactivar') u.activo = p.que === 'activar' ? 1 : 0;
          if (p.que === 'desbloquear') u.bloqueado = false;
          if (p.que === 'reiniciar2fa') u.doble_factor = 0;
          guardarUsuarios(lista);
          log(yo.usuario, 'admin: ' + p.que, u.usuario);
          return p.que === 'clave' ? { ok: true, claveTemporal: 'demo1234' } : { ok: true };
        }
        case 'adminBarrios': {
          exigir(sesion(), ['Administrador']);
          if (Array.isArray(p.lista)) almacen.set('gr_demo_barrios', p.lista, 'local');
          return { ok: true, barrios: barrios() };
        }
        case 'adminActividad': {
          exigir(sesion(), ['Administrador']);
          const f = String(p.usuario || '').toLowerCase();
          if (p.tipo === 'historial') {
            const filas = registros().filter(r => r.usuario !== 'ejemplo' || r.id > 258).slice(-100).reverse()
              .filter(r => !f || r.usuario === f)
              .map(r => ({ n: r.id, fecha: r.fecha, usuario: r.usuario, secretaria: r.secretaria, objeto: 'registro:' + r.id, accion: r.editado ? 'Corrección de datos' : 'Alta', cambios: '[]' }));
            return { ok: true, filas };
          }
          return { ok: true, filas: accesos().slice().reverse().filter(a => !f || a.usuario === f) };
        }
        case 'adminExportar': case 'adminLlave': case 'adminRespaldar': case 'adminRespaldoDescargar':
          exigir(sesion(), ['Administrador']); soloServidor(); break;
        default: throw new Error('Acción desconocida.');
      }
    };
  }

  /* Fechas como claves 'aaaa-mm-dd' (hora local del navegador). */
  const claveFecha = d => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  const sumarDias = (k, n) => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
  const fechaDeClave = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d || 1); };

  /** Espejo de calcularEstadisticas_ del backend (Code.gs): mantener ambas iguales. */
  function calcularEstadisticas(regs, desde, hasta, hoy) {
    const esFecha = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
    const validos = regs.filter(r => r.clave);
    let h = esFecha(hasta) ? hasta : hoy;
    let d = esFecha(desde) ? desde
      : desde === 'inicio' ? validos.reduce((min, r) => (r.clave < min ? r.clave : min), h)
      : sumarDias(h, -29);
    if (d > h) [d, h] = [h, d];

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
        k = `${y}-${String(mm).padStart(2, '0')}`;
      }
      enRango.forEach(r => { serie[r.clave.slice(0, 7)]++; });
    }

    const ordenar = o => Object.keys(o).map(k => ({ nombre: k, cantidad: o[k] })).sort((a, b) => b.cantidad - a.cantidad);
    return {
      desde: d, hasta: h, total: enRango.length, celulares, mails,
      ultimos7: validos.filter(r => r.clave >= sumarDias(hoy, -6) && r.clave <= hoy).length, // hoy y los 6 días anteriores
      porSecretaria: ordenar(porSecretaria), porVinculo: ordenar(porVinculo),
      granularidad, serie: Object.keys(serie).map(k => ({ clave: k, cantidad: serie[k] })),
      generado: new Date().toISOString(),
    };
  }

  /* ============================ ESTADO ============================ */
  const estado = {
    sesion: almacen.get('gr_sesion', null),
    valores: {},
    textos: {},            // texto escrito en los combos (barrio) mientras se busca
    modo: 'nueva',         // 'nueva' | 'edicion' (última carga) | 'actualizacion' (ficha existente)
    accion: null,          // en actualización: 'telefono' | 'domicilio' | 'correccion'
    ficha: null,           // { ref, datos, ... } ficha que se edita o actualiza
    habilitados: null,     // Set de campos editables (null = todos)
    ocultos: new Set(),    // campos que el servidor envió enmascarados (no se ven completos)
    ultima: null,          // { ref, id?, fecha, datos }
    duplicados: { dni: null, cuit: null },
    busqueda: { tipo: 'dni', valor: '', resultados: null },
    barrios: BARRIOS_DEMO,
    guardando: false,
    cargasSesion: 0,
  };
  const api = MODO_DEMO ? crearApiDemo() : crearApiRemota();
  const perfil = () => (estado.sesion ? estado.sesion.usuario.perfil : '');
  const veNumeros = () => !!perfil() && perfil() !== 'Carga';   // Análisis y Administrador ven números de carga
  const esAdmin = () => perfil() === 'Administrador';

  /* ============================ UI: TOASTS / MODALES ============================ */
  function toast(texto, tipo = 'info', accion) {
    const ic = { exito: 'check-circle', error: 'alert-circle', aviso: 'alert', info: 'info' }[tipo];
    const el = document.createElement('div');
    el.className = 'toast ' + tipo;
    el.innerHTML = `${icono(ic)}<div class="toast-texto">${texto}</div>`;
    if (accion) {
      const b = document.createElement('button');
      b.className = 'toast-accion';
      b.innerHTML = icono(accion.icono || 'pencil') + esc(accion.texto);
      b.addEventListener('click', () => { accion.fn(); cerrar(); });
      el.appendChild(b);
    }
    $('#toasts').appendChild(el);
    const cerrar = () => { el.classList.add('saliendo'); setTimeout(() => el.remove(), 260); };
    setTimeout(cerrar, accion ? 7000 : 4500);
  }

  function modal({ titulo, html, si, no, tipo = 'aviso', iconoId = 'alert' }) {
    const d = $('#modal');
    $('#modal-titulo').textContent = titulo;
    $('#modal-texto').innerHTML = html;
    $('#modal-icono').innerHTML = icono(iconoId);
    const bSi = $('#modal-si'), bNo = $('#modal-no');
    bSi.innerHTML = `${icono(tipo === 'peligro' ? 'x' : 'save')}<span>${esc(si)}</span>`;
    bSi.className = 'btn ' + (tipo === 'peligro' ? 'btn-peligro' : 'btn-primario');
    bNo.innerHTML = `<span>${esc(no)}</span>`;
    if (d.open) d.close();
    return new Promise(resolve => {
      const fin = r => { d.removeEventListener('cancel', alCancelar); bSi.onclick = bNo.onclick = null; d.close(); resolve(r); };
      const alCancelar = e => { e.preventDefault(); fin(false); };
      d.addEventListener('cancel', alCancelar);
      bSi.onclick = () => fin(true);
      bNo.onclick = () => fin(false);
      d.showModal();
      bNo.focus();
    });
  }

  /* Tarjeta con los datos principales de una ficha existente. */
  function htmlFicha(f, { compacta } = {}) {
    const d = f.datos;
    const nombre = [d.apellido, d.nombre].filter(Boolean).join(', ') || 'Sin nombre';
    const iniciales = (d.apellido || d.nombre || '?').slice(0, 1) + (d.nombre || '').slice(0, 1);
    const barrio = d.barrio === 'Otro' ? d.barrioOtro : d.barrio;
    const domicilio = [d.calle, d.numero].filter(Boolean).join(' ') + (d.piso ? `, ${d.piso}` : '');
    const filas = [
      ['Domicilio', [domicilio, barrio].filter(Boolean).join(' · ')],
      ['Celular', [d.celular, d.celular2].filter(Boolean).join(' · ')],
      ['Mail', d.mail],
      ['Partida inmueble', d.partidaInmueble],
      ['Partida comercio', d.partidaComercio],
    ].filter(([, v]) => v);
    const fecha = new Date(f.fecha);
    return `<div class="ficha ${compacta ? 'compacta' : ''}">
        <div class="ficha-cab">
          <span class="ficha-avatar">${esc(iniciales.toUpperCase())}</span>
          <div class="ficha-nombre"><strong>${esc(nombre)}</strong>
            <span>${[d.dni && 'DNI ' + d.dni, d.cuit && 'CUIT/CUIL ' + d.cuit].filter(Boolean).map(esc).join(' · ') || 'Sin DNI'}</span></div>
          ${f.id ? `<span class="ficha-id">#${f.id}</span>` : ''}
        </div>
        ${filas.length ? `<dl class="ficha-datos">${filas.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
        <p class="ficha-meta">${icono('building')} Cargada por ${esc(f.secretaria)}${isNaN(fecha) ? '' : ' · ' + fecha.toLocaleDateString('es-AR')}</p>
      </div>`;
  }

  /*
   * Ventana grande: "¿Qué querés hacer con esta ficha?". Devuelve la acción elegida o null.
   * Si ya hay una abierta, devuelve la misma promesa (evita ventanas repetidas).
   */
  let opcionesAbiertas = null;
  function elegirAccion(ficha, { duplicado, campo } = {}) {
    if (opcionesAbiertas) return opcionesAbiertas;
    const d = $('#modal-opciones');
    const etiqueta = campo === 'cuit' ? 'CUIT/CUIL' : 'DNI';
    $('#mo-titulo').textContent = duplicado ? 'Este contribuyente ya está cargado' : '¿Qué querés hacer con esta ficha?';
    $('#mo-texto').innerHTML = duplicado
      ? `Ya existe una ficha con el ${etiqueta} <strong>${esc(ficha.datos[campo || 'dni'])}</strong>. Para no duplicar datos, sumá la información nueva a esa ficha.`
        + (formularioConDatos() ? '<br><span class="mo-nota">Si elegís una opción, se descartan los datos que estabas escribiendo.</span>' : '')
      : '';
    $('#mo-texto').hidden = !duplicado;
    $('#mo-icono').className = 'modal-icono ' + (duplicado ? '' : 'info');
    $('#mo-icono').innerHTML = icono(duplicado ? 'alert' : 'users');
    $('#mo-ficha').innerHTML = htmlFicha(ficha, { compacta: true });
    $('#mo-pregunta').textContent = '¿Querés sumar un dato nuevo a la ficha existente?';
    $('#mo-pregunta').hidden = !duplicado;
    $('#mo-opciones').innerHTML = Object.entries(ACCIONES).map(([k, a]) => `
      <button type="button" class="opcion" data-accion="${k}">
        <span class="opcion-icono">${icono(a.icono)}</span>
        <strong>${a.titulo}</strong>
        <span>${esc(a.desc(ficha.datos))}</span>
      </button>`).join('');
    if (d.open) d.close();
    if (duplicado) Sonido.error();
    opcionesAbiertas = new Promise(resolve => {
      const fin = r => {
        d.removeEventListener('cancel', alCancelar);
        $('#mo-cancelar').onclick = $('#mo-cerrar').onclick = null;
        d.close();
        opcionesAbiertas = null;
        resolve(r);
      };
      const alCancelar = e => { e.preventDefault(); fin(null); };
      d.addEventListener('cancel', alCancelar);
      $('#mo-cancelar').onclick = $('#mo-cerrar').onclick = () => fin(null);
      $$('.opcion', d).forEach(b => { b.onclick = () => fin(b.dataset.accion); });
      d.showModal();
      $('.opcion', d).focus();
    });
    return opcionesAbiertas;
  }

  /* ============================ FORMULARIO ============================ */
  const nodoCampo = c => $(`.campo[data-campo="${c.id}"]`);
  const entrada = c => $('#f-' + c.id);
  const normalizarTexto = t => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

  function construirFormulario() {
    const cont = $('#grupos');
    cont.innerHTML = GRUPOS.map(g => `
      <section class="grupo" data-grupo="${g.id}">
        <div class="grupo-cabecera"><span class="grupo-icono">${icono(g.icono)}</span><h3>${g.titulo}</h3>${g.opcional ? '<span class="tag-opcional">Opcional</span>' : ''}</div>
        <div class="grupo-campos ${g.id}">
          ${CAMPOS.filter(c => c.grupo === g.id).map(htmlCampo).join('')}
        </div>
      </section>`).join('');

    CAMPOS.forEach(c => {
      const el = entrada(c);
      if (c.tipo === 'select') {
        el.addEventListener('change', () => alCambiarSelect(c, el));
      } else {
        el.addEventListener('input', () => alEscribir(c, el));
        el.addEventListener('blur', () => alSalir(c, el));
        el.addEventListener('drop', e => e.preventDefault());
      }
      if (c.tipo === 'combo') prepararCombo(c, el);
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter' && c.tipo !== 'textarea' && !e.defaultPrevented) { e.preventDefault(); siguienteCampo(c.id); }
      });
    });
    const sn = $('#sn-numero');
    sn.addEventListener('change', () => {
      const el = $('#f-numero');
      el.disabled = sn.checked;
      el.value = sn.checked ? 'S/N' : '';
      estado.valores.numero = el.value;
      limpiarMarcas(CAMPO.numero);
      refrescarCampo(CAMPO.numero);
      if (!sn.checked) el.focus();
    });
    $$('[data-corregir]').forEach(b => b.addEventListener('click', () => habilitarCorreccion(b.dataset.corregir)));
    refrescarVisibilidad();
    actualizarProgreso();
  }

  function htmlCampo(c) {
    const grupoOpcional = GRUPOS.find(g => g.id === c.grupo).opcional;
    const derecha = [
      c.sinNumero ? '<label class="sn" title="Sin número"><input type="checkbox" id="sn-numero"> S/N</label>' : '',
      c.maximo ? `<span class="contador-car" id="cc-${c.id}">0 / ${c.maximo}</span>` : '',
      c.opcional && !grupoOpcional && !c.maximo ? '<span class="tag-opcional">Opcional</span>' : '',
      `<button type="button" class="btn-corregir" data-corregir="${c.id}" hidden>${icono('pencil')}Corregir</button>`,
    ].join('');
    const cab = `<div class="campo-cabecera">
        <label class="campo-label" for="f-${c.id}">${c.etiqueta}</label><span class="campo-derecha">${derecha}</span>
      </div>
      <div class="campo-formato">${icono('info')}<span>${c.formato}${c.ejemplo ? ` · Ej: <code>${esc(c.ejemplo)}</code>` : ''}</span></div>`;
    const estadoIc = `<span class="control-estado" aria-hidden="true">${icono('check', 'ic-ok')}${icono('x', 'ic-err')}</span>`;
    const candado = `<span class="control-candado" aria-hidden="true">${icono('lock')}</span>`;
    let control;
    if (c.tipo === 'textarea') {
      control = `<div class="control control-area">${icono(c.icono, 'control-icono')}
        <textarea id="f-${c.id}" name="${c.id}" rows="3" placeholder="${esc(c.placeholder)}" spellcheck="true"
          aria-describedby="m-${c.id}"></textarea>${candado}</div>`;
    } else if (c.tipo === 'select') {
      control = `<div class="control">${icono(c.icono, 'control-icono')}
        <select id="f-${c.id}" name="${c.id}" required>
          <option value="">Seleccioná…</option>
          ${c.opciones.map(o => `<option>${esc(o)}</option>`).join('')}
        </select>${icono('chevron', 'control-flecha')}${estadoIc}${candado}</div>`;
    } else if (c.tipo === 'combo') {
      control = `<div class="control combo">${icono(c.icono, 'control-icono')}
        <input id="f-${c.id}" name="${c.id}" role="combobox" aria-expanded="false" aria-controls="lista-${c.id}"
          aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="${esc(c.placeholder)}"
          aria-describedby="m-${c.id}">${icono('chevron', 'control-flecha')}${estadoIc}${candado}
        <ul class="combo-lista" id="lista-${c.id}" role="listbox" hidden></ul></div>`;
    } else {
      control = `<div class="control">${icono(c.icono, 'control-icono')}
        <input id="f-${c.id}" name="${c.id}" type="${c.tipo === 'tel' ? 'tel' : 'text'}"
          ${c.teclado ? `inputmode="${c.teclado}"` : ''} placeholder="${esc(c.placeholder || c.ejemplo)}"
          autocomplete="off" autocapitalize="${c.capitalizar ? 'words' : 'off'}" spellcheck="false"
          aria-describedby="m-${c.id}">${estadoIc}${candado}</div>`;
    }
    return `<div class="campo" data-campo="${c.id}" ${c.visible ? 'hidden' : ''}>${cab}${control}
      <div class="campo-msg" id="m-${c.id}" role="alert">${icono('alert-circle')}<span></span></div>
      ${c.id === 'dni' || c.id === 'cuit' ? `<div class="campo-aviso" id="a-${c.id}" role="status">${icono('alert')}<span></span></div>` : ''}</div>`;
  }

  function alEscribir(c, el) {
    const esCombo = c.tipo === 'combo';
    const previo = (esCombo ? estado.textos[c.id] : estado.valores[c.id]) || '';
    let v = el.value;
    if (c.transformar) v = c.transformar(v);
    const error = v === '' ? null : c.filtro(v);
    if (error) {
      // Se rechaza lo tipeado/pegado: vuelve al último valor válido.
      const pos = Math.max(0, (el.selectionStart || 0) - (el.value.length - previo.length));
      el.value = previo;
      try { el.setSelectionRange(pos, pos); } catch (e) { /* sin selección */ }
      marcarError(c, error);
      return;
    }
    if (v !== el.value) {
      const pos = el.selectionStart;
      el.value = v;
      try { el.setSelectionRange(pos, pos); } catch (e) { /* sin selección */ }
    }
    if (esCombo) {
      estado.textos[c.id] = v;
      estado.valores[c.id] = coincidenciaExacta(c, v);
      limpiarMarcas(c);
      refrescarVisibilidad(true);
      refrescarCampo(c);
      mostrarCombo(c, v, true);
      return;
    }
    estado.valores[c.id] = v;
    limpiarMarcas(c);
    refrescarCampo(c);
    if (c.maximo) actualizarContador(c);
    if (c.id === 'dni' || c.id === 'cuit') {
      marcarDuplicado(c.id, null);
      if (c.id === 'dni' && estado.valores.cuit) refrescarCampo(CAMPO.cuit);
    }
  }

  function actualizarContador(c) {
    const n = (estado.valores[c.id] || '').length;
    const el = $('#cc-' + c.id);
    el.textContent = `${n} / ${c.maximo}`;
    el.classList.toggle('cerca', n >= c.maximo * 0.9);
  }

  function alSalir(c, el) {
    if (c.tipo === 'combo') {
      setTimeout(() => cerrarCombo(c), 120);
      const texto = (estado.textos[c.id] || '').trim();
      if (texto && !estado.valores[c.id]) {
        marcarError(c, 'Elegí un barrio de la lista. Si no está, elegí «Otro».');
        return;
      }
      if (estado.valores[c.id]) el.value = estado.textos[c.id] = estado.valores[c.id];
      refrescarCampo(c);
      return;
    }
    let v = estado.valores[c.id] || '';
    if (c.capitalizar && v) { v = capitalizar(v); el.value = v; estado.valores[c.id] = v; }
    else if (v !== v.trim()) { v = v.trim(); el.value = v; estado.valores[c.id] = v; }
    if (v && c.validar) {
      const error = c.validar(v);
      if (error) { marcarError(c, error); return; }
    }
    if (c.id === 'dni') {
      const e2 = estado.valores.cuit && CAMPO.cuit.validar(estado.valores.cuit);
      if (e2) marcarError(CAMPO.cuit, e2, false);
    }
    if (c.id === 'dni' || c.id === 'cuit') verificarExistente(c.id, { mostrar: true });
    refrescarCampo(c);
  }

  function alCambiarSelect(c, el) {
    estado.valores[c.id] = el.value;
    limpiarMarcas(c);
    refrescarVisibilidad(true);
    refrescarCampo(c);
  }

  /* ---------- Combo con búsqueda (barrio) ---------- */
  const comboActivo = {};
  function coincidenciaExacta(c, texto) {
    const t = normalizarTexto(texto);
    if (!t) return '';
    if (t === 'otro') return 'Otro';
    return c.opciones().find(o => normalizarTexto(o) === t) || '';
  }

  function mostrarCombo(c, texto, filtrar) {
    const lista = $('#lista-' + c.id);
    const t = filtrar ? normalizarTexto(texto) : '';
    const items = c.opciones().filter(o => !t || normalizarTexto(o).includes(t));
    const resaltar = o => {
      if (!t) return esc(o);
      const i = normalizarTexto(o).indexOf(t);
      return esc(o.slice(0, i)) + '<mark>' + esc(o.slice(i, i + t.length)) + '</mark>' + esc(o.slice(i + t.length));
    };
    const todos = items.concat('Otro');
    comboActivo[c.id] = Math.min(comboActivo[c.id] == null ? 0 : comboActivo[c.id], todos.length - 1);
    if (!filtrar) comboActivo[c.id] = Math.max(0, todos.indexOf(estado.valores[c.id]));
    lista.innerHTML = (items.length ? '' : `<li class="combo-vacio">No hay barrios que coincidan con «${esc(texto)}».</li>`)
      + todos.map((o, i) => `<li role="option" id="op-${c.id}-${i}" data-valor="${esc(o)}"
          class="${o === 'Otro' ? 'otro' : ''} ${i === comboActivo[c.id] ? 'activo' : ''}"
          aria-selected="${o === estado.valores[c.id]}">${o === 'Otro' ? `${icono('pencil')}Otro <span>(no está en la lista)</span>` : resaltar(o)}</li>`).join('');
    lista.hidden = false;
    entrada(c).setAttribute('aria-expanded', 'true');
    entrada(c).setAttribute('aria-activedescendant', `op-${c.id}-${comboActivo[c.id]}`);
    const act = $('li.activo', lista);
    if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest' });
  }

  function cerrarCombo(c) {
    $('#lista-' + c.id).hidden = true;
    entrada(c).setAttribute('aria-expanded', 'false');
  }

  function elegirEnCombo(c, valor) {
    const el = entrada(c);
    el.value = estado.textos[c.id] = estado.valores[c.id] = valor;
    cerrarCombo(c);
    limpiarMarcas(c);
    refrescarVisibilidad(true);
    refrescarCampo(c);
    if (valor === 'Otro') setTimeout(() => $('#f-barrioOtro').focus(), 30);
    else siguienteCampo(c.id);
  }

  function prepararCombo(c, el) {
    const lista = $('#lista-' + c.id);
    el.addEventListener('focus', () => { if (!el.disabled) { comboActivo[c.id] = 0; mostrarCombo(c, el.value, el.value !== estado.valores[c.id]); } });
    el.addEventListener('click', () => { if (lista.hidden && !el.disabled) mostrarCombo(c, el.value, el.value !== estado.valores[c.id]); });
    el.addEventListener('keydown', e => {
      const n = $$('li[role="option"]', lista).length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (lista.hidden) { mostrarCombo(c, el.value, el.value !== estado.valores[c.id]); return; }
        comboActivo[c.id] = (comboActivo[c.id] + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
        mostrarCombo(c, el.value, el.value !== estado.valores[c.id]);
      } else if (e.key === 'Enter' && !lista.hidden) {
        e.preventDefault();
        const li = $$('li[role="option"]', lista)[comboActivo[c.id]];
        if (li) elegirEnCombo(c, li.dataset.valor);
      } else if (e.key === 'Escape' && !lista.hidden) {
        e.preventDefault();
        e.stopPropagation();
        cerrarCombo(c);
      }
    });
    lista.addEventListener('mousedown', e => {
      e.preventDefault(); // mantiene el foco en el campo
      const li = e.target.closest('li[role="option"]');
      if (li) elegirEnCombo(c, li.dataset.valor);
    });
  }

  /* ---------- Visibilidad, estados y bloqueo ---------- */
  function refrescarVisibilidad(animar) {
    CAMPOS.filter(c => c.visible).forEach(c => {
      const n = nodoCampo(c);
      const ver = c.visible();
      if (ver && n.hidden && animar) { n.classList.remove('oculto-anim'); void n.offsetWidth; n.classList.add('oculto-anim'); }
      n.hidden = !ver;
      if (!ver) {
        estado.valores[c.id] = '';
        entrada(c).value = '';
        limpiarMarcas(c);
        refrescarCampo(c);
      }
    });
    actualizarProgreso();
  }

  const camposActivos = () => CAMPOS.filter(c => !c.visible || c.visible());
  const habilitado = c => !estado.habilitados || estado.habilitados.has(c.id);
  const camposRequeridos = () => camposActivos().filter(c => !c.opcional);
  const completo = c => {
    const v = estado.valores[c.id];
    if (!v) return false;
    if (c.tipo === 'select') return true;
    return !(c.validar && c.validar(v));
  };

  function refrescarCampo(c) {
    const n = nodoCampo(c);
    n.classList.toggle('ok', completo(c) && !n.classList.contains('error') && habilitado(c));
    actualizarProgreso();
  }

  function aplicarBloqueos() {
    const correccion = estado.modo === 'actualizacion' && estado.accion === 'correccion';
    CAMPOS.forEach(c => {
      const bloq = !habilitado(c);
      const n = nodoCampo(c);
      n.classList.toggle('bloqueado', bloq);
      entrada(c).disabled = bloq || (c.id === 'numero' && $('#sn-numero').checked);
      $(`[data-corregir="${c.id}"]`).hidden = !(correccion && bloq);
      refrescarCampo(c);
    });
    $('#sn-numero').disabled = !habilitado(CAMPO.numero);
  }

  /* Un dato oculto (teléfono, mail, comentarios) que se habilita se vacía: hay que escribirlo completo. */
  function vaciarSiOculto(k) {
    if (!estado.ocultos.has(k)) return;
    estado.valores[k] = '';
    const el = entrada(CAMPO[k]);
    el.value = '';
    el.placeholder = 'Dato oculto por seguridad: escribí el nuevo completo';
    if (CAMPO[k].maximo) actualizarContador(CAMPO[k]);
  }

  function habilitarCorreccion(id) {
    [id].concat(DEPENDIENTES[id] || []).forEach(k => { estado.habilitados.add(k); vaciarSiOculto(k); });
    aplicarBloqueos();
    const el = entrada(CAMPO[id]);
    el.focus();
    if (el.select && CAMPO[id].tipo !== 'select') el.select();
  }

  function marcarError(c, mensaje, sonar = true) {
    const n = nodoCampo(c);
    n.classList.remove('ok', 'sacudir');
    n.classList.add('error');
    $('span', $('#m-' + c.id)).textContent = mensaje;
    entrada(c).setAttribute('aria-invalid', 'true');
    void n.offsetWidth;
    n.classList.add('sacudir', 'reciente');
    clearTimeout(n._timerMsg);
    n._timerMsg = setTimeout(() => n.classList.remove('reciente'), 3500);
    if (sonar) Sonido.error();
  }

  function marcarFaltante(c) {
    const n = nodoCampo(c);
    n.classList.remove('ok');
    n.classList.add('faltante');
    $('span', $('#m-' + c.id)).textContent = 'Falta completar este campo.';
    entrada(c).setAttribute('aria-invalid', 'true');
  }

  function limpiarMarcas(c) {
    const n = nodoCampo(c);
    n.classList.remove('error', 'sacudir', 'reciente');
    if (estado.valores[c.id]) n.classList.remove('faltante');
    if (!n.classList.contains('faltante')) entrada(c).removeAttribute('aria-invalid');
  }

  function actualizarProgreso() {
    const activos = camposRequeridos();
    const hechos = activos.filter(completo).length;
    $('#progreso-valor').textContent = hechos;
    $('#progreso-total').textContent = activos.length;
    $('#progreso-relleno').style.width = (100 * hechos / activos.length) + '%';
  }

  function siguienteCampo(id) {
    const activos = camposActivos().filter(c => !entrada(c).disabled);
    const i = activos.findIndex(c => c.id === id);
    if (i >= 0 && i < activos.length - 1) entrada(activos[i + 1]).focus();
    else $('#btn-guardar').focus();
  }

  function datosFormulario() {
    const d = {};
    CAMPOS.forEach(c => { d[c.id] = (estado.valores[c.id] || '').trim(); });
    if (d.barrio !== 'Otro') d.barrioOtro = '';
    if (d.vinculo !== 'Familiar') d.parentesco = '';
    if (d.parentesco !== 'Otro') d.parentescoOtro = '';
    return d;
  }

  function formularioConDatos() {
    if (estado.modo !== 'nueva' || $('#form-carga').hidden) return false;
    return CAMPOS.some(c => (estado.valores[c.id] || '') !== '') || !!(estado.textos.barrio || '').trim();
  }

  function cargarEnFormulario(datos) {
    estado.valores = {};
    estado.textos = {};
    CAMPOS.forEach(c => {
      const v = (datos && datos[c.id]) || '';
      estado.valores[c.id] = v;
      if (c.tipo === 'combo') estado.textos[c.id] = v;
      const el = entrada(c);
      el.value = v;
      if (c.tipo !== 'select') el.placeholder = c.placeholder || c.ejemplo || '';
      nodoCampo(c).classList.remove('error', 'faltante', 'sacudir', 'reciente', 'ok', 'duplicado');
      el.removeAttribute('aria-invalid');
    });
    const sn = $('#sn-numero');
    sn.checked = estado.valores.numero === 'S/N';
    // Los valores ya están cargados: los campos condicionales se muestran si corresponde.
    refrescarVisibilidad(false);
    CAMPOS.filter(c => c.maximo).forEach(actualizarContador);
    verificados.dni = verificados.cuit = null;
    estado.duplicados = { dni: null, cuit: null };
    aplicarBloqueos();
  }

  /* ---------- Modos del formulario ---------- */
  function aplicarModo() {
    const { modo, accion, ficha } = estado;
    const f = $('#form-carga');
    f.dataset.modo = modo;
    const titulos = {
      nueva: ['Nueva carga', 'Completá los datos respetando el formato indicado en cada campo.'],
      edicion: ['Editar última carga' + (ficha && ficha.id ? ` #${ficha.id}` : ''), 'Corregí los datos necesarios y guardá los cambios.'],
      actualizacion: [accion ? ACCIONES[accion].titulo : '', 'Solo se puede modificar lo habilitado; el resto de la ficha queda bloqueado.'],
    };
    $('#form-titulo').textContent = titulos[modo][0];
    $('#form-subtitulo').textContent = titulos[modo][1];
    $('#form-titulo-icono').innerHTML = icono(modo === 'actualizacion' ? ACCIONES[accion].icono : modo === 'edicion' ? 'pencil' : 'clipboard');
    $('.progreso').hidden = modo === 'actualizacion';
    $('#btn-limpiar').hidden = modo !== 'nueva';
    $('#btn-guardar span').textContent = modo === 'nueva' ? 'Guardar' : 'Guardar cambios';

    const banner = $('#banner-edicion');
    banner.hidden = modo === 'nueva';
    banner.className = 'banner-edicion ' + (modo === 'actualizacion' ? 'actualizando' : '');
    if (modo === 'edicion') {
      $('#banner-texto').innerHTML = 'Estás editando <strong>tu última carga</strong>. Guardá los cambios o cancelá.';
    } else if (modo === 'actualizacion') {
      const d = ficha.datos;
      const nombre = [d.apellido, d.nombre].filter(Boolean).join(', ') || 'contribuyente sin nombre';
      let extra = '';
      if (accion === 'telefono') extra = esc(ACCIONES.telefono.desc(d));
      if (accion === 'domicilio') {
        const actual = [[d.calle, d.numero].filter(Boolean).join(' '), d.barrio === 'Otro' ? d.barrioOtro : d.barrio].filter(Boolean).join(', ');
        extra = `Domicilio actual: <strong>${esc(actual || 'sin cargar')}</strong>. Escribí el nuevo; el anterior queda en el historial.`;
      }
      if (accion === 'correccion') extra = 'Tocá <strong>Corregir</strong> en el campo que quieras modificar.';
      $('#banner-texto').innerHTML = `Ficha de <strong>${esc(nombre)}</strong>${d.dni ? ' · DNI ' + esc(d.dni) : ''}.<br>${extra}`;
    }
    $('#banner-icono').innerHTML = icono(modo === 'actualizacion' ? 'users' : 'pencil');
    aplicarBloqueos();
    pintarUltima();
  }

  function abrirFormulario() {
    const f = $('#form-carga');
    const estabaOculto = f.hidden;
    f.hidden = false;
    $('#btn-nueva-carga').hidden = true;
    if (estabaOculto) { f.classList.remove('aparece'); void f.offsetWidth; f.classList.add('aparece'); }
    setTimeout(() => {
      f.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const primero = camposActivos().find(c => !entrada(c).disabled) || null;
      if (primero) entrada(primero).focus({ preventScroll: true });
      else { const b = $('.btn-corregir:not([hidden])'); if (b) b.focus({ preventScroll: true }); }
    }, 60);
  }

  function cerrarFormulario() {
    estado.ocultos = new Set();
    estado.modo = 'nueva';
    estado.accion = null;
    estado.ficha = null;
    estado.habilitados = null;
    cargarEnFormulario(null);
    aplicarModo();
    $('#form-carga').hidden = true;
    $('#btn-nueva-carga').hidden = false;
  }

  function nuevaCarga(prefijo) {
    estado.ocultos = new Set();
    estado.modo = 'nueva';
    estado.accion = null;
    estado.ficha = null;
    estado.habilitados = null;
    cargarEnFormulario(prefijo || null);
    aplicarModo();
    if (prefijo) CAMPOS.forEach(c => { if (prefijo[c.id]) refrescarCampo(c); });
    abrirFormulario();
  }

  function iniciarActualizacion(ficha, accion) {
    estado.modo = 'actualizacion';
    estado.accion = accion;
    estado.ficha = ficha;
    const datos = Object.assign({}, ficha.datos);
    if (accion === 'domicilio') ['calle', 'numero', 'piso', 'barrio', 'barrioOtro'].forEach(k => { datos[k] = ''; });
    const campos = ACCIONES[accion].campos(ficha.datos);
    estado.habilitados = new Set(campos.flatMap(k => [k].concat(DEPENDIENTES[k] || [])));
    estado.ocultos = new Set(ficha.ocultos || []);
    cargarEnFormulario(datos);
    estado.habilitados.forEach(vaciarSiOculto);
    aplicarModo();
    abrirFormulario();
  }

  async function cancelar() {
    if (formularioConDatos()) {
      const ok = await modal({
        titulo: '¿Descartar la carga?',
        html: '<p>Se borrarán los datos que escribiste y no se guardará nada.</p>',
        si: 'Descartar', no: 'Seguir cargando', tipo: 'peligro', iconoId: 'x',
      });
      if (!ok) return;
    }
    cerrarFormulario();
    $('#buscar-valor').focus();
  }

  async function limpiar() {
    if (!formularioConDatos()) return;
    const ok = await modal({
      titulo: '¿Limpiar el formulario?',
      html: '<p>Se borrarán todos los datos cargados en pantalla.</p>',
      si: 'Limpiar', no: 'Cancelar', tipo: 'peligro', iconoId: 'reset',
    });
    if (ok) { cargarEnFormulario(null); entrada(CAMPOS[0]).focus(); }
  }

  /* ---------- Ficha ya existente (DNI / CUIT repetido) ---------- */
  const verificados = { dni: null, cuit: null }; // { valor, promesa }
  function verificarExistente(campo, { mostrar } = {}) {
    if (!habilitado(CAMPO[campo])) return Promise.resolve(null);
    const v = estado.valores[campo] || '';
    const ok = campo === 'dni' ? /^[1-9]\d{6,7}$/.test(v) : cuitValido(v);
    if (!ok) return Promise.resolve(null);
    const previo = verificados[campo];
    if (previo && previo.valor === v) return previo.promesa;
    const promesa = (async () => {
      let r;
      try {
        r = await api('buscar', { tipo: campo, valor: v, excluir: estado.ficha ? estado.ficha.ref : '' });
      } catch (err) {
        verificados[campo] = null;
        if (err.sesionVencida) sesionVencida();
        return null;
      }
      if (estado.valores[campo] !== v) return null;
      const f = r.resultados[0] || null;
      estado.duplicados[campo] = f;
      marcarDuplicado(campo, f);
      if (f && mostrar) {
        if (estado.modo === 'nueva') await ofrecerFichaExistente(f, campo);
        else { Sonido.error(); toast(`Ya existe otra ficha con ese ${campo === 'dni' ? 'DNI' : 'CUIT/CUIL'}. No puede repetirse.`, 'error'); }
      }
      return f;
    })();
    verificados[campo] = { valor: v, promesa };
    return promesa;
  }

  function marcarDuplicado(campo, f) {
    nodoCampo(CAMPO[campo]).classList.toggle('duplicado', !!f);
    if (f) {
      $(`#a-${campo} span`).textContent = estado.modo === 'nueva'
        ? `Ya existe una ficha con este ${campo === 'dni' ? 'DNI' : 'CUIT/CUIL'}. Al guardar vas a poder sumar los datos a esa ficha.`
        : `Ya existe otra ficha con este ${campo === 'dni' ? 'DNI' : 'CUIT/CUIL'}.`;
    } else {
      estado.duplicados[campo] = null;
      if (verificados[campo] && verificados[campo].valor !== estado.valores[campo]) verificados[campo] = null;
    }
  }

  async function ofrecerFichaExistente(f, campo) {
    const accion = await elegirAccion(f, { duplicado: true, campo });
    if (accion) iniciarActualizacion(f, accion);
    return accion;
  }

  /* ============================ BUSCADOR ============================ */
  function prepararBuscador() {
    const input = $('#buscar-valor');
    const nodo = $('#buscar-campo');
    const tipoActual = () => estado.busqueda.tipo;
    const pintarTipo = () => {
      const b = BUSQUEDAS[tipoActual()];
      $$('.buscar-tipo[data-tipo]').forEach(x => {
        const act = x.dataset.tipo === tipoActual();
        x.classList.toggle('activo', act);
        x.setAttribute('aria-checked', act);
      });
      input.placeholder = `Ej: ${b.ejemplo}`;
      input.setAttribute('aria-label', 'Buscar por ' + b.etiqueta);
      $('#buscar-formato').innerHTML = `Solo números, sin puntos ni guiones · Ej: <code>${b.ejemplo}</code>`;
    };
    $$('.buscar-tipo[data-tipo]').forEach(x => x.addEventListener('click', () => {
      estado.busqueda = { tipo: x.dataset.tipo, valor: '', resultados: null };
      input.value = '';
      nodo.classList.remove('error', 'reciente');
      pintarTipo();
      pintarResultados();
      input.focus();
    }));
    input.addEventListener('input', () => {
      const previo = estado.busqueda.valor;
      const v = input.value;
      const campo = CAMPO[tipoActual()];
      const err = v === '' ? null : (campo.filtro(v) || (tipoActual() === 'dni' && v.length > 8 ? 'El DNI tiene como máximo 8 dígitos.' : null));
      if (err) {
        input.value = previo;
        errorBuscador(err);
        return;
      }
      estado.busqueda.valor = v;
      nodo.classList.remove('error', 'reciente');
    });
    $('#form-buscar').addEventListener('submit', e => { e.preventDefault(); buscar(); });
    $('#btn-nueva-carga').addEventListener('click', () => nuevaCargaDesdeBusqueda());
    pintarTipo();
  }

  function errorBuscador(msg) {
    const nodo = $('#buscar-campo');
    nodo.classList.remove('sacudir');
    void nodo.offsetWidth;
    nodo.classList.add('error', 'sacudir', 'reciente');
    $('#buscar-msg span').textContent = msg;
    clearTimeout(nodo._timer);
    nodo._timer = setTimeout(() => nodo.classList.remove('reciente'), 3500);
    Sonido.error();
  }

  async function buscar() {
    const { tipo, valor } = estado.busqueda;
    const b = BUSQUEDAS[tipo];
    if (!valor) { errorBuscador(`Escribí el ${b.etiqueta} que querés buscar.`); $('#buscar-valor').focus(); return; }
    if (!b.ok(valor)) { errorBuscador(b.mal); $('#buscar-valor').focus(); return; }
    const btn = $('#btn-buscar');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span><span>Buscando…</span>';
    try {
      const r = await api('buscar', { tipo, valor });
      estado.busqueda.resultados = r.resultados;
      estado.busqueda.buscado = { tipo, valor };
      pintarResultados();
    } catch (err) {
      if (err.sesionVencida) return sesionVencida();
      toast(esc(err.message), 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = `${icono('search')}<span>Buscar</span>`;
    }
  }

  function pintarResultados() {
    const cont = $('#buscar-resultados');
    const { resultados, buscado } = estado.busqueda;
    $('#btn-nueva-carga').classList.toggle('destacado', !!(resultados && !resultados.length));
    if (!resultados) { cont.innerHTML = ''; return; }
    const b = BUSQUEDAS[buscado.tipo];
    if (!resultados.length) {
      cont.innerHTML = `<div class="sin-resultados">${icono('check-circle')}
        <div><strong>No hay ninguna ficha con ${b.etiqueta} ${esc(buscado.valor)}.</strong>
        <span>Podés realizar una nueva carga: el dato buscado ya queda completado.</span></div></div>`;
      return;
    }
    cont.innerHTML = `<p class="resultados-titulo">${resultados.length === 1 ? 'Se encontró 1 ficha' : `Se encontraron ${resultados.length} fichas`} con ${b.etiqueta} ${esc(buscado.valor)}:</p>`
      + resultados.map((f, i) => `<div class="resultado">${htmlFicha(f)}
          <button type="button" class="btn btn-primario" data-resultado="${i}">${icono('pencil')}<span>Actualizar esta ficha</span></button></div>`).join('');
    $$('[data-resultado]', cont).forEach(bt => bt.addEventListener('click', async () => {
      const f = resultados[Number(bt.dataset.resultado)];
      if (formularioConDatos()) {
        const ok = await modal({
          titulo: 'Tenés una carga en curso',
          html: '<p>Para trabajar sobre esta ficha se van a descartar los datos que estás cargando.</p><p class="pregunta">¿Querés descartarlos?</p>',
          si: 'Descartar', no: 'Volver', tipo: 'peligro',
        });
        if (!ok) return;
      }
      const accion = await elegirAccion(f);
      if (accion) iniciarActualizacion(f, accion);
    }));
  }

  async function nuevaCargaDesdeBusqueda() {
    const { resultados, buscado } = estado.busqueda;
    const prefijo = buscado && resultados && !resultados.length ? { [buscado.tipo]: buscado.valor } : null;
    nuevaCarga(prefijo);
    if (prefijo && (buscado.tipo === 'dni' || buscado.tipo === 'cuit')) {
      // Ya se verificó que no existe: no hace falta volver a consultar.
      verificados[buscado.tipo] = { valor: buscado.valor, promesa: Promise.resolve(null) };
    }
  }

  function limpiarBusqueda() {
    estado.busqueda = { tipo: estado.busqueda.tipo, valor: '', resultados: null };
    $('#buscar-valor').value = '';
    pintarResultados();
  }

  /* ============================ GUARDAR ============================ */
  async function alGuardar(e) {
    e.preventDefault();
    if (estado.guardando) return;

    // Cerrar el campo activo (capitaliza, recorta y valida).
    const activo = document.activeElement;
    const cActivo = activo && activo.id && CAMPO[activo.id.replace(/^f-/, '')];
    if (cActivo && cActivo.tipo !== 'select') alSalir(cActivo, activo);

    const activos = camposActivos().filter(habilitado);
    const datos = datosFormulario();

    // 1) Formatos incorrectos: no se puede guardar.
    const comboSinElegir = activos.filter(c => c.tipo === 'combo' && (estado.textos[c.id] || '').trim() && !estado.valores[c.id]);
    const invalidos = comboSinElegir.concat(activos.filter(c => c.tipo !== 'select' && estado.valores[c.id] && c.validar && c.validar(estado.valores[c.id])));
    if (invalidos.length) {
      invalidos.forEach(c => marcarError(c, c.tipo === 'combo' && !estado.valores[c.id]
        ? 'Elegí un barrio de la lista. Si no está, elegí «Otro».' : c.validar(estado.valores[c.id]), false));
      Sonido.error();
      toast('Hay campos con formato incorrecto. Corregí lo marcado en rojo.', 'error');
      entrada(invalidos[0]).focus();
      return;
    }

    let cambios = null;
    if (estado.modo === 'actualizacion') {
      // 2a) Actualización: solo se envía lo habilitado y debe haber algún cambio.
      cambios = {};
      estado.habilitados.forEach(k => { if (!(estado.ocultos.has(k) && !datos[k])) cambios[k] = datos[k]; });
      const tocados = Object.keys(cambios).filter(k => (cambios[k] || '') !== (estado.ficha.datos[k] || ''));
      if (!tocados.length) {
        Sonido.error();
        toast(estado.accion === 'correccion' ? 'No modificaste ningún dato. Tocá «Corregir» en el campo que quieras cambiar.' : 'Todavía no escribiste el dato nuevo.', 'error');
        return;
      }
      if (estado.accion === 'telefono') {
        const c = CAMPO[ACCIONES.telefono.campos(estado.ficha.datos)[0]];
        if (!estado.valores[c.id]) { marcarError(c, 'Escribí el teléfono nuevo.'); entrada(c).focus(); return; }
      }
      if (estado.accion === 'domicilio' && !datos.calle && !datos.barrio) {
        marcarError(CAMPO.calle, 'Escribí el nuevo domicilio.');
        entrada(CAMPO.calle).focus();
        return;
      }
    } else {
      // 2b) Formulario vacío.
      if (!CAMPOS.some(c => c.tipo !== 'select' && c.esDato !== false && datos[c.id])) {
        Sonido.error();
        toast('El formulario está vacío. Cargá al menos un dato del contribuyente.', 'error');
        entrada(CAMPOS[0]).focus();
        return;
      }
      // 2c) Carga nueva con DNI / CUIT que ya existe: se ofrece sumar los datos a esa ficha.
      if (estado.modo === 'nueva') {
        const [fd, fc] = await Promise.all([verificarExistente('dni'), verificarExistente('cuit')]);
        const f = fd || fc;
        if (f) { await ofrecerFichaExistente(f, fd ? 'dni' : 'cuit'); return; }
      }
    }

    // 3) Campos faltantes: se pregunta si guardar igual.
    const faltan = activos.filter(c => !c.opcional && !estado.valores[c.id]);
    if (faltan.length) {
      Sonido.error();
      const lista = faltan.map(c => `<li>${esc(c.etiqueta.replace(/^¿|\?$/g, ''))}</li>`).join('');
      const guardarIgual = await modal({
        titulo: 'Faltan datos',
        html: `<p>Faltó cargar:</p><ul>${lista}</ul><p class="pregunta">¿Querés guardar igual?</p>`,
        si: 'Guardar', no: 'No guardar',
      });
      if (!guardarIgual) {
        faltan.forEach(marcarFaltante);
        entrada(faltan[0]).focus();
        return;
      }
    }

    await enviar(datos, cambios);
  }

  async function enviar(datos, cambios) {
    const btn = $('#btn-guardar');
    const htmlBtn = btn.innerHTML;
    estado.guardando = true;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span><span>Guardando…</span>';
    try {
      if (estado.modo === 'actualizacion') {
        const { ref } = estado.ficha;
        const r = await api('actualizar', { ref, que: estado.accion, cambios });
        if (estado.ultima && estado.ultima.ref === ref) {
          const ocultos = r.ocultos || [];
          Object.keys(r.datos).forEach(k => {
            if (!ocultos.includes(k)) estado.ultima.datos[k] = r.datos[k];
            else if (k in cambios) estado.ultima.datos[k] = cambios[k];
          });
          guardarUltima();
        }
        Sonido.exito();
        toast(`Ficha actualizada: <strong>${esc(ACCIONES[estado.accion].titulo.toLowerCase())}</strong>.`, 'exito');
      } else if (estado.modo === 'edicion') {
        await api('editar', { ref: estado.ficha.ref, datos });
        estado.ultima.datos = datos;
        guardarUltima();
        Sonido.exito();
        toast('Cambios de tu última carga guardados.', 'exito');
      } else {
        const r = await api('guardar', { datos });
        estado.ultima = { ref: r.ref, id: r.id, fecha: r.fecha, datos };
        guardarUltima();
        estado.cargasSesion++;
        almacen.set('gr_contador', estado.cargasSesion);
        Sonido.exito();
        toast(`Carga ${r.id ? `<strong>#${r.id}</strong> ` : ''}guardada correctamente.`, 'exito', { texto: 'Editar', fn: editarUltima });
      }
      cerrarFormulario();
      limpiarBusqueda();
      pintarUltima(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      $('#buscar-valor').focus({ preventScroll: true });
    } catch (err) {
      Sonido.error();
      if (err.sesionVencida) return sesionVencida();
      if (err.existe && err.coincidencias && err.coincidencias.length && estado.modo === 'nueva') {
        const f = err.coincidencias[0];
        const campo = f.datos.dni && f.datos.dni === datos.dni ? 'dni' : 'cuit';
        estado.duplicados[campo] = f;
        marcarDuplicado(campo, f);
        await ofrecerFichaExistente(f, campo);
        return;
      }
      toast(esc(err.message), 'error');
    } finally {
      estado.guardando = false;
      btn.disabled = false;
      btn.innerHTML = htmlBtn;
      $('#btn-guardar span').textContent = estado.modo === 'nueva' ? 'Guardar' : 'Guardar cambios';
    }
  }

  /* ---------- Última carga / Editar ---------- */
  const claveUltima = () => 'gr_ultima_' + (estado.sesion ? estado.sesion.usuario.usuario : '');
  function guardarUltima() { almacen.set(claveUltima(), estado.ultima); }

  function pintarUltima(recien) {
    const u = estado.ultima;
    $('#ultima-vacia').hidden = !!u;
    $('#ultima-datos').hidden = !u;
    $('#contador-sesion').textContent = fmtNum(estado.cargasSesion);
    if (!u) return;
    const d = u.datos;
    // El perfil Carga no ve números de carga (no revelan el total de la base).
    $('#ultima-id').textContent = [d.apellido, d.nombre].filter(Boolean).join(', ') || 'Sin nombre';
    $('#ultima-num').textContent = veNumeros() && u.id ? '#' + u.id : '';
    $('#ultima-num').hidden = !(veNumeros() && u.id);
    const f = new Date(u.fecha);
    $('#ultima-hora').textContent = isNaN(f) ? '' : 'Guardada el ' + f.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) + ' h';
    const filas = [
      ['DNI', d.dni || '—'],
      ['Celular', [d.celular, d.celular2].filter(Boolean).join(' · ') || '—'],
      ['Mail', d.mail || '—'],
      ['Domicilio', [d.calle, d.numero].filter(Boolean).join(' ') + (d.piso ? `, ${d.piso}` : '') || '—'],
      ['Barrio', (d.barrio === 'Otro' ? d.barrioOtro : d.barrio) || '—'],
      ['Vínculo', d.vinculo ? d.vinculo + (d.parentesco ? ` (${d.parentesco === 'Otro' && d.parentescoOtro ? d.parentescoOtro : d.parentesco})` : '') : '—'],
    ];
    if (d.partidaInmueble) filas.push(['Partida inmueble', d.partidaInmueble]);
    if (d.partidaComercio) filas.push(['Partida comercio', d.partidaComercio]);
    if (d.comentarios) filas.push(['Comentarios', d.comentarios]);
    $('#ultima-lista').innerHTML = filas.map(([k, v]) => `<dt>${k}</dt><dd title="${esc(v)}">${esc(v)}</dd>`).join('');
    $('#btn-editar').disabled = estado.modo === 'edicion';
    if (recien) {
      const t = $('#tarjeta-ultima');
      t.classList.remove('recien'); void t.offsetWidth; t.classList.add('recien');
    }
  }

  async function editarUltima() {
    if (!estado.ultima || estado.modo === 'edicion') return;
    if (formularioConDatos() || estado.modo === 'actualizacion') {
      const ok = await modal({
        titulo: 'Tenés una carga en curso',
        html: '<p>Para editar tu última carga se van a descartar los datos que estás cargando ahora.</p><p class="pregunta">¿Querés descartarlos?</p>',
        si: 'Descartar y editar', no: 'Volver', tipo: 'peligro',
      });
      if (!ok) return;
    }
    estado.modo = 'edicion';
    estado.ocultos = new Set();
    estado.accion = null;
    estado.habilitados = null;
    estado.ficha = { ref: estado.ultima.ref, id: estado.ultima.id, datos: estado.ultima.datos };
    cargarEnFormulario(estado.ultima.datos);
    aplicarModo();
    irA('carga');
    abrirFormulario();
  }

  /* ============================ ESTADÍSTICAS ============================ */
  const tip = $('#tooltip');
  function conTooltip(el, html) {
    el.addEventListener('mouseenter', () => { tip.innerHTML = html; tip.hidden = false; });
    el.addEventListener('mousemove', e => { tip.style.left = e.clientX + 'px'; tip.style.top = e.clientY + 'px'; });
    el.addEventListener('mouseleave', () => { tip.hidden = true; });
  }

  /* Máximo "redondo" del eje, par, para que la línea del medio sea un número entero. */
  function techo(n) {
    const mitad = Math.max(1, Math.ceil(n / 2));
    const p = Math.pow(10, Math.floor(Math.log10(mitad)));
    const paso = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map(m => m * p).find(v => Number.isInteger(v) && v >= mitad);
    return 2 * paso;
  }

  /* ---------- Filtro de período ---------- */
  const PRESETS = {
    7: hoy => sumarDias(hoy, -6),
    30: hoy => sumarDias(hoy, -29),
    mes: hoy => hoy.slice(0, 8) + '01',
    anio: hoy => hoy.slice(0, 5) + '01-01',
    todo: () => 'inicio',
  };
  estado.filtro = { preset: '30', desde: '', hasta: '' };

  function elegirPreset(p) {
    const hoy = claveFecha(Date.now());
    estado.filtro = { preset: p, desde: PRESETS[p](hoy), hasta: hoy };
    cargarEstadisticas();
  }

  function alCambiarFechas() {
    const d = $('#filtro-desde').value, h = $('#filtro-hasta').value;
    if (!d || !h) return;
    estado.filtro = { preset: null, desde: d, hasta: h };
    cargarEstadisticas();
  }

  const fechaCorta = k => fechaDeClave(k).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const textoPeriodo = s => (s.desde === s.hasta ? `el ${fechaCorta(s.desde)}` : `del ${fechaCorta(s.desde)} al ${fechaCorta(s.hasta)}`);

  let pedidoStats = 0;
  async function cargarEstadisticas() {
    if (!estado.filtro.hasta) return elegirPreset(estado.filtro.preset || '30');
    const panel = $('#panel-estadisticas');
    const btn = $('#btn-actualizar');
    const n = ++pedidoStats;
    $$('.preset').forEach(b => {
      const act = b.dataset.preset === String(estado.filtro.preset);
      b.classList.toggle('activo', act);
      b.setAttribute('aria-pressed', act);
    });
    panel.classList.add('cargando');
    btn.classList.add('girando');
    try {
      const s = await api('estadisticas', { desde: estado.filtro.desde, hasta: estado.filtro.hasta });
      if (n !== pedidoStats) return; // llegó una respuesta vieja
      pintarEstadisticas(s);
    } catch (err) {
      if (err.sesionVencida) return sesionVencida();
      toast(esc(err.message), 'error');
    } finally {
      if (n === pedidoStats) {
        panel.classList.remove('cargando');
        btn.classList.remove('girando');
      }
    }
  }

  function pintarEstadisticas(s) {
    const hoy = claveFecha(Date.now());
    $('#filtro-desde').value = s.desde;
    $('#filtro-hasta').value = s.hasta;
    $('#filtro-desde').max = $('#filtro-hasta').max = hoy;

    const periodo = textoPeriodo(s);
    const pct = n => (s.total ? Math.round(100 * n / s.total) : 0);
    const desde7 = fechaDeClave(sumarDias(hoy, -6)).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
    const kpis = [
      { ic: 'database', t: 'Registros del período', v: s.total, sub: 'en todas las secretarías' },
      { ic: 'phone', t: 'Teléfonos celulares', v: s.celulares, sub: `${pct(s.celulares)}% de los registros del período`, medidor: pct(s.celulares) },
      { ic: 'mail', t: 'Mails', v: s.mails, sub: `${pct(s.mails)}% de los registros del período`, medidor: pct(s.mails) },
      { ic: 'calendar', t: 'Últimos 7 días', v: s.ultimos7, sub: `desde el ${desde7} · no depende del período` },
    ];
    $('#kpis').innerHTML = kpis.map(k => `
      <div class="tarjeta kpi">
        <div class="kpi-cabecera"><span class="kpi-icono">${icono(k.ic)}</span>${k.t}</div>
        <div class="kpi-valor">${fmtNum(k.v)}</div>
        <div class="kpi-sub">${k.sub}</div>
        ${k.medidor != null ? `<div class="kpi-medidor" role="img" aria-label="${k.medidor}%"><span style="width:${k.medidor}%"></span></div>` : ''}
      </div>`).join('');

    const Periodo = periodo[0].toUpperCase() + periodo.slice(1);
    $('#t-serie').textContent = s.granularidad === 'dia' ? 'Cargas por día' : 'Cargas por mes';
    $$('.st-periodo').forEach(el => { el.textContent = Periodo; });
    pintarBarras($('#g-secretarias'), s.porSecretaria, s.total);
    pintarBarras($('#g-vinculos'), s.porVinculo, s.total);
    pintarColumnas($('#g-dias'), s.serie, s.granularidad, hoy);

    const g = new Date(s.generado);
    $('#stats-actualizado').textContent = `Período: ${periodo} · actualizado a las ` +
      g.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) + ' h';
  }

  function pintarBarras(cont, items, total) {
    if (!items.length) { cont.innerHTML = '<p class="vacio">No hay cargas en este período.</p>'; return; }
    const max = Math.max(...items.map(i => i.cantidad));
    cont.innerHTML = items.map(i => `
      <div class="barra-fila">
        <div class="barra-etiquetas"><span>${esc(i.nombre)}</span><strong>${fmtNum(i.cantidad)}</strong></div>
        <div class="barra-pista"><div class="barra-valor" style="width:0"></div></div>
      </div>`).join('');
    const filas = $$('.barra-fila', cont);
    requestAnimationFrame(() => filas.forEach((f, k) => {
      $('.barra-valor', f).style.width = (100 * items[k].cantidad / max) + '%';
    }));
    filas.forEach((f, k) => conTooltip(f,
      `${esc(items[k].nombre)}<br><strong>${fmtNum(items[k].cantidad)}</strong> cargas · ${total ? Math.round(100 * items[k].cantidad / total) : 0}%`));
  }

  function pintarColumnas(cont, serie, granularidad, hoy) {
    const porDia = granularidad === 'dia';
    const n = serie.length;
    const max = techo(Math.max(0, ...serie.map(d => d.cantidad)));
    const ticks = [0, max / 2, max];
    const corto = porDia
      ? k => fechaDeClave(k).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })
      : k => { const f = fechaDeClave(k); return f.toLocaleDateString('es-AR', { month: 'short' }).replace('.', '') + ' ' + String(f.getFullYear()).slice(2); };
    const largo = porDia
      ? k => fechaDeClave(k).toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      : k => fechaDeClave(k).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
    const actual = porDia ? hoy : hoy.slice(0, 7);
    const paso = Math.max(1, Math.ceil(n / 8));
    cont.style.setProperty('--col-max', n <= 12 ? '44px' : n <= 35 ? '18px' : '12px');
    cont.innerHTML = `
      <div class="columnas-area">
        ${ticks.map(t => `<div class="columnas-grilla ${t === 0 ? 'base' : ''}" style="top:${100 - 100 * t / max}%"><span>${fmtNum(t)}</span></div>`).join('')}
        <div class="columnas-serie">
          ${serie.map(d => `<div class="columna ${d.clave === actual ? 'hoy' : ''}"><span style="height:0"></span></div>`).join('')}
        </div>
      </div>
      <div class="columnas-ejex">${serie.map((d, i) => `<span>${(n - 1 - i) % paso === 0 ? corto(d.clave) : ''}</span>`).join('')}</div>`;
    cont.setAttribute('role', 'img');
    cont.setAttribute('aria-label', (porDia ? 'Cargas por día: ' : 'Cargas por mes: ') + serie.map(d => `${corto(d.clave)}: ${d.cantidad}`).join(', '));
    const cols = $$('.columna', cont);
    requestAnimationFrame(() => cols.forEach((c, i) => {
      const h = 100 * serie[i].cantidad / max;
      $('span', c).style.height = (serie[i].cantidad ? Math.max(h, 1.5) : 0) + '%';
    }));
    cols.forEach((c, i) => conTooltip(c, `${largo(serie[i].clave)}<br><strong>${fmtNum(serie[i].cantidad)}</strong> cargas`));
  }

  /* ============================ ADMINISTRACIÓN ============================ */
  const fechaHora = iso => {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  };
  const claveSello = () => 'rcd_sello_' + (estado.sesion ? estado.sesion.usuario.usuario : '');
  const claveHuellaLlave = () => 'rcd_llave_' + (estado.sesion ? estado.sesion.usuario.usuario : '');
  const admin = { tipoActividad: 'accesos', resumen: null };

  function descargar(blob, nombre) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nombre;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function cargarAdmin() {
    const panel = $('#panel-admin');
    const btn = $('#btn-admin-actualizar');
    panel.classList.add('cargando');
    btn.classList.add('girando');
    try {
      const sello = almacen.get(claveSello(), null, 'local');
      const [res, us, ba] = await Promise.all([
        api('adminResumen', { sello }), api('adminUsuarios'), api('adminBarrios'),
      ]);
      admin.resumen = res;
      pintarEstadoAdmin(res, sello);
      pintarUsuarios(us.usuarios);
      pintarBarriosAdmin(ba.barrios);
      pintarRespaldos(res);
      await cargarActividad();
    } catch (err) {
      if (err.sesionVencida) return sesionVencida();
      toast(esc(err.message), 'error');
    } finally {
      panel.classList.remove('cargando');
      btn.classList.remove('girando');
    }
  }

  /* ---------- Estado de seguridad ---------- */
  function pintarEstadoAdmin(r, selloGuardado) {
    const v = r.verificacion;
    const alertas = [];
    // 1) Sello: si el historial se reescribió desde la última visita, no coincide.
    if (r.sello && r.sello.hashActual !== r.sello.hashGuardado) {
      alertas.push(`<strong>El historial fue reescrito desde tu última visita.</strong> El evento N° ${r.sello.eventos} ya no es el mismo que viste la última vez. Alguien modificó la base por fuera del sistema.`);
    }
    // 2) Llave de respaldos cambiada sin que la cambies vos (desde este navegador).
    const huellaVista = almacen.get(claveHuellaLlave(), null, 'local');
    if (huellaVista && r.respaldo.llave && huellaVista !== r.respaldo.llave) {
      alertas.push(`<strong>La llave de los respaldos cambió.</strong> Antes era <code>${esc(huellaVista)}</code> y ahora es <code>${esc(r.respaldo.llave)}</code>. Si no fuiste vos, los respaldos nuevos podrían quedar en manos de otra persona.`);
    }
    if (!v.ok) alertas.push(`<strong>Se detectaron cambios hechos por fuera del sistema:</strong><ul>${v.problemas.slice(0, 12).map(p => `<li>${esc(p)}</li>`).join('')}</ul>`);
    $('#admin-alerta').innerHTML = alertas.length ? `<div class="alerta-roja">${icono('alert')}<div>${alertas.map(a => `<p>${a}</p>`).join('')}
        <button type="button" class="btn btn-secundario" id="btn-aceptar-sello">Revisado: tomar el estado actual como referencia</button></div></div>` : '';
    const bSello = $('#btn-aceptar-sello');
    if (bSello) bSello.addEventListener('click', () => {
      almacen.set(claveSello(), { eventos: v.eventos, hash: v.hash }, 'local');
      if (r.respaldo.llave) almacen.set(claveHuellaLlave(), r.respaldo.llave, 'local');
      $('#admin-alerta').innerHTML = '';
      toast('Estado actual tomado como nueva referencia.', 'info');
    });
    // Sin alertas: se actualiza la referencia guardada en este navegador.
    if (!alertas.length) {
      almacen.set(claveSello(), { eventos: v.eventos, hash: v.hash }, 'local');
      if (r.respaldo.llave) almacen.set(claveHuellaLlave(), r.respaldo.llave, 'local');
    }

    const alertasActividad = r.alertas || [];
    const tiles = [
      {
        clase: v.ok && !alertas.length ? 'bien' : 'mal', ic: v.ok && !alertas.length ? 'shield' : 'alert',
        t: 'Integridad de los datos', v: v.ok && !alertas.length ? 'Íntegra' : 'Revisar',
        sub: `${fmtNum(v.eventos)} eventos en la cadena · sello <code>${esc(v.hash.slice(0, 12))}</code>`,
      },
      {
        clase: r.respaldo.llave ? (r.respaldo.ultimo ? 'bien' : 'aviso') : 'mal', ic: 'database',
        t: 'Respaldos cifrados', v: r.respaldo.llave ? (r.respaldo.ultimo ? 'Activos' : 'Pendiente') : 'Sin llave',
        sub: r.respaldo.llave ? `Último: ${fechaHora(r.respaldo.ultimo)} · todos los días ${esc(r.respaldo.hora)} h` : 'Creá tu llave para activar los respaldos.',
      },
      {
        clase: alertasActividad.length ? 'aviso' : 'bien', ic: 'users',
        t: 'Alertas de actividad', v: alertasActividad.length ? fmtNum(alertasActividad.length) : 'Ninguna',
        sub: `${fmtNum(r.ingresosFallidos24h)} ingresos fallidos en 24 h · límite ${fmtNum(r.limiteBusquedasPorHora)} búsquedas/h`,
      },
    ];
    $('#admin-estado').innerHTML = tiles.map(k => `
      <div class="tarjeta estado-tile ${k.clase}">
        <div class="kpi-cabecera"><span class="kpi-icono">${icono(k.ic)}</span>${k.t}</div>
        <div class="estado-valor">${k.v}</div>
        <div class="kpi-sub">${k.sub}</div>
      </div>`).join('')
      + (alertasActividad.length ? `<div class="tarjeta alertas-lista"><strong>Últimas alertas (30 días)</strong><ul>${alertasActividad.slice(0, 8)
        .map(a => `<li><span>${fechaHora(a.fecha)}</span> <b>${esc(a.usuario)}</b> — ${esc(a.evento.replace(/^ALERTA:?\s*/, ''))}${a.detalle ? ` <em>(${esc(a.detalle)})</em>` : ''}</li>`).join('')}</ul></div>` : '');
  }

  /* ---------- Usuarios ---------- */
  function pintarUsuarios(lista) {
    admin.usuarios = lista;
    const yo = estado.sesion.usuario.usuario;
    const estadoU = u => [
      u.activo ? '<span class="insignia verde">Activo</span>' : '<span class="insignia gris">Inactivo</span>',
      u.bloqueado ? '<span class="insignia roja">Bloqueado</span>' : '',
      u.debe_cambiar_clave ? '<span class="insignia ambar">Clave temporal</span>' : '',
      u.doble_factor ? '<span class="insignia azul">2FA</span>' : '',
    ].join(' ');
    const boton = (que, ic, titulo, u) => `<button type="button" class="btn-icono chico" data-u="${esc(u.usuario)}" data-que="${que}" title="${titulo}" aria-label="${titulo} (${esc(u.usuario)})">${icono(ic)}</button>`;
    $('#tabla-usuarios').innerHTML = `<thead><tr><th>Usuario</th><th>Nombre</th><th>Perfil</th><th>Secretaría</th><th>Estado</th><th>Último ingreso</th><th></th></tr></thead><tbody>`
      + lista.map(u => `<tr class="${u.activo ? '' : 'inactivo'}">
          <td><code>${esc(u.usuario)}</code>${u.usuario === yo ? ' <span class="insignia gris">vos</span>' : ''}</td>
          <td>${esc(u.nombre)}</td><td><span class="perfil perfil-${esc(u.perfil).replace(/[^a-zA-Z]/g, '')}">${esc(u.perfil)}</span></td>
          <td>${esc(u.secretaria)}</td><td class="celda-estado">${estadoU(u)}</td><td>${fechaHora(u.ultimo_ingreso)}</td>
          <td class="celda-acciones">${boton('editar', 'pencil', 'Editar', u)}${boton('clave', 'key', 'Restablecer contraseña', u)}
            ${u.bloqueado ? boton('desbloquear', 'unlock', 'Desbloquear', u) : ''}
            ${u.doble_factor && u.usuario !== yo ? boton('reiniciar2fa', 'shield', 'Reiniciar doble factor', u) : ''}
            ${u.usuario !== yo ? boton(u.activo ? 'desactivar' : 'activar', u.activo ? 'x' : 'check', u.activo ? 'Desactivar' : 'Activar', u) : ''}</td>
        </tr>`).join('') + '</tbody>';
    $$('#tabla-usuarios [data-que]').forEach(b => b.addEventListener('click', () => accionUsuario(b.dataset.u, b.dataset.que)));
  }

  function htmlUsuario(u) {
    const secretarias = [...new Set((admin.usuarios || []).map(x => x.secretaria))].sort();
    return `<label class="mf-campo"><span>Usuario</span><input name="usuario" value="${esc(u ? u.usuario : '')}" ${u ? 'readonly' : ''}
        autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="ej: jperez"></label>
      <p class="mf-ayuda">De 3 a 30 caracteres: minúsculas, números, punto o guion. No se puede cambiar después.</p>
      <label class="mf-campo"><span>Nombre y apellido</span><input name="nombre" value="${esc(u ? u.nombre : '')}" autocomplete="off"></label>
      <label class="mf-campo"><span>Secretaría</span><input name="secretaria" list="lista-secretarias" value="${esc(u ? u.secretaria : '')}" autocomplete="off"></label>
      <datalist id="lista-secretarias">${secretarias.map(x => `<option value="${esc(x)}">`).join('')}</datalist>
      <label class="mf-campo"><span>Perfil</span><select name="perfil">
        ${['Carga', 'Análisis', 'Administrador'].map(p => `<option ${u && u.perfil === p ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
      <ul class="mf-perfiles"><li><b>Carga:</b> busca, carga y actualiza fichas. No ve números ni estadísticas.</li>
        <li><b>Análisis:</b> además ve las estadísticas.</li>
        <li><b>Administrador:</b> acceso total. Entra con doble factor.</li></ul>`;
  }

  async function mostrarClaveTemporal(usuario, clave) {
    await formulario({
      titulo: 'Contraseña temporal', icono: 'key', cancelar: 'Listo',
      html: `<p class="mf-texto">Contraseña temporal de <strong>${esc(usuario)}</strong>:</p>
        <p class="clave-temporal"><code>${esc(clave)}</code></p>
        <p class="mf-ayuda">Entregala en persona. Al ingresar, el sistema le va a pedir que elija una contraseña propia.
        Por seguridad, esta contraseña no se vuelve a mostrar.</p>`,
    });
  }

  async function accionUsuario(usuario, que) {
    const u = (admin.usuarios || []).find(x => x.usuario === usuario);
    if (que === 'editar') {
      const ok = await formulario({
        titulo: 'Editar usuario', icono: 'user', aceptar: 'Guardar', html: htmlUsuario(u),
        alEnviar: f => api('adminUsuarioGuardar', { datos: Object.assign(f, { nuevo: false }) }),
      });
      if (ok) { toast('Usuario actualizado.', 'exito'); cargarAdmin(); }
      return;
    }
    const textos = {
      clave: ['¿Restablecer la contraseña?', `Se genera una contraseña temporal para <strong>${esc(usuario)}</strong> y se cierran sus sesiones abiertas.`, 'Restablecer'],
      desactivar: ['¿Desactivar el usuario?', `<strong>${esc(usuario)}</strong> no va a poder ingresar. Sus cargas se conservan. Podés reactivarlo cuando quieras.`, 'Desactivar'],
      activar: ['¿Activar el usuario?', `<strong>${esc(usuario)}</strong> va a poder ingresar de nuevo.`, 'Activar'],
      desbloquear: ['¿Desbloquear el usuario?', `Se borran los intentos fallidos de <strong>${esc(usuario)}</strong>.`, 'Desbloquear'],
      reiniciar2fa: ['¿Reiniciar el doble factor?', `<strong>${esc(usuario)}</strong> va a tener que volver a vincular su celular la próxima vez que ingrese. Usalo si perdió o cambió el teléfono.`, 'Reiniciar'],
    }[que];
    const r = await formulario({
      titulo: textos[0], icono: que === 'desactivar' ? 'alert' : 'user', aceptar: textos[2], peligro: que === 'desactivar',
      html: `<p class="mf-texto">${textos[1]}</p>`,
      alEnviar: () => api('adminUsuarioAccion', { usuario, que }),
    });
    if (!r) return;
    if (r.claveTemporal) await mostrarClaveTemporal(usuario, r.claveTemporal);
    else toast('Listo.', 'exito');
    cargarAdmin();
  }

  async function nuevoUsuario() {
    const r = await formulario({
      titulo: 'Nuevo usuario', icono: 'user', aceptar: 'Crear usuario', html: htmlUsuario(null),
      alEnviar: f => api('adminUsuarioGuardar', { datos: Object.assign(f, { nuevo: true }) }),
    });
    if (!r) return;
    await mostrarClaveTemporal(r.usuario || $('#mf-form [name=usuario]').value, r.claveTemporal);
    cargarAdmin();
  }

  /* ---------- Barrios ---------- */
  function pintarBarriosAdmin(lista) {
    $('#admin-barrios').value = lista.join('\n');
    contarBarrios();
  }
  function contarBarrios() {
    const n = $('#admin-barrios').value.split('\n').map(x => x.trim()).filter(Boolean).length;
    $('#admin-barrios-cuenta').textContent = `${fmtNum(n)} barrios`;
  }
  async function guardarBarriosAdmin() {
    const lista = [...new Set($('#admin-barrios').value.split('\n').map(x => x.trim().replace(/\s+/g, ' ')).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'es'));
    try {
      const r = await api('adminBarrios', { lista });
      pintarBarriosAdmin(r.barrios);
      aplicarConfig({ barrios: r.barrios });
      toast(`Lista de barrios guardada (${fmtNum(r.barrios.length)}).`, 'exito');
    } catch (err) {
      if (err.sesionVencida) return sesionVencida();
      Sonido.error();
      toast(esc(err.message), 'error');
    }
  }

  /* ---------- Actividad ---------- */
  async function cargarActividad() {
    const tipo = admin.tipoActividad;
    const r = await api('adminActividad', { tipo, usuario: $('#actividad-usuario').value.trim(), limite: 200 });
    const t = $('#tabla-actividad');
    if (!r.filas.length) { t.innerHTML = '<tbody><tr><td class="vacio">Sin actividad para mostrar.</td></tr></tbody>'; return; }
    if (tipo === 'historial') {
      const detalle = e => {
        let c;
        try { c = JSON.parse(e.cambios); } catch (_) { return ''; }
        if (Array.isArray(c)) {
          return c.slice(0, 6).map(x => {
            const def = CAMPO[x.campo];
            return `<span class="cambio"><b>${esc(def ? def.etiqueta : x.campo)}:</b> ${x.antes ? `<s>${esc(x.antes)}</s> → ` : ''}${esc(x.despues || '(vacío)')}</span>`;
          }).join(' ') + (c.length > 6 ? ` <em>y ${c.length - 6} más</em>` : '');
        }
        return c.estado ? Object.entries(c.estado).filter(([k]) => !['clave', 'totp', 'huella'].includes(k)).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(' · ') : '';
      };
      t.innerHTML = '<thead><tr><th>N°</th><th>Fecha</th><th>Usuario</th><th>Acción</th><th>Sobre</th><th>Detalle</th></tr></thead><tbody>'
        + r.filas.map(e => `<tr><td>${e.n}</td><td class="nowrap">${fechaHora(e.fecha)}</td><td><code>${esc(e.usuario)}</code></td>
          <td>${esc(e.accion)}</td><td class="nowrap">${esc(e.objeto.replace('registro:', 'Ficha #').replace('usuario:', 'Usuario ').replace('ajuste:', 'Ajuste '))}</td>
          <td class="detalle">${detalle(e)}</td></tr>`).join('') + '</tbody>';
    } else {
      t.innerHTML = '<thead><tr><th>Fecha</th><th>Usuario</th><th>Evento</th><th>Detalle</th><th>IP</th></tr></thead><tbody>'
        + r.filas.map(a => `<tr class="${/^ALERTA|bloqueado|fallido/.test(a.evento) ? 'fila-alerta' : ''}"><td class="nowrap">${fechaHora(a.fecha)}</td>
          <td><code>${esc(a.usuario)}</code></td><td>${esc(a.evento)}</td><td class="detalle">${esc(a.detalle)}</td><td><code>${esc(a.ip)}</code></td></tr>`).join('') + '</tbody>';
    }
  }

  /* ---------- Respaldos, llave y exportación ---------- */
  function pintarRespaldos(r) {
    const res = r.respaldo;
    const sinCripto = !(window.crypto && window.crypto.subtle);
    $('#admin-respaldos').innerHTML = `
      <div class="respaldo-bloque">
        <div class="respaldo-fila"><div><strong>Planilla completa (.xlsx)</strong><span>Todas las fichas, el historial, los accesos y los usuarios. Pide tu código de doble factor.</span></div>
          <button type="button" class="btn btn-primario" id="btn-exportar">${icono('download')}<span>Exportar</span></button></div>
      </div>
      <div class="respaldo-bloque">
        <div class="respaldo-fila"><div><strong>Llave de los respaldos</strong>
          <span>${res.llave ? `Configurada · huella <code>${esc(res.llave)}</code>` : 'Todavía no creaste tu llave: sin ella no se hacen respaldos.'}</span></div>
          <button type="button" class="btn ${res.llave ? 'btn-secundario' : 'btn-primario'}" id="btn-llave">${icono('key')}<span>${res.llave ? 'Cambiar llave' : 'Crear mi llave'}</span></button></div>
        <div class="respaldo-fila"><div><strong>Abrir un respaldo</strong><span>Se descifra en esta computadora con tu llave privada; no se envía a ningún lado.</span></div>
          <button type="button" class="btn btn-secundario" id="btn-abrir-respaldo">${icono('unlock')}<span>Abrir</span></button></div>
        ${sinCripto ? '<p class="mf-ayuda aviso-texto">Para crear la llave o abrir respaldos, la página tiene que abrirse con conexión segura (https).</p>' : ''}
      </div>
      <div class="respaldo-bloque">
        <div class="respaldo-fila"><div><strong>Respaldos guardados</strong><span>Carpeta del servidor: <code>${esc(res.carpeta)}</code></span></div>
          <button type="button" class="btn btn-secundario" id="btn-respaldar" ${res.llave ? '' : 'disabled'}>${icono('save')}<span>Respaldar ahora</span></button></div>
        <ul class="lista-respaldos">${res.archivos.length ? res.archivos.slice(0, 12).map(a => `<li><span>${icono(a.nombre.includes('planilla') ? 'file' : 'database')}
          ${esc(a.nombre)}</span><span class="tam">${fmtNum(Math.round(a.bytes / 1024))} KB</span>
          <button type="button" class="btn-icono chico" data-respaldo="${esc(a.nombre)}" title="Descargar (cifrado)" aria-label="Descargar ${esc(a.nombre)}">${icono('download')}</button></li>`).join('')
          : '<li class="vacio">Todavía no hay respaldos.</li>'}</ul>
      </div>`;
    $('#btn-exportar').addEventListener('click', exportarPlanilla);
    $('#btn-llave').addEventListener('click', crearLlave);
    $('#btn-abrir-respaldo').addEventListener('click', abrirRespaldo);
    $('#btn-respaldar').addEventListener('click', async () => {
      try { await api('adminRespaldar'); toast('Respaldo cifrado creado.', 'exito'); cargarAdmin(); } catch (err) { toast(esc(err.message), 'error'); }
    });
    $$('[data-respaldo]').forEach(b => b.addEventListener('click', async () => {
      try { const r2 = await api('adminRespaldoDescargar', { nombre: b.dataset.respaldo }); descargar(r2.archivo, r2.nombre); } catch (err) { toast(esc(err.message), 'error'); }
    }));
  }

  const campoCodigo = '<label class="mf-campo"><span>Código de tu aplicación de autenticación</span><input name="codigo" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000" class="codigo-2fa"></label>';

  async function exportarPlanilla() {
    const r = await formulario({
      titulo: 'Exportar planilla completa', icono: 'download', aceptar: 'Exportar',
      html: `<p class="mf-texto">La planilla tiene <strong>todos los datos personales</strong>. Guardala en un lugar seguro y no la envíes por mail.</p>${campoCodigo}`,
      alEnviar: f => api('adminExportar', { codigo: f.codigo }),
    });
    if (r && r.archivo) { descargar(r.archivo, r.nombre); toast('Planilla descargada.', 'exito'); }
  }

  /* Cifrado en el navegador (WebCrypto): la llave privada nunca sale de esta computadora. */
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const desdeB64 = t => Uint8Array.from(atob(t), c => c.charCodeAt(0));
  async function huellaLlave(spki) {
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('rcd:' + spki));
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  }
  async function claveDeFrase(frase, sal, iter) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(frase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: sal, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function crearLlave() {
    if (!(window.crypto && crypto.subtle)) return toast('Esta función necesita conexión segura (https).', 'error');
    const cambio = !!(admin.resumen && admin.resumen.respaldo.llave);
    const r = await formulario({
      titulo: cambio ? 'Cambiar la llave de los respaldos' : 'Crear mi llave de respaldos', icono: 'key', aceptar: 'Crear llave y descargarla',
      html: `<p class="mf-texto">Se crea un par de llaves en esta computadora:</p>
        <ul class="mf-lista"><li>La <b>llave pública</b> va al servidor: con ella se cifran los respaldos.</li>
        <li>La <b>llave privada</b> se descarga como archivo y queda protegida con una frase secreta. Es la única forma de abrir los respaldos.</li></ul>
        <p class="mf-ayuda aviso-texto">Guardá el archivo en un pendrive (no en el servidor) y una copia en sobre cerrado.
        Si perdés el archivo o la frase, los respaldos no se pueden abrir.</p>
        ${cambio ? '<p class="mf-ayuda">Los respaldos anteriores siguen abriéndose con la llave anterior.</p>' : ''}
        <label class="mf-campo"><span>Frase secreta (mínimo 12 caracteres)</span><input type="password" name="frase" autocomplete="new-password"></label>
        <label class="mf-campo"><span>Repetila</span><input type="password" name="repetir" autocomplete="new-password"></label>
        ${campoCodigo}`,
      alEnviar: async f => {
        if (f.frase.length < 12) throw new Error('La frase secreta debe tener al menos 12 caracteres.');
        if (f.frase !== f.repetir) throw new Error('Las dos frases no coinciden.');
        if (!/^\d{6}$/.test(f.codigo)) throw new Error('Escribí el código de 6 números de tu aplicación.');
        const par = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
        const spki = b64(await crypto.subtle.exportKey('spki', par.publicKey));
        const pkcs8 = await crypto.subtle.exportKey('pkcs8', par.privateKey);
        const sal = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const iter = 600000;
        const cifrada = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await claveDeFrase(f.frase, sal, iter), pkcs8);
        const huella = await huellaLlave(spki);
        const archivo = {
          tipo: 'llave-privada-red-central-de-datos', version: 1, huella, creada: new Date().toISOString(),
          kdf: { algoritmo: 'PBKDF2-SHA256', iteraciones: iter, sal: b64(sal) }, iv: b64(iv), llave: b64(cifrada),
        };
        // Primero se descarga la llave privada; recién después se envía la pública al servidor.
        descargar(new Blob([JSON.stringify(archivo, null, 2)], { type: 'application/json' }), `llave-privada-red-central-${huella}.json`);
        const res = await api('adminLlave', { spki, codigo: f.codigo });
        almacen.set(claveHuellaLlave(), res.huella, 'local');
        return res;
      },
    });
    if (!r) return;
    await formulario({
      titulo: 'Llave creada', icono: 'check-circle', cancelar: 'Entendido',
      html: `<p class="mf-texto">Se descargó <code>llave-privada-red-central-${esc(r.huella)}.json</code>.</p>
        <ul class="mf-lista"><li>Copialo a un <b>pendrive</b> y borralo de esta computadora.</li>
        <li>Guardá una <b>segunda copia</b> (con la frase anotada aparte) en sobre cerrado, en un lugar seguro del municipio.</li>
        <li>${r.respaldo && r.respaldo.ok ? 'Ya se hizo el primer respaldo cifrado.' : 'El primer respaldo se hará esta noche.'}</li></ul>`,
    });
    cargarAdmin();
  }

  async function abrirRespaldo() {
    if (!(window.crypto && crypto.subtle)) return toast('Esta función necesita conexión segura (https).', 'error');
    await formulario({
      titulo: 'Abrir un respaldo', icono: 'unlock', aceptar: 'Descifrar y descargar',
      html: `<p class="mf-texto">Todo ocurre en esta computadora: el respaldo y tu llave no se envían a ningún lado.</p>
        <label class="mf-campo"><span>Archivo de respaldo (.rcd)</span><input type="file" name="respaldo" accept=".rcd"></label>
        <label class="mf-campo"><span>Tu llave privada (.json)</span><input type="file" name="llave" accept=".json,application/json"></label>
        <label class="mf-campo"><span>Frase secreta</span><input type="password" name="frase" autocomplete="off"></label>`,
      alEnviar: async f => {
        if (!f.respaldo || !f.respaldo.size || !f.llave || !f.llave.size) throw new Error('Elegí el respaldo y el archivo de tu llave.');
        let llave;
        try { llave = JSON.parse(await f.llave.text()); } catch (_) { throw new Error('El archivo de la llave no es válido.'); }
        if (llave.tipo !== 'llave-privada-red-central-de-datos') throw new Error('Ese archivo no es una llave de la Red Central de Datos.');
        let pkcs8;
        try {
          pkcs8 = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: desdeB64(llave.iv) },
            await claveDeFrase(f.frase, desdeB64(llave.kdf.sal), llave.kdf.iteraciones), desdeB64(llave.llave));
        } catch (_) { throw new Error('La frase secreta no es correcta.'); }
        const privada = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
        const buf = new Uint8Array(await f.respaldo.arrayBuffer());
        if (new TextDecoder().decode(buf.slice(0, 4)) !== 'RCD1') throw new Error('Ese archivo no es un respaldo de la Red Central de Datos.');
        const dv = new DataView(buf.buffer);
        let o = 4;
        const ln = dv.getUint16(o); o += 2;
        const nombre = new TextDecoder().decode(buf.slice(o, o + ln)); o += ln;
        const lk = dv.getUint16(o); o += 2;
        let aes;
        try { aes = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privada, buf.slice(o, o + lk)); } catch (_) {
          throw new Error('Este respaldo se cifró con otra llave.');
        }
        o += lk;
        const iv = buf.slice(o, o + 12); o += 12;
        const claveAes = await crypto.subtle.importKey('raw', aes, 'AES-GCM', false, ['decrypt']);
        let plano;
        try { plano = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, claveAes, buf.slice(o)); } catch (_) { throw new Error('El respaldo está dañado o fue alterado.'); }
        descargar(new Blob([plano]), nombre);
        return true;
      },
    }) && toast('Respaldo descifrado y descargado.', 'exito');
  }

  function prepararAdmin() {
    $('#btn-admin-actualizar').addEventListener('click', cargarAdmin);
    $('#btn-usuario-nuevo').addEventListener('click', nuevoUsuario);
    $('#btn-barrios-guardar').addEventListener('click', guardarBarriosAdmin);
    $('#admin-barrios').addEventListener('input', contarBarrios);
    $$('[data-actividad]').forEach(b => b.addEventListener('click', () => {
      admin.tipoActividad = b.dataset.actividad;
      $$('[data-actividad]').forEach(x => { x.classList.toggle('activo', x === b); x.setAttribute('aria-checked', x === b); });
      cargarActividad().catch(err => toast(esc(err.message), 'error'));
    }));
    let t;
    $('#actividad-usuario').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => cargarActividad().catch(() => {}), 400); });
  }

  /* ============================ NAVEGACIÓN / SESIÓN ============================ */
  function irA(vista) {
    $$('.pestana').forEach(p => {
      const act = p.dataset.vista === vista;
      p.classList.toggle('activa', act);
      p.setAttribute('aria-selected', act);
    });
    $('#panel-carga').hidden = vista !== 'carga';
    $('#panel-estadisticas').hidden = vista !== 'estadisticas';
    $('#panel-admin').hidden = vista !== 'admin';
    if (vista === 'estadisticas') cargarEstadisticas();
    if (vista === 'admin') cargarAdmin();
  }

  function aplicarConfig(config) {
    const b = config && Array.isArray(config.barrios) && config.barrios.length ? config.barrios : BARRIOS_DEMO;
    estado.barrios = b.slice().sort((x, y) => x.localeCompare(y, 'es'));
  }

  function mostrarApp(conservarFormulario) {
    const u = estado.sesion.usuario;
    $('#vista-login').hidden = true;
    $('#vista-app').hidden = false;
    $('#usuario-nombre').textContent = u.nombre;
    $('#usuario-detalle').textContent = `${u.secretaria} · ${u.perfil}`;
    $('#usuario-avatar').textContent = u.nombre.split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
    $('#lateral-secretaria').textContent = u.secretaria;
    $('#pestanas').hidden = !veNumeros();
    $('#pestana-admin').hidden = !esAdmin();
    $('#bloque-contador').hidden = !veNumeros();
    $('#chip-demo').hidden = !MODO_DEMO;
    estado.ultima = almacen.get(claveUltima(), null);
    estado.cargasSesion = almacen.get('gr_contador', 0);
    if (!conservarFormulario) { cerrarFormulario(); limpiarBusqueda(); }
    pintarUltima();
    irA('carga');
    if (!conservarFormulario) setTimeout(() => $('#buscar-valor').focus(), 50);
  }

  function mostrarLogin() {
    tokenPendiente = null;
    ['#paso-clave', '#paso-config2fa', '#paso-codigo', '#volver-login'].forEach(x => { $(x).hidden = true; });
    $('#form-login').hidden = false;
    $('.login-sub').hidden = false;
    $('#vista-app').hidden = true;
    $('#vista-login').hidden = false;
    $('#aviso-demo').hidden = !MODO_DEMO;
    setTimeout(() => $('#login-usuario').focus(), 50);
  }

  let usuarioAnterior = null;
  function sesionVencida() {
    usuarioAnterior = estado.sesion && estado.sesion.usuario.usuario;
    estado.sesion = null;
    almacen.del('gr_sesion');
    toast('Tu sesión venció. Ingresá de nuevo: los datos que estabas cargando se conservan.', 'aviso');
    mostrarLogin();
  }

  /* ---------- Ingreso en pasos: contraseña → (contraseña nueva) → (doble factor) ---------- */
  let tokenPendiente = null;

  function mostrarPaso(id, r) {
    ['#form-login', '#paso-clave', '#paso-config2fa', '#paso-codigo'].forEach(x => { $(x).hidden = x !== id; });
    $('#volver-login').hidden = id === '#form-login';
    $('.login-sub').hidden = id !== '#form-login';
    $$('.login-error', $(id)).forEach(e => { e.hidden = true; });
    if (id === '#paso-config2fa') $('#secreto-2fa').textContent = (r.secreto || '').replace(/(.{4})/g, '$1 ').trim();
    setTimeout(() => { const i = $('input', $(id)); if (i) { if (id !== '#form-login') i.value = ''; i.focus(); } }, 50);
  }

  function volverAlLogin() {
    tokenPendiente = null;
    mostrarPaso('#form-login', {});
    $('#login-clave').value = '';
  }

  /* Procesa la respuesta de cada paso: o pide el siguiente, o entra a la aplicación. */
  function continuarIngreso(r) {
    if (r.token) tokenPendiente = r.token;
    const pasos = { cambiarClave: '#paso-clave', configurar2fa: '#paso-config2fa', codigo: '#paso-codigo' };
    if (r.paso) return mostrarPaso(pasos[r.paso], r);
    estado.sesion = { token: tokenPendiente, usuario: r.usuario };
    tokenPendiente = null;
    almacen.set('gr_sesion', estado.sesion);
    aplicarConfig(r.config);
    $('#login-clave').value = '';
    mostrarPaso('#form-login', {});
    const conservar = !!usuarioAnterior && usuarioAnterior === r.usuario.usuario;
    usuarioAnterior = null;
    mostrarApp(conservar);
  }

  async function enviarPaso(form, fn) {
    const btn = $('button[type="submit"]', form);
    const err = $('.login-error', form);
    const texto = btn.innerHTML;
    err.hidden = true;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span><span>Verificando…</span>';
    try {
      continuarIngreso(await fn());
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      Sonido.error();
      if (ex.sesionVencida) setTimeout(volverAlLogin, 1800);
    } finally {
      btn.disabled = false;
      btn.innerHTML = texto;
    }
  }

  function prepararPasosIngreso() {
    $('#form-login').addEventListener('submit', e => {
      e.preventDefault();
      const usuario = $('#login-usuario').value.trim();
      const clave = $('#login-clave').value;
      if (!usuario || !clave) {
        const err = $('#login-error');
        err.textContent = 'Ingresá usuario y contraseña.';
        err.hidden = false;
        Sonido.error();
        return;
      }
      enviarPaso(e.target, () => api('login', { usuario, clave }));
    });
    $('#paso-clave').addEventListener('submit', e => {
      e.preventDefault();
      const nueva = $('#clave-nueva').value, repetir = $('#clave-repetir').value;
      const err = $('.login-error', e.target);
      const problema = problemaClave(nueva) || (nueva !== repetir ? 'Las dos contraseñas no coinciden.' : null);
      if (problema) { err.textContent = problema; err.hidden = false; Sonido.error(); return; }
      enviarPaso(e.target, () => api('cambiarClave', { token: tokenPendiente, nueva }));
    });
    $('#paso-config2fa').addEventListener('submit', e => {
      e.preventDefault();
      enviarPaso(e.target, () => api('configurar2fa', { token: tokenPendiente, codigo: $('.codigo-2fa', e.target).value }));
    });
    $('#paso-codigo').addEventListener('submit', e => {
      e.preventDefault();
      enviarPaso(e.target, () => api('codigo2fa', { token: tokenPendiente, codigo: $('.codigo-2fa', e.target).value }));
    });
    $$('.codigo-2fa').forEach(i => i.addEventListener('input', () => {
      i.value = i.value.replace(/\D/g, '').slice(0, 6);
      if (i.value.length === 6) i.form.requestSubmit();
    }));
    $('#copiar-secreto').addEventListener('click', () => {
      const t = $('#secreto-2fa').textContent.replace(/\s/g, '');
      if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => toast('Clave copiada.', 'exito'), () => {});
    });
    $('#volver-login').addEventListener('click', volverAlLogin);
  }

  /** Política de contraseñas (la misma que controla el servidor). */
  function problemaClave(c) {
    if (c.length < 10) return 'La contraseña debe tener al menos 10 caracteres.';
    if (!/[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(c) || !/\d/.test(c)) return 'La contraseña debe combinar letras y números.';
    return null;
  }

  async function cambiarMiClave() {
    await formulario({
      titulo: 'Cambiar mi contraseña', icono: 'key', aceptar: 'Guardar contraseña',
      html: `<label class="mf-campo"><span>Contraseña actual</span><input type="password" name="actual" autocomplete="current-password"></label>
        <label class="mf-campo"><span>Contraseña nueva</span><input type="password" name="nueva" autocomplete="new-password"></label>
        <label class="mf-campo"><span>Repetila</span><input type="password" name="repetir" autocomplete="new-password"></label>
        <p class="mf-ayuda">Al menos 10 caracteres, combinando letras y números.</p>`,
      alEnviar: async f => {
        const problema = problemaClave(f.nueva) || (f.nueva !== f.repetir ? 'Las dos contraseñas no coinciden.' : null);
        if (problema) throw new Error(problema);
        await api('cambiarClave', { actual: f.actual, nueva: f.nueva });
        return true;
      },
    }) && toast('Contraseña actualizada.', 'exito');
  }

  /*
   * Ventana con formulario. html: campos con atributo name. alEnviar(valores, form) puede lanzar un error
   * (se muestra en la ventana) o devolver un resultado (cierra la ventana y lo devuelve).
   */
  function formulario({ titulo, icono: ic = 'info', html, aceptar = 'Aceptar', cancelar = 'Cancelar', alEnviar, alAbrir, peligro }) {
    const d = $('#modal-form');
    const form = $('#mf-form');
    $('#mf-titulo').textContent = titulo;
    $('#mf-icono').innerHTML = icono(ic);
    $('#mf-cuerpo').innerHTML = html;
    $('#mf-error').hidden = true;
    const bAc = $('#mf-aceptar');
    bAc.className = 'btn ' + (peligro ? 'btn-peligro' : 'btn-primario');
    bAc.innerHTML = `<span>${esc(aceptar)}</span>`;
    bAc.hidden = !alEnviar;
    $('#mf-cancelar').innerHTML = `<span>${esc(cancelar)}</span>`;
    if (d.open) d.close();
    return new Promise(resolve => {
      const fin = r => {
        form.onsubmit = null;
        $('#mf-cancelar').onclick = $('#mf-cerrar').onclick = null;
        d.removeEventListener('cancel', alCancelar);
        d.close();
        resolve(r);
      };
      const alCancelar = e => { e.preventDefault(); fin(null); };
      d.addEventListener('cancel', alCancelar);
      $('#mf-cancelar').onclick = $('#mf-cerrar').onclick = () => fin(null);
      form.onsubmit = async e => {
        e.preventDefault();
        if (!alEnviar) return fin(null);
        const valores = Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, typeof v === 'string' ? v : v]));
        $('#mf-error').hidden = true;
        const texto = bAc.innerHTML;
        bAc.disabled = true;
        bAc.innerHTML = '<span class="spinner"></span><span>Procesando…</span>';
        try {
          const r = await alEnviar(valores, form);
          fin(r === undefined ? true : r);
        } catch (err) {
          if (err.sesionVencida) { fin(null); return sesionVencida(); }
          $('#mf-error').textContent = err.message;
          $('#mf-error').hidden = false;
          Sonido.error();
        } finally {
          bAc.disabled = false;
          bAc.innerHTML = texto;
        }
      };
      d.showModal();
      if (alAbrir) alAbrir(form);
      const primero = $('input:not([type=hidden]):not([readonly]), select, textarea', form);
      if (primero) primero.focus();
    });
  }

  async function salir() {
    if (formularioConDatos() || estado.modo !== 'nueva') {
      const ok = await modal({
        titulo: '¿Cerrar sesión?',
        html: '<p>Hay datos en el formulario que todavía no guardaste. Si salís, se pierden.</p>',
        si: 'Salir igual', no: 'Cancelar', tipo: 'peligro', iconoId: 'logout',
      });
      if (!ok) return;
    }
    api('logout').catch(() => {});
    almacen.del('gr_sesion');
    almacen.del('gr_contador');
    estado.sesion = null;
    estado.ultima = null;
    cerrarFormulario();
    limpiarBusqueda();
    mostrarLogin();
  }

  function pintarSonido() {
    const b = $('#btn-sonido');
    b.innerHTML = icono(Sonido.activo ? 'volume' : 'mute');
    const t = Sonido.activo ? 'Silenciar sonidos' : 'Activar sonidos';
    b.title = t;
    b.setAttribute('aria-label', t);
  }

  /* ============================ INICIO ============================ */
  async function iniciar() {
    document.title = `${CFG.NOMBRE_APP || 'Red Central de Datos'} · General Rodríguez`;
    construirFormulario();
    prepararBuscador();
    cerrarFormulario();

    prepararPasosIngreso();
    prepararAdmin();
    $('#ver-clave').addEventListener('click', () => {
      const i = $('#login-clave');
      const ver = i.type === 'password';
      i.type = ver ? 'text' : 'password';
      $('#ver-clave').innerHTML = icono(ver ? 'eye-off' : 'eye');
      $('#ver-clave').setAttribute('aria-label', ver ? 'Ocultar contraseña' : 'Mostrar contraseña');
    });
    $('#form-carga').addEventListener('submit', alGuardar);
    $('#btn-limpiar').addEventListener('click', limpiar);
    $('#btn-cancelar-edicion').addEventListener('click', cancelar);
    $('#btn-editar').addEventListener('click', editarUltima);
    $('#btn-salir').addEventListener('click', salir);
    $('#btn-mi-clave').addEventListener('click', cambiarMiClave);
    $('#btn-actualizar').addEventListener('click', () => (estado.filtro.preset ? elegirPreset(estado.filtro.preset) : cargarEstadisticas()));
    $$('.preset').forEach(b => b.addEventListener('click', () => elegirPreset(b.dataset.preset)));
    ['#filtro-desde', '#filtro-hasta'].forEach(id => $(id).addEventListener('change', alCambiarFechas));
    $('#btn-sonido').addEventListener('click', () => { Sonido.activo = !Sonido.activo; pintarSonido(); });
    $$('.pestana').forEach(p => p.addEventListener('click', () => irA(p.dataset.vista)));
    window.addEventListener('beforeunload', e => {
      if (estado.sesion && (formularioConDatos() || estado.modo !== 'nueva')) { e.preventDefault(); e.returnValue = ''; }
    });
    pintarSonido();

    if (!estado.sesion) return mostrarLogin();
    try {
      const r = await api('sesion');
      estado.sesion.usuario = r.usuario;
      aplicarConfig(r.config);
      mostrarApp();
    } catch (err) {
      estado.sesion = null;
      almacen.del('gr_sesion');
      mostrarLogin();
    }
  }

  iniciar();
})();
