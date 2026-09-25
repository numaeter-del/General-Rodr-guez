'use strict';
/*
 * Generador mínimo de planillas .xlsx (Excel), sin librerías externas.
 * hojas: [{ nombre, columnas: ['A', 'B', ...], filas: [[...], ...], anchos?: [n, ...] }]
 * Todos los valores se guardan como texto (así Excel no convierte DNI o teléfonos en números).
 */
const zlib = require('node:zlib');

const xml = s => String(s == null ? '' : s)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function columna(i) {
  let s = '';
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

function hojaXml({ columnas, filas, anchos }) {
  const celda = (v, f, c, estilo) => `<c r="${columna(c)}${f}" t="inlineStr"${estilo ? ' s="1"' : ''}><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
  const cols = columnas.map((_, i) => `<col min="${i + 1}" max="${i + 1}" width="${(anchos && anchos[i]) || 18}" customWidth="1"/>`).join('');
  const filasXml = [`<row r="1">${columnas.map((v, c) => celda(v, 1, c, true)).join('')}</row>`]
    .concat(filas.map((fila, i) => `<row r="${i + 2}">${fila.map((v, c) => celda(v, i + 2, c, false)).join('')}</row>`));
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    + `<cols>${cols}</cols><sheetData>${filasXml.join('')}</sheetData>`
    + (filas.length ? `<autoFilter ref="A1:${columna(columnas.length - 1)}${filas.length + 1}"/>` : '')
    + '</worksheet>';
}

/* ---------- ZIP (formato "store + deflate" estándar) ---------- */
function zip(archivos) {
  const locales = [], centrales = [];
  let desplazamiento = 0;
  const fecha = (() => {
    const d = new Date();
    return { hora: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), dia: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
  })();
  for (const { nombre, datos } of archivos) {
    const bNombre = Buffer.from(nombre, 'utf8');
    const crudo = Buffer.isBuffer(datos) ? datos : Buffer.from(datos, 'utf8');
    const comprimido = zlib.deflateRawSync(crudo);
    const crc = zlib.crc32(crudo);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(fecha.hora, 10); local.writeUInt16LE(fecha.dia, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comprimido.length, 18); local.writeUInt32LE(crudo.length, 22); local.writeUInt16LE(bNombre.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt16LE(fecha.hora, 12); central.writeUInt16LE(fecha.dia, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comprimido.length, 20); central.writeUInt32LE(crudo.length, 24); central.writeUInt16LE(bNombre.length, 28);
    central.writeUInt32LE(desplazamiento, 42);
    locales.push(local, bNombre, comprimido);
    centrales.push(central, bNombre);
    desplazamiento += local.length + bNombre.length + comprimido.length;
  }
  const dirCentral = Buffer.concat(centrales);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(archivos.length, 8); fin.writeUInt16LE(archivos.length, 10);
  fin.writeUInt32LE(dirCentral.length, 12); fin.writeUInt32LE(desplazamiento, 16);
  return Buffer.concat([...locales, dirCentral, fin]);
}

function libro(hojas) {
  const nombreHoja = n => xml(String(n).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
  const archivos = [
    { nombre: '[Content_Types].xml', datos: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + hojas.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '</Types>' },
    { nombre: '_rels/.rels', datos: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { nombre: 'xl/workbook.xml', datos: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
      + hojas.map((h, i) => `<sheet name="${nombreHoja(h.nombre)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
      + '</sheets>' + (hojas.some(h => h.filas.length) ? '<definedNames>' + hojas.map((h, i) => h.filas.length
        ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${nombreHoja(h.nombre)}'!$A$1:$${columna(h.columnas.length - 1)}$${h.filas.length + 1}</definedName>` : '').join('') + '</definedNames>' : '')
      + '</workbook>' },
    { nombre: 'xl/_rels/workbook.xml.rels', datos: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + hojas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${hojas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { nombre: 'xl/styles.xml', datos: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>'
      + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0F766E"/></patternFill></fill></fills>'
      + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
      + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>'
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' },
  ].concat(hojas.map((h, i) => ({ nombre: `xl/worksheets/sheet${i + 1}.xml`, datos: hojaXml(h) })));
  return zip(archivos);
}

module.exports = { libro };
