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
      filtro(v) {
        if (/[\s\-()+.]/.test(v)) return 'Sin espacios, guiones, paréntesis ni signos: solo los 10 números (ej: 1122334455).';
        if (/\D/.test(v)) return 'Solo números.';
        if (v[0] === '0') return 'Sin el 0 inicial: empezá por el código de área (ej: 11).';
        if (!/^[123]/.test(v)) return 'El código de área empieza con 11, 2 o 3.';
        if (/^1[^1]/.test(v)) return 'Código de área inválido. Para CABA / GBA es 11 (sin 15).';
        if (v.length > 10) return 'Son exactamente 10 dígitos (área + número, sin 0 ni 15).';
        return null;
      },
      validar: v => (/^(11\d{8}|[23]\d{9})$/.test(v) ? null : `Son 10 dígitos en total (faltan ${Math.max(0, 10 - v.length)}).`),
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
      id: 'barrio', grupo: 'domicilio', etiqueta: 'Barrio', icono: 'map',
      formato: 'Nombre del barrio', ejemplo: 'Vista Linda', capitalizar: true,
      filtro(v) {
        if (new RegExp(`[^0-9${LETRAS}.'°º ]`).test(v)) return 'Solo letras, números, espacios y puntos (sin comas, guiones ni símbolos).';
        if (/^[ .'°º]/.test(v)) return 'Empezá con el nombre del barrio.';
        if (/ {2}/.test(v)) return 'Sin espacios dobles.';
        if (v.length > 60) return 'Máximo 60 caracteres.';
        return null;
      },
      validar: v => (v.replace(new RegExp(`[^0-9${LETRAS}]`, 'g'), '').length < 2 ? 'Nombre de barrio demasiado corto.' : null),
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
  function erroresDeFormato(datos) {
    return CAMPOS.filter(c => {
      const v = datos[c.id];
      if (!v) return false;
      if (c.tipo === 'select') return !c.opciones.includes(v);
      return !!(c.filtro(v === 'S/N' ? '' : v) || (c.validar && c.validar(v)));
    });
  }

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
    const K = 'gr_demo_registros_v2';
    const pausa = ms => new Promise(r => setTimeout(r, ms));

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
          regs.push({
            id: i + 1,
            fecha: new Date(Date.now() - Math.floor(azar() * azar() * (i < 180 ? 30 : 200) * 86400000)).toISOString(),
            secretaria: SECRETARIAS[k], usuario: 'ejemplo',
            celular: azar() < 0.82 ? 'x' : '', mail: azar() < 0.58 ? 'x' : '',
            vinculo: VINCULOS[Math.floor(azar() * azar() * 4)],
          });
        }
        almacen.set(K, regs, 'local');
      }
      return regs;
    }
    const sesion = () => {
      const u = estado.sesion && USUARIOS[estado.sesion.usuario.usuario];
      if (!u) { const e = new Error('Tu sesión venció. Volvé a ingresar.'); e.sesionVencida = true; throw e; }
      return u;
    };
    const validar = datos => {
      const malos = erroresDeFormato(datos);
      if (malos.length) throw new Error('Formato incorrecto en: ' + malos.map(c => c.etiqueta).join(', ') + '.');
    };

    return async function llamar(accion, p = {}) {
      await pausa(accion === 'estadisticas' ? 500 : 380);
      switch (accion) {
        case 'login': {
          const u = USUARIOS[String(p.usuario || '').trim().toLowerCase()];
          if (!u || p.clave !== 'demo1234') throw new Error('Usuario o contraseña incorrectos.');
          return { ok: true, token: 'demo-' + Date.now(), usuario: u };
        }
        case 'sesion': return { ok: true, usuario: sesion() };
        case 'logout': return { ok: true };
        case 'guardar': {
          const u = sesion();
          validar(p.datos);
          const regs = registros();
          const id = regs.reduce((m, r) => Math.max(m, r.id), 0) + 1;
          const fecha = new Date().toISOString();
          regs.push(Object.assign({ id, fecha, secretaria: u.secretaria, usuario: u.usuario }, p.datos));
          almacen.set(K, regs, 'local');
          almacen.set('gr_demo_editable_' + u.usuario, id, 'local');
          return { ok: true, id, fecha };
        }
        case 'editar': {
          const u = sesion();
          if (Number(p.id) !== almacen.get('gr_demo_editable_' + u.usuario, 0, 'local')) {
            throw new Error('Ese registro ya no se puede editar: solo se puede modificar la última carga realizada.');
          }
          validar(p.datos);
          const regs = registros();
          const r = regs.find(x => x.id === Number(p.id));
          Object.assign(r, p.datos, { editado: new Date().toISOString() });
          almacen.set(K, regs, 'local');
          return { ok: true, id: r.id };
        }
        case 'buscarDni': {
          sesion();
          const iguales = registros().filter(r => r.dni === p.dni && r.id !== Number(p.excluir || 0));
          if (!iguales.length) return { ok: true, cantidad: 0 };
          const u = iguales[iguales.length - 1];
          return { ok: true, cantidad: iguales.length, ultimo: { id: u.id, secretaria: u.secretaria, fecha: u.fecha } };
        }
        case 'estadisticas': {
          if (sesion().perfil !== 'Análisis') throw new Error('Tu perfil no tiene acceso a estadísticas.');
          const regs = registros().map(r => Object.assign({}, r, { fecha: new Date(r.fecha), clave: claveFecha(r.fecha) }));
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
    editandoId: null,
    ultima: null,          // { id, fecha, datos }
    guardando: false,
    cargasSesion: 0,
  };
  const api = MODO_DEMO ? crearApiDemo() : crearApiRemota();

  /* ============================ UI: TOASTS / MODAL ============================ */
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

  /* ============================ FORMULARIO ============================ */
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
      const el = $('#f-' + c.id);
      if (c.tipo === 'select') {
        el.addEventListener('change', () => alCambiarSelect(c, el));
      } else {
        el.addEventListener('input', () => alEscribir(c, el));
        el.addEventListener('blur', () => alSalir(c, el));
        el.addEventListener('drop', e => e.preventDefault());
      }
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter' && c.tipo !== 'textarea') { e.preventDefault(); siguienteCampo(c.id); }
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
    refrescarVisibilidad();
    actualizarProgreso();
  }

  function htmlCampo(c) {
    const cab = `<div class="campo-cabecera">
        <label class="campo-label" for="f-${c.id}">${c.etiqueta}</label>
        ${c.sinNumero ? '<label class="sn" title="Sin número"><input type="checkbox" id="sn-numero"> S/N</label>' : ''}
        ${c.maximo ? `<span class="contador-car" id="cc-${c.id}">0 / ${c.maximo}</span>` : c.opcional && !GRUPOS.find(g => g.id === c.grupo).opcional ? '<span class="tag-opcional">Opcional</span>' : ''}
      </div>
      <div class="campo-formato">${icono('info')}<span>${c.formato}${c.ejemplo ? ` · Ej: <code>${esc(c.ejemplo)}</code>` : ''}</span></div>`;
    const estadoIc = `<span class="control-estado" aria-hidden="true">${icono('check', 'ic-ok')}${icono('x', 'ic-err')}</span>`;
    let control;
    if (c.tipo === 'textarea') {
      control = `<div class="control control-area">${icono(c.icono, 'control-icono')}
        <textarea id="f-${c.id}" name="${c.id}" rows="3" placeholder="${esc(c.placeholder)}" spellcheck="true"
          aria-describedby="m-${c.id}"></textarea></div>`;
    } else if (c.tipo === 'select') {
      control = `<div class="control">${icono(c.icono, 'control-icono')}
        <select id="f-${c.id}" name="${c.id}" required>
          <option value="">Seleccioná…</option>
          ${c.opciones.map(o => `<option>${esc(o)}</option>`).join('')}
        </select>${icono('chevron', 'control-flecha')}${estadoIc}</div>`;
    } else {
      control = `<div class="control">${icono(c.icono, 'control-icono')}
        <input id="f-${c.id}" name="${c.id}" type="${c.tipo === 'tel' ? 'tel' : 'text'}"
          ${c.teclado ? `inputmode="${c.teclado}"` : ''} placeholder="${esc(c.placeholder || c.ejemplo)}"
          autocomplete="off" autocapitalize="${c.capitalizar ? 'words' : 'off'}" spellcheck="false"
          aria-describedby="m-${c.id}">${estadoIc}</div>`;
    }
    return `<div class="campo" data-campo="${c.id}" ${c.visible ? 'hidden' : ''}>${cab}${control}
      <div class="campo-msg" id="m-${c.id}" role="alert">${icono('alert-circle')}<span></span></div>
      ${c.id === 'dni' ? `<div class="campo-aviso" id="a-dni" role="status">${icono('alert')}<span></span></div>` : ''}</div>`;
  }

  const nodoCampo = c => $(`.campo[data-campo="${c.id}"]`);

  function alEscribir(c, el) {
    const previo = estado.valores[c.id] || '';
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
    estado.valores[c.id] = v;
    limpiarMarcas(c);
    refrescarCampo(c);
    if (c.maximo) actualizarContador(c);
    if (c.id === 'dni') {
      marcarDuplicado(null);
      if (estado.valores.cuit) refrescarCampo(CAMPO.cuit);
    }
  }

  function actualizarContador(c) {
    const n = (estado.valores[c.id] || '').length;
    const el = $('#cc-' + c.id);
    el.textContent = `${n} / ${c.maximo}`;
    el.classList.toggle('cerca', n >= c.maximo * 0.9);
  }

  function alSalir(c, el) {
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
      verificarDni();
    }
    refrescarCampo(c);
  }

  /* ---------- Aviso de DNI ya cargado (no impide guardar) ---------- */
  let dniVerificado = '';
  async function verificarDni() {
    const dni = estado.valores.dni || '';
    if (!dni || CAMPO.dni.validar(dni) || dni === dniVerificado) return;
    dniVerificado = dni;
    try {
      const r = await api('buscarDni', { dni, excluir: estado.editandoId || 0 });
      if (estado.valores.dni !== dni) return;
      marcarDuplicado(r.cantidad ? r : null);
      if (r.cantidad) toast(esc(textoDuplicado(r)) + ' Podés guardar igual si corresponde.', 'aviso');
    } catch (err) {
      dniVerificado = '';
      if (err.sesionVencida) sesionVencida();
    }
  }
  function textoDuplicado(r) {
    const f = new Date(r.ultimo.fecha);
    const cuando = isNaN(f) ? '' : ', ' + f.toLocaleDateString('es-AR');
    return `Este DNI ya tiene ${r.cantidad === 1 ? 'una carga' : r.cantidad + ' cargas'} (última: #${r.ultimo.id}, ${r.ultimo.secretaria}${cuando}).`;
  }
  function marcarDuplicado(r) {
    nodoCampo(CAMPO.dni).classList.toggle('duplicado', !!r);
    if (r) $('#a-dni span').textContent = textoDuplicado(r);
    else if (estado.valores.dni !== dniVerificado) dniVerificado = '';
  }

  function alCambiarSelect(c, el) {
    estado.valores[c.id] = el.value;
    limpiarMarcas(c);
    refrescarVisibilidad(true);
    refrescarCampo(c);
  }

  function refrescarVisibilidad(animar) {
    CAMPOS.filter(c => c.visible).forEach(c => {
      const n = nodoCampo(c);
      const ver = c.visible();
      if (ver && n.hidden && animar) { n.classList.remove('oculto-anim'); void n.offsetWidth; n.classList.add('oculto-anim'); }
      n.hidden = !ver;
      if (!ver) {
        estado.valores[c.id] = '';
        $('#f-' + c.id).value = '';
        limpiarMarcas(c);
        refrescarCampo(c);
      }
    });
    actualizarProgreso();
  }

  const camposActivos = () => CAMPOS.filter(c => !c.visible || c.visible());
  const camposRequeridos = () => camposActivos().filter(c => !c.opcional);
  const completo = c => {
    const v = estado.valores[c.id];
    if (!v) return false;
    if (c.tipo === 'select') return true;
    return !(c.validar && c.validar(v));
  };

  function refrescarCampo(c) {
    const n = nodoCampo(c);
    n.classList.toggle('ok', completo(c) && !n.classList.contains('error'));
    actualizarProgreso();
  }

  function marcarError(c, mensaje, sonar = true) {
    const n = nodoCampo(c);
    n.classList.remove('ok', 'sacudir');
    n.classList.add('error');
    $('span', $('#m-' + c.id)).textContent = mensaje;
    $('#f-' + c.id).setAttribute('aria-invalid', 'true');
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
    $('#f-' + c.id).setAttribute('aria-invalid', 'true');
  }

  function limpiarMarcas(c) {
    const n = nodoCampo(c);
    n.classList.remove('error', 'sacudir', 'reciente');
    if (estado.valores[c.id]) n.classList.remove('faltante');
    if (!n.classList.contains('faltante')) $('#f-' + c.id).removeAttribute('aria-invalid');
  }

  function actualizarProgreso() {
    const activos = camposRequeridos();
    const hechos = activos.filter(completo).length;
    $('#progreso-valor').textContent = hechos;
    $('#progreso-total').textContent = activos.length;
    $('#progreso-relleno').style.width = (100 * hechos / activos.length) + '%';
  }

  function siguienteCampo(id) {
    const activos = camposActivos().filter(c => !$('#f-' + c.id).disabled);
    const i = activos.findIndex(c => c.id === id);
    if (i >= 0 && i < activos.length - 1) $('#f-' + activos[i + 1].id).focus();
    else $('#btn-guardar').focus();
  }

  function datosFormulario() {
    const d = {};
    CAMPOS.forEach(c => { d[c.id] = (estado.valores[c.id] || '').trim(); });
    if (d.vinculo !== 'Familiar') d.parentesco = '';
    if (d.parentesco !== 'Otro') d.parentescoOtro = '';
    return d;
  }

  function formularioConDatos() {
    return CAMPOS.some(c => (estado.valores[c.id] || '') !== '');
  }

  function cargarEnFormulario(datos) {
    estado.valores = {};
    CAMPOS.forEach(c => {
      const v = (datos && datos[c.id]) || '';
      estado.valores[c.id] = v;
      const el = $('#f-' + c.id);
      el.value = v;
      nodoCampo(c).classList.remove('error', 'faltante', 'sacudir', 'reciente', 'ok');
      el.removeAttribute('aria-invalid');
    });
    const sn = $('#sn-numero');
    sn.checked = estado.valores.numero === 'S/N';
    $('#f-numero').disabled = sn.checked;
    // Los valores ya están cargados: "parentesco" y "parentescoOtro" se muestran si corresponde.
    refrescarVisibilidad(false);
    CAMPOS.forEach(refrescarCampo);
    CAMPOS.filter(c => c.maximo).forEach(actualizarContador);
    dniVerificado = '';
    marcarDuplicado(null);
  }

  function modoEdicion(id) {
    estado.editandoId = id;
    const f = $('#form-carga');
    f.classList.toggle('editando', !!id);
    $('#banner-edicion').hidden = !id;
    $('#btn-cancelar-edicion').hidden = !id;
    $('#btn-limpiar').hidden = !!id;
    $('#form-titulo').textContent = id ? `Editar carga #${id}` : 'Nueva carga';
    $('#form-subtitulo').textContent = id
      ? 'Corregí los datos necesarios y guardá los cambios.'
      : 'Completá los datos respetando el formato indicado en cada campo.';
    $('#banner-id').textContent = id ? '#' + id : '';
    $('#btn-guardar span').textContent = id ? 'Guardar cambios' : 'Guardar';
  }

  /* ---------- Guardar ---------- */
  async function alGuardar(e) {
    e.preventDefault();
    if (estado.guardando) return;

    // Cerrar el campo activo (capitaliza, recorta y valida).
    const activo = document.activeElement;
    const cActivo = activo && activo.id && CAMPO[activo.id.replace(/^f-/, '')];
    if (cActivo && cActivo.tipo !== 'select') alSalir(cActivo, activo);

    const activos = camposActivos();
    const requeridos = camposRequeridos();

    // 1) Formatos incorrectos: no se puede guardar.
    const invalidos = activos.filter(c => c.tipo !== 'select' && estado.valores[c.id] && c.validar && c.validar(estado.valores[c.id]));
    if (invalidos.length) {
      invalidos.forEach(c => marcarError(c, c.validar(estado.valores[c.id]), false));
      Sonido.error();
      toast('Hay campos con formato incorrecto. Corregí lo marcado en rojo.', 'error');
      $('#f-' + invalidos[0].id).focus();
      return;
    }

    // 2) Formulario vacío.
    const datos = datosFormulario();
    if (!CAMPOS.some(c => c.tipo !== 'select' && c.esDato !== false && datos[c.id])) {
      Sonido.error();
      toast('El formulario está vacío. Cargá al menos un dato del contribuyente.', 'error');
      $('#f-' + CAMPOS[0].id).focus();
      return;
    }

    // 3) Campos faltantes: se pregunta si guardar igual.
    const faltan = requeridos.filter(c => !estado.valores[c.id]);
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
        $('#f-' + faltan[0].id).focus();
        return;
      }
    }

    // Si el DNI no se llegó a verificar (se guardó sin salir del campo), se avisa ahora.
    await verificarDni();
    await enviar(datos);
  }

  async function enviar(datos) {
    const btn = $('#btn-guardar');
    const htmlBtn = btn.innerHTML;
    estado.guardando = true;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span><span>Guardando…</span>';
    try {
      if (estado.editandoId) {
        const id = estado.editandoId;
        await api('editar', { id, datos });
        estado.ultima = { id, fecha: estado.ultima.fecha, datos };
        guardarUltima();
        Sonido.exito();
        toast(`Cambios de la carga <strong>#${id}</strong> guardados.`, 'exito');
        modoEdicion(null);
      } else {
        const r = await api('guardar', { datos });
        estado.ultima = { id: r.id, fecha: r.fecha, datos };
        guardarUltima();
        estado.cargasSesion++;
        almacen.set('gr_contador', estado.cargasSesion);
        Sonido.exito();
        toast(`Carga <strong>#${r.id}</strong> guardada correctamente.`, 'exito', { texto: 'Editar', fn: editarUltima });
      }
      cargarEnFormulario(null);
      pintarUltima(true);
      $('#f-' + CAMPOS[0].id).focus();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      Sonido.error();
      if (err.sesionVencida) return sesionVencida();
      toast(esc(err.message), 'error');
    } finally {
      estado.guardando = false;
      btn.disabled = false;
      btn.innerHTML = htmlBtn;
      $('#btn-guardar span').textContent = estado.editandoId ? 'Guardar cambios' : 'Guardar';
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
    $('#ultima-id').textContent = 'Carga #' + u.id;
    const f = new Date(u.fecha);
    $('#ultima-hora').textContent = isNaN(f) ? '' : f.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) + ' h';
    const d = u.datos;
    const filas = [
      ['Contribuyente', [d.apellido, d.nombre].filter(Boolean).join(', ') || '—'],
      ['DNI', d.dni || '—'],
      ['Celular', d.celular || '—'],
      ['Mail', d.mail || '—'],
      ['Domicilio', [d.calle, d.numero].filter(Boolean).join(' ') + (d.piso ? `, ${d.piso}` : '') || '—'],
      ['Barrio', d.barrio || '—'],
      ['Vínculo', d.vinculo ? d.vinculo + (d.parentesco ? ` (${d.parentesco === 'Otro' && d.parentescoOtro ? d.parentescoOtro : d.parentesco})` : '') : '—'],
    ];
    if (d.partidaInmueble) filas.push(['Partida inmueble', d.partidaInmueble]);
    if (d.partidaComercio) filas.push(['Partida comercio', d.partidaComercio]);
    if (d.comentarios) filas.push(['Comentarios', d.comentarios]);
    $('#ultima-lista').innerHTML = filas.map(([k, v]) => `<dt>${k}</dt><dd title="${esc(v)}">${esc(v)}</dd>`).join('');
    const btn = $('#btn-editar');
    btn.disabled = estado.editandoId === u.id;
    if (recien) {
      const t = $('#tarjeta-ultima');
      t.classList.remove('recien'); void t.offsetWidth; t.classList.add('recien');
    }
  }

  async function editarUltima() {
    if (!estado.ultima) return;
    if (estado.editandoId === estado.ultima.id) return;
    if (formularioConDatos()) {
      const ok = await modal({
        titulo: 'Tenés una carga en curso',
        html: '<p>Para editar la carga anterior se van a descartar los datos que estás cargando ahora.</p><p class="pregunta">¿Querés descartarlos?</p>',
        si: 'Descartar y editar', no: 'Volver', tipo: 'peligro',
      });
      if (!ok) return;
    }
    modoEdicion(estado.ultima.id);
    cargarEnFormulario(estado.ultima.datos);
    pintarUltima();
    irA('carga');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    $('#f-' + CAMPOS[0].id).focus({ preventScroll: true });
  }

  function cancelarEdicion() {
    modoEdicion(null);
    cargarEnFormulario(null);
    pintarUltima();
  }

  async function limpiar() {
    if (!formularioConDatos()) return;
    const ok = await modal({
      titulo: '¿Limpiar el formulario?',
      html: '<p>Se borrarán todos los datos cargados en pantalla.</p>',
      si: 'Limpiar', no: 'Cancelar', tipo: 'peligro', iconoId: 'reset',
    });
    if (ok) { cargarEnFormulario(null); $('#f-' + CAMPOS[0].id).focus(); }
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

  function mostrarApp() {
    const u = estado.sesion.usuario;
    $('#vista-login').hidden = true;
    $('#vista-app').hidden = false;
    $('#usuario-nombre').textContent = u.nombre;
    $('#usuario-detalle').textContent = `${u.secretaria} · ${u.perfil}`;
    $('#usuario-avatar').textContent = u.nombre.split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
    $('#lateral-secretaria').textContent = u.secretaria;
    $('#pestanas').hidden = u.perfil !== 'Análisis';
    $('#chip-demo').hidden = !MODO_DEMO;
    estado.ultima = almacen.get(claveUltima(), null);
    estado.cargasSesion = almacen.get('gr_contador', 0);
    pintarUltima();
    irA('carga');
    setTimeout(() => $('#f-' + CAMPOS[0].id).focus(), 50);
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
      $('#login-clave').value = '';
      if (usuarioAnterior && usuarioAnterior !== r.usuario.usuario) { cargarEnFormulario(null); modoEdicion(null); }
      usuarioAnterior = null;
      mostrarApp();
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
    if (formularioConDatos()) {
      const ok = await modal({
        titulo: '¿Cerrar sesión?',
        html: '<p>Hay datos cargados en el formulario que todavía no guardaste. Si salís, se pierden.</p>',
        si: 'Salir igual', no: 'Cancelar', tipo: 'peligro', iconoId: 'logout',
      });
      if (!ok) return;
    }
    api('logout').catch(() => {});
    almacen.del('gr_sesion');
    almacen.del('gr_contador');
    estado.sesion = null;
    estado.ultima = null;
    modoEdicion(null);
    cargarEnFormulario(null);
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
    $('#btn-cancelar-edicion').addEventListener('click', cancelarEdicion);
    $('#btn-editar').addEventListener('click', editarUltima);
    $('#btn-salir').addEventListener('click', salir);
    $('#btn-actualizar').addEventListener('click', () => (estado.filtro.preset ? elegirPreset(estado.filtro.preset) : cargarEstadisticas()));
    $$('.preset').forEach(b => b.addEventListener('click', () => elegirPreset(b.dataset.preset)));
    ['#filtro-desde', '#filtro-hasta'].forEach(id => $(id).addEventListener('change', alCambiarFechas));
    $('#btn-sonido').addEventListener('click', () => { Sonido.activo = !Sonido.activo; pintarSonido(); });
    $$('.pestana').forEach(p => p.addEventListener('click', () => irA(p.dataset.vista)));
    window.addEventListener('beforeunload', e => {
      if (estado.sesion && formularioConDatos()) { e.preventDefault(); e.returnValue = ''; }
    });
    pintarSonido();

    if (!estado.sesion) return mostrarLogin();
    try {
      const r = await api('sesion');
      estado.sesion.usuario = r.usuario;
      mostrarApp();
    } catch (err) {
      estado.sesion = null;
      almacen.del('gr_sesion');
      mostrarLogin();
    }
  }

  iniciar();
})();
