# Red Central de Datos — General Rodríguez

Aplicación web para que las secretarías del municipio carguen datos de contribuyentes en **una única base de datos segura** (una Google Sheet a la que solo accede su dueño).

```
 Secretaría A ─┐
 Secretaría B ─┤   navegador         Google Apps Script         Google Sheet (privada)
 Secretaría C ─┼──► frontend/  ───►  backend/Code.gs     ───►   hojas «Registros» y «Usuarios»
 Secretaría D ─┤   (su servidor)     (valida y guarda)          + respaldo .xlsx diario en Drive
 Secretaría E ─┘
```

- **frontend/**: HTML + CSS + JS estáticos. Se suben tal cual a su servidor web (no requiere PHP, Node ni base de datos).
- **backend/Code.gs**: API en Google Apps Script. Recibe los datos, **vuelve a validarlos** del lado del servidor, controla usuarios y permisos, y escribe en la planilla.

## Funciones

| | Perfil **Carga** | Perfil **Análisis** |
|---|:-:|:-:|
| Buscar fichas (DNI, CUIT/CUIL, partida inmueble o comercio) | ✓ | ✓ |
| Cargar registros nuevos | ✓ | ✓ |
| Sumar un teléfono, un nuevo domicilio o corregir un dato de una ficha existente | ✓ | ✓ |
| Editar la última carga (hasta hacer una nueva) | ✓ | ✓ |
| Ver números de carga / cantidad de cargas | — | ✓ |
| Estadísticas y gráficos, con filtro por período | — | ✓ |
| Ver la planilla completa | — | — (solo el administrador) |

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

Los campos opcionales están al final del formulario (Datos complementarios y Comentarios) y no se reclaman al guardar.

## Cómo se carga (flujo para evitar duplicados)
1. **Buscar.** Arriba de todo está el buscador: por DNI, CUIT/CUIL, Partida inmueble o Partida comercio (coincidencia exacta).
2. **Si la ficha existe**, se toca *Actualizar esta ficha* y una ventana pregunta qué hacer:
   - **Agregar un teléfono**: se habilita solo el Teléfono celular 2 (o el 1, si estaba vacío).
   - **Cargar un nuevo domicilio**: se habilitan solo Calle, Nro., Barrio y Piso/Depto. El domicilio anterior queda en el historial.
   - **Corregir o completar un dato**: todo queda bloqueado y cada campo tiene un botón **Corregir** para habilitar solo ese.
3. **Si no existe**, se toca **Realizar nueva carga**. El dato buscado ya aparece completado.

**No se pueden crear dos fichas con el mismo DNI o CUIT/CUIL.** Si en una carga nueva se escribe un DNI o un CUIT/CUIL que ya existe, aparece en el centro de la pantalla una ventana con la ficha existente y las mismas tres opciones. El servidor también lo controla.

**Historial.** Cada cambio sobre una ficha queda registrado en la hoja **Historial**: fecha, usuario, secretaría, acción, campo, valor anterior y valor nuevo. Nada se pierde al reemplazar un domicilio o un teléfono.

**Números de carga.** El perfil Carga no ve números de carga ni cuántas cargas hay en la base. El servidor directamente no le envía esos datos.

## Lista de barrios
Los barrios salen de la hoja **Barrios** de la planilla: una columna, un barrio por fila. Para agregar, corregir o quitar barrios se edita esa hoja, sin tocar el código; la app la lee cada vez que alguien inicia sesión.

> ⚠️ El listado que trae `setup` es **provisorio** (unos pocos barrios de ejemplo). Hay que reemplazarlo por el **listado oficial** del municipio (Catastro / Planeamiento).


Al tocar **Guardar** con campos vacíos aparece: *«Faltó cargar … ¿Querés guardar igual?»* con **Guardar** / **No guardar**. Con *No guardar* se vuelve al formulario con los campos faltantes en rojo.

## Probarla ya (modo demo)

Si `frontend/assets/config.js` tiene `API_URL: ''`, la app funciona en **modo demo**: los datos quedan en el navegador y trae datos de ejemplo para las estadísticas.

```bash
cd frontend && python3 -m http.server 8080
# abrir http://localhost:8080 — usuarios: carga / analisis, contraseña: demo1234
# fichas de prueba para el buscador: DNI 20111222 y 25333444
```

## Puesta en marcha (producción)

### 1. Crear la base de datos y el backend
1. Con la cuenta de Google que será **dueña de los datos**, crear una Google Sheet nueva (por ejemplo «Red Central de Datos»). **No compartirla.**
2. En la planilla: **Extensiones → Apps Script**. Borrar el contenido y pegar `backend/Code.gs`. Guardar.
3. En el editor elegir la función `setup` y tocar **Ejecutar**. Aceptar los permisos. Se crean las hojas `Registros` y `Usuarios`.
4. **Implementar → Nueva implementación → Tipo: Aplicación web**
   - *Ejecutar como:* **Yo**
   - *Quién tiene acceso:* **Cualquier usuario** (el acceso real lo controla el login de la app)
5. Copiar la URL que termina en `/exec`.

### 2. Crear los usuarios
Volver a la planilla y recargarla: aparece el menú **Red Central de Datos**.
- **Crear usuario…** pide usuario, nombre, secretaría, perfil (1 = Carga, 2 = Análisis) y contraseña (mínimo 8 caracteres).
- **Cambiar contraseña…** y **Activar / desactivar usuario…** para la administración diaria.

La secretaría de cada registro se toma **del usuario que lo carga**, así no se puede cargar a nombre de otra secretaría.

### 3. Publicar el frontend
1. Editar `frontend/assets/config.js` y pegar la URL en `API_URL`.
2. Subir el contenido de `frontend/` a su servidor (idealmente con **HTTPS**).

### 4. Respaldo en .xlsx
Menú **Red Central de Datos → Programar respaldo .xlsx diario**: todas las noches guarda una copia `.xlsx` en la carpeta privada «Respaldos Red Central de Datos» de su Drive. También se puede descargar en cualquier momento con *Archivo → Descargar → Microsoft Excel (.xlsx)*.

### Actualizar el backend
Después de modificar `Code.gs`: **Implementar → Administrar implementaciones → editar (lápiz) → Versión: Nueva versión**. Así la URL no cambia.

Las columnas de la hoja `Registros` se ubican **por su nombre**, no por su posición. Si se agregan campos nuevos, el script agrega las columnas que falten al final de la hoja, sin tocar los datos existentes. Se pueden reordenar columnas o agregar columnas propias, siempre que no se renombren los encabezados que usa la app.

## Estadísticas
- **Período:** botones rápidos (7 días, 30 días, Este mes, Este año, Todo) o fechas *Desde* / *Hasta*. El total, los celulares, los mails, las secretarías y el vínculo se calculan sobre el período elegido.
- **Cargas por día o por mes:** hasta 62 días se muestra por día; en períodos más largos, por mes.
- **Últimos 7 días:** hoy y los 6 días anteriores, siempre, sin importar el período elegido.

## Seguridad
- La planilla no se comparte: el script corre con la cuenta del dueño y los usuarios nunca la ven. El perfil Análisis recibe solo totales, no datos personales.
- Las contraseñas se guardan con *hash* + *salt* (nunca en texto plano). Tras 5 intentos fallidos el usuario queda bloqueado 15 minutos.
- Las sesiones vencen a las 6 h y se cierran al cerrar la pestaña.
- El servidor vuelve a validar todos los formatos (no alcanza con saltearse el navegador), controla que solo se edite la **última** carga de cada usuario y que cada actualización toque solo los campos de la acción elegida.
- La búsqueda es solo por coincidencia exacta de DNI, CUIT/CUIL o partida: no se puede recorrer la base ni buscar por apellido.
- Las hojas quedan protegidas contra edición de terceros.

## Estructura
```
frontend/
  index.html          interfaz (login, carga, estadísticas)
  assets/config.js    URL del backend
  assets/app.js       lógica, validaciones, gráficos, modo demo
  assets/styles.css   estilos
  assets/logo.webp, favicon.png
backend/
  Code.gs             API + menú de administración (Google Apps Script)
```
