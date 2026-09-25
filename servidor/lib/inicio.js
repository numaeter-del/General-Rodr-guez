'use strict';
/* Primer arranque: lista inicial de barrios (queda registrada en el historial). */
const { BARRIOS_INICIALES } = require('./campos');
const { transaccion } = require('./db');

function inicializar(db) {
  const hayBarrios = db.prepare('SELECT COUNT(*) AS n FROM barrios').get().n;
  const hayEvento = db.prepare("SELECT COUNT(*) AS n FROM historial WHERE objeto = 'ajuste:barrios'").get().n;
  if (!hayBarrios && !hayEvento) {
    const { guardarBarrios } = require('./api');
    transaccion(db, () => guardarBarrios(db, BARRIOS_INICIALES, { usuario: 'sistema', secretaria: '' }));
  }
}

module.exports = { inicializar };
