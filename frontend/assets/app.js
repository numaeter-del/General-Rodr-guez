/* =====================================================================
   Base Integral de Contribuyentes — General Rodríguez
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
          // text/plain evita el "preflight" CORS, que Apps Script no admite.
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(Object.assign({ accion, token: estado.sesion && estado.sesion.token }, datos)),
          redirect: 'follow',
        });
      } catch (e) {
        throw new Error('No se pudo conectar con el servidor. Revisá tu conexión a internet e intentá de nuevo.');
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

  function crearApiDemo() {
    const USUARIOS = {
      carga: { usuario: 'carga', nombre: 'Operador de Carga', perfil: 'Carga', secretaria: 'Secretaría de Hacienda' },
      analisis: { usuario: 'analisis', nombre: 'Analista de Datos', perfil: 'Análisis', secretaria: 'Secretaría de Gobierno' },
    };
    const SECRETARIAS = ['Secretaría de Hacienda', 'Secretaría de Gobierno', 'Secretaría de Salud', 'Secretaría de Desarrollo Social', 'Secretaría de Obras Públicas'];
    const K = 'gr_demo_registros_v3';
    const pausa = ms => new Promise(r => setTimeout(r, ms));
    const refNueva = () => Array.from({ length: 16 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
    const vacio = () => Object.fromEntries(CAMPOS.map(c => [c.id, '']));

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
          id: 262, ref: refNueva(), fecha: new Date(Date.now() - 1 * 86400000).toISOString(), secretaria: 'Secretaría de Hacienda', usuario: 'ejemplo',
          apellido: 'Fernández', nombre: 'Carlos', dni: '25333444', celular: '2374556677',
          calle: '25 de Mayo', numero: '480', barrio: 'Agua de Oro', vinculo: 'Inquilino', partidaComercio: '300400',
        }));
        almacen.set(K, regs, 'local');
      }
      return regs;
    }
    const sesion = () => {
      const u = estado.sesion && USUARIOS[estado.sesion.usuario.usuario];
      if (!u) { const e = new Error('Tu sesión venció. Volvé a ingresar.'); e.sesionVencida = true; throw e; }
      return u;
    };
    const ficha = (r, u) => {
      const f = { ref: r.ref, fecha: r.fecha, secretaria: r.secretaria, datos: Object.fromEntries(CAMPOS.map(c => [c.id, r[c.id] || ''])) };
      if (u.perfil === 'Análisis') f.id = r.id;
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
    const config = () => ({ barrios: BARRIOS_DEMO });

    return async function llamar(accion, p = {}) {
      await pausa(accion === 'estadisticas' ? 500 : 350);
      switch (accion) {
        case 'login': {
          const u = USUARIOS[String(p.usuario || '').trim().toLowerCase()];
          if (!u || p.clave !== 'demo1234') throw new Error('Usuario o contraseña incorrectos.');
          return { ok: true, token: 'demo-' + Date.now(), usuario: u, config: config() };
        }
        case 'sesion': return { ok: true, usuario: sesion(), config: config() };
        case 'logout': return { ok: true };
        case 'buscar': {
          const u = sesion();
          const b = BUSQUEDAS[p.tipo];
          if (!b || !b.ok(String(p.valor || ''))) throw new Error('Dato de búsqueda inválido.');
          const resultados = registros().filter(r => r[p.tipo] === p.valor && r.ref !== p.excluir)
            .sort((a, b) => (a.fecha < b.fecha ? 1 : -1)).slice(0, 10).map(r => ficha(r, u));
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
          if (u.perfil === 'Análisis') r.id = id;
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
          const permitidos = { telefono: ['celular', 'celular2'], domicilio: ['calle', 'numero', 'piso', 'barrio', 'barrioOtro'], correccion: CAMPOS.map(c => c.id) }[p.accion];
          if (!permitidos) throw new Error('Acción inválida.');
          const regs = registros();
          const r = regs.find(x => x.ref === p.ref);
          if (!r) throw new Error('No se encontró la ficha.');
          const cambios = p.cambios || {};
          const tocados = permitidos.filter(k => k in cambios && String(cambios[k]).trim() !== (r[k] || ''));
          if (!tocados.length) throw new Error('No hay cambios para guardar.');
          const nuevo = limpiarDependientes(Object.assign(ficha(r, u).datos, ...tocados.map(k => ({ [k]: String(cambios[k]).trim() }))));
          validar(nuevo, tocados.flatMap(k => [k].concat(DEPENDIENTES[k] || [])));
          if (tocados.includes('dni') || tocados.includes('cuit')) verificarUnico(regs, nuevo, u, r.ref);
          Object.assign(r, nuevo, { editado: new Date().toISOString() });
          almacen.set(K, regs, 'local');
          return { ok: true, datos: nuevo };
        }
        case 'estadisticas': {
          if (sesion().perfil !== 'Análisis') throw new Error('Tu perfil no tiene acceso a estadísticas.');
          const regs = registros().map(r => Object.assign({}, r, { fecha: new Date(r.fecha), clave: claveFecha(r.fecha), celular: r.celular || r.celular2 }));
          return Object.assign({ ok: true }, calcularEstadisticas(regs, p.desde, p.hasta, claveFecha(Date.now())));
        }
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
    ultima: null,          // { ref, id?, fecha, datos }
    duplicados: { dni: null, cuit: null },
    busqueda: { tipo: 'dni', valor: '', resultados: null },
    barrios: BARRIOS_DEMO,
    guardando: false,
    cargasSesion: 0,
  };
  const api = MODO_DEMO ? crearApiDemo() : crearApiRemota();
  const esAnalisis = () => !!(estado.sesion && estado.sesion.usuario.perfil === 'Análisis');

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

  function habilitarCorreccion(id) {
    [id].concat(DEPENDIENTES[id] || []).forEach(k => estado.habilitados.add(k));
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
    cargarEnFormulario(datos);
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
      $$('.buscar-tipo').forEach(x => {
        const act = x.dataset.tipo === tipoActual();
        x.classList.toggle('activo', act);
        x.setAttribute('aria-checked', act);
      });
      input.placeholder = `Ej: ${b.ejemplo}`;
      input.setAttribute('aria-label', 'Buscar por ' + b.etiqueta);
      $('#buscar-formato').innerHTML = `Solo números, sin puntos ni guiones · Ej: <code>${b.ejemplo}</code>`;
    };
    $$('.buscar-tipo').forEach(x => x.addEventListener('click', () => {
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
      estado.habilitados.forEach(k => { cambios[k] = datos[k]; });
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
        const r = await api('actualizar', { ref, accion: estado.accion, cambios });
        if (estado.ultima && estado.ultima.ref === ref) { estado.ultima.datos = r.datos; guardarUltima(); }
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
    $('#ultima-num').textContent = esAnalisis() && u.id ? '#' + u.id : '';
    $('#ultima-num').hidden = !(esAnalisis() && u.id);
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

  /* ============================ NAVEGACIÓN / SESIÓN ============================ */
  function irA(vista) {
    $$('.pestana').forEach(p => {
      const act = p.dataset.vista === vista;
      p.classList.toggle('activa', act);
      p.setAttribute('aria-selected', act);
    });
    $('#panel-carga').hidden = vista !== 'carga';
    $('#panel-estadisticas').hidden = vista !== 'estadisticas';
    if (vista === 'estadisticas') cargarEstadisticas();
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
    $('#pestanas').hidden = !esAnalisis();
    $('#bloque-contador').hidden = !esAnalisis();
    $('#chip-demo').hidden = !MODO_DEMO;
    estado.ultima = almacen.get(claveUltima(), null);
    estado.cargasSesion = almacen.get('gr_contador', 0);
    if (!conservarFormulario) { cerrarFormulario(); limpiarBusqueda(); }
    pintarUltima();
    irA('carga');
    if (!conservarFormulario) setTimeout(() => $('#buscar-valor').focus(), 50);
  }

  function mostrarLogin() {
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

  async function alIngresar(e) {
    e.preventDefault();
    const usuario = $('#login-usuario').value.trim();
    const clave = $('#login-clave').value;
    const err = $('#login-error');
    err.hidden = true;
    if (!usuario || !clave) {
      err.textContent = 'Ingresá usuario y contraseña.';
      err.hidden = false;
      Sonido.error();
      return;
    }
    const btn = $('#btn-ingresar');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span><span>Ingresando…</span>';
    try {
      const r = await api('login', { usuario, clave });
      estado.sesion = { token: r.token, usuario: r.usuario };
      almacen.set('gr_sesion', estado.sesion);
      aplicarConfig(r.config);
      $('#login-clave').value = '';
      const conservar = !!usuarioAnterior && usuarioAnterior === r.usuario.usuario;
      usuarioAnterior = null;
      mostrarApp(conservar);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      Sonido.error();
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<span>Ingresar</span>';
    }
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
    document.title = `${CFG.NOMBRE_APP || 'Base Integral de Contribuyentes'} · General Rodríguez`;
    construirFormulario();
    prepararBuscador();
    cerrarFormulario();

    $('#form-login').addEventListener('submit', alIngresar);
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
