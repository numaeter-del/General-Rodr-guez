# Red Central de Datos — General Rodríguez

Aplicación web para que las secretarías del municipio carguen datos de contribuyentes en **una única base de datos**, alojada en el **servidor municipal**, con un Administrador que tiene la «llave maestra».

```
 Secretaría A ─┐                       SERVIDOR MUNICIPAL (Windows)
 Secretaría B ─┤   navegador     ┌──────────────────────────────────────────┐
 Secretaría C ─┼──── https ─────►│ Red Central de Datos (Node.js)            │
 Secretaría D ─┤                 │  · base de datos SQLite (un archivo)      │
 Administrador ┘                 │  · historial encadenado (antimanipulación)│
   (doble factor)                │  · respaldos diarios CIFRADOS ───────────►│ solo se abren con la
                                 └──────────────────────────────────────────┘ llave privada del Administrador
```

| Carpeta | Qué es |
|---|---|
| `frontend/` | La interfaz (HTML, CSS, JS). La sirve el mismo servidor. |
| `servidor/` | **Versión para el servidor municipal (recomendada).** Node.js sin librerías externas. Ver [`servidor/INSTALACION.md`](servidor/INSTALACION.md). |
| `backend/Code.gs` | Versión anterior en Google Sheets, solo para pruebas. No tiene panel de Administración ni doble factor, y no se va a seguir actualizando. |

## Perfiles

| | **Carga** | **Análisis** | **Administrador** |
|---|:-:|:-:|:-:|
| Buscar fichas (DNI, CUIT/CUIL, partida inmueble o comercio) | ✓ | ✓ | ✓ |
| Cargar fichas nuevas y editar la última carga | ✓ | ✓ | ✓ |
| Sumar un teléfono, un nuevo domicilio o corregir un dato | ✓ | ✓ | ✓ |
| Ver teléfonos, mail y comentarios **completos** en las búsquedas | — (ocultos) | — (ocultos) | ✓ |
| Ver números de carga | — | ✓ | ✓ |
| Estadísticas y gráficos | — | ✓ | ✓ |
| Panel de Administración: usuarios, barrios, actividad, integridad | — | — | ✓ |
| Exportar la planilla completa (.xlsx) y abrir respaldos | — | — | ✓ (pide código de doble factor) |
| Ingreso con doble factor (código del celular) | opcional* | opcional* | **obligatorio** |

\* Se puede exigir a todos con `"dobleFactorParaTodos": true` en `servidor/config.json`.

## Seguridad

**Acceso**
- **Contraseñas propias:** cada usuario recibe una contraseña temporal y en el primer ingreso elige la suya (mínimo 10 caracteres, con letras y números). Se guardan con *scrypt*, nunca en texto plano.
- **Bloqueos por intentos fallidos:** 5 errores bloquean el usuario 15 minutos, y 20 errores desde una misma conexión la bloquean también.
- **Doble factor para el Administrador:** usa Microsoft Authenticator o Google Authenticator.
- **Sesiones:** vencen tras 60 minutos sin uso o 12 horas en total, y se cierran al cerrar la pestaña.

**Protección de los datos**
- **Datos ocultos:** quien no es Administrador ve los teléfonos (`11****4455`), el mail (`l***@mail.com`) y los comentarios ocultos. Reconoce la ficha, pero no se puede llevar la base.
- **Búsquedas limitadas y registradas:**
  - Solo por coincidencia exacta de DNI, CUIT/CUIL o partida; no se puede recorrer la base ni buscar por apellido.
  - Cada búsqueda queda registrada.
  - Hay un tope de 60 búsquedas por hora por usuario, configurable. Si se alcanza, aparece una alerta en el panel de Administración.

**Antimanipulación**
- **Historial encadenado:** cada alta o cambio de una ficha, de un usuario o de un ajuste crítico se guarda con la huella (SHA-256) del anterior.
- **Verificación nocturna y en cada apertura del panel:** si alguien modifica el archivo de la base por fuera de la aplicación, el sistema lo detecta y lo muestra en rojo. Señala qué ficha, qué usuario o qué ajuste se tocó.
- **Sello de referencia:** el navegador del Administrador guarda un «sello» (cantidad de eventos + huella). Si el historial se reescribe entero, el sello deja de coincidir y aparece la alerta.
- **Nada se borra desde la aplicación:** la base rechaza borrar fichas y borrar o modificar el historial y el registro de accesos.

**Respaldos cifrados**
- Todas las noches se generan dos archivos: una planilla `.xlsx` y una copia exacta de la base.
- Se cifran con la **llave pública** del Administrador. El servidor puede cifrar pero **no descifrar**: quien copie los respaldos no puede leerlos.
- La **llave privada** se crea en el navegador del Administrador, queda protegida con una frase secreta y se guarda fuera del servidor (pendrive + copia en sobre cerrado).
- Los respaldos se abren desde el panel, en la propia computadora del Administrador.

**En el servidor**
- **Carpetas protegidas:** el instalador deja las carpetas de datos, respaldos y la configuración accesibles solo para SYSTEM y los Administradores de Windows.
- **Encabezados de seguridad:** la página impide que se ejecute código de otros sitios y que se la muestre dentro de otra página.
- **Sin librerías externas:** no hay código de terceros que pueda filtrar datos.

**Límite honesto:** quien administra el servidor Windows siempre podría, en última instancia, intervenir el sistema. Lo que el sistema garantiza es que:
- una manipulación **queda en evidencia**;
- los **respaldos robados no se pueden leer**;
- cada acceso **queda registrado**.

Conviene complementarlo con medidas organizativas: designación formal del responsable de la base, compromisos de confidencialidad y copia de la llave en sobre cerrado.

## Cómo se carga (flujo para evitar duplicados)
1. **Buscar** por DNI, CUIT/CUIL, Partida inmueble o Partida comercio.
2. **Si la ficha existe**, *Actualizar esta ficha* → **Agregar un teléfono**, **Cargar un nuevo domicilio** o **Corregir o completar un dato**. Solo se habilita el campo que corresponde; el valor anterior queda en el historial.
3. **Si no existe**, **Realizar nueva carga** (el dato buscado ya queda completado).

No se pueden crear dos fichas con el mismo DNI o CUIT/CUIL. Si en una carga nueva se escribe uno existente, aparece en el centro de la pantalla una ventana con la ficha y las tres opciones.

**Validación estricta en cada tecla.** Si se escribe algo fuera de formato, el carácter no se acepta, el campo se pone en rojo, tiembla, suena un aviso y se explica el error. Cada campo muestra arriba cómo se debe completar.

| Campo | Formato aceptado | Ejemplo | Se rechaza |
|---|---|---|---|
| Apellido / Nombre | solo letras y espacios | `González` | números, símbolos |
| DNI | 7 u 8 números | `12345678` | `12.345.678` |
| CUIT/CUIL | 11 números con prefijo y dígito verificador válidos; debe coincidir con el DNI | `20123456786` | `20-12345678-6` |
| Teléfono celular | 10 números: área (sin 0) + número (sin 15) | `1122334455` | `011 15 2233-4455` |
| Teléfono celular 2 *(opcional)* | mismo formato; distinto del celular 1 | `2374556677` | |
| Mail | usuario@dominio.ext | `hola@net.com` | `hola@net`, `hola @net.com` |
| Domicilio (calle) | solo texto; se permite número **al inicio** | `25 de Mayo` | `Rivadavia 1154` |
| Nro. | solo números, o casilla **S/N** | `1154` | `11a` |
| Barrio | se elige de la lista (se filtra al escribir); si no está, **Otro** | | barrios fuera de la lista |
| Nombre del barrio (solo si es «Otro») | letras, números, espacios y puntos | `Vista Linda` | comas, guiones, símbolos |
| Piso / Depto. *(opcional)* | letras y números (se pasa a mayúsculas) | `3 B`, `PB 2` | `3-B`, `3/B` |
| ¿A quién corresponden los datos? | Titular, Destinatario, Inquilino, Familiar | | |
| Parentesco (solo si es Familiar) | Hijo/a, Esposo/a, Hermano/a, Padre/Madre, Otro | | |
| Especificá el parentesco (solo si es «Otro») | solo letras | `Abuela` | números |
| Partida Municipal Inmueble *(opcional)* | solo números, hasta 12 | `123456` | `12.345`, `12-345` |
| Partida Municipal Comercio *(opcional)* | solo números, hasta 12 | `654321` | `12.345`, `12-345` |
| Comentarios *(opcional)* | texto libre, hasta 500 caracteres | | |

Al tocar **Guardar** con campos vacíos aparece *«Faltó cargar … ¿Querés guardar igual?»* con **Guardar** / **No guardar**. Con *No guardar* se vuelve al formulario con los campos faltantes en rojo.

> ⚠️ La lista de barrios que trae el sistema es **provisoria**. El Administrador la reemplaza por el listado oficial desde **Administración → Barrios** (un barrio por renglón).

## Estadísticas
- **Período:** botones rápidos (7 días, 30 días, Este mes, Este año, Todo) o fechas *Desde* / *Hasta*.
- **Cargas por día o por mes:** hasta 62 días se muestran por día; en períodos más largos, por mes.
- **Últimos 7 días:** hoy y los 6 días anteriores, sin importar el período elegido.

## Probarla ya (modo demo)
Con `API_URL: ''` en `frontend/assets/config.js`, la app funciona sola en el navegador y trae datos de ejemplo:

```bash
cd frontend && python3 -m http.server 8080
# abrir http://localhost:8080 — usuarios: carga, analisis o admin · contraseña demo1234
# fichas de prueba para el buscador: DNI 20111222 y 25333444
```

En el modo demo no hay servidor. El panel de Administración se puede recorrer, pero la exportación, los respaldos y el doble factor funcionan solo en el servidor municipal.

## Estructura
```
frontend/
  index.html            interfaz (ingreso, carga, estadísticas, administración)
  assets/app.js         lógica, validaciones, gráficos, cifrado de llaves (WebCrypto), modo demo
  assets/styles.css     estilos
servidor/
  servidor.js           servidor web + API
  lib/                  base de datos, seguridad, auditoría, respaldos, planillas .xlsx
  herramientas/         crear-admin.js (primer Administrador / recuperación)
  instalar-servicio.ps1 instalación en Windows como servicio
  INSTALACION.md        guía para el área de Sistemas
backend/Code.gs         versión en Google Sheets (solo pruebas, sin mantenimiento)
```
