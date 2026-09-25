'use strict';
/* Configuración: servidor/config.json (si no existe, se crea con los valores por defecto). */
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '..');
const DEFECTO = {
  puerto: 8443,
  direccion: '0.0.0.0',
  https: null,
  detrasDeProxy: false,
  carpetaFrontend: '../frontend',
  baseDeDatos: 'datos/red-central.db',
  carpetaRespaldos: 'respaldos',
  horaRespaldo: '23:00',
  respaldosAConservar: 60,
  sesionInactividadMin: 60,
  sesionMaximaHoras: 12,
  limiteBusquedasPorHora: 60,
  dobleFactorParaTodos: false,
  organismo: 'Municipalidad de General Rodríguez',
};

function cargarConfig() {
  const ruta = process.env.RCD_CONFIG ? path.resolve(process.env.RCD_CONFIG) : path.join(RAIZ, 'config.json');
  if (!fs.existsSync(ruta)) fs.writeFileSync(ruta, JSON.stringify(DEFECTO, null, 2), 'utf8');
  const leido = JSON.parse(fs.readFileSync(ruta, 'utf8'));
  const c = Object.assign({}, DEFECTO, leido);
  // Las rutas relativas son relativas a la carpeta "servidor".
  ['carpetaFrontend', 'baseDeDatos', 'carpetaRespaldos'].forEach(k => { c[k] = path.resolve(RAIZ, c[k]); });
  return c;
}

module.exports = { cargarConfig, DEFECTO };
