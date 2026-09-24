# Base Integral de Contribuyentes — General Rodríguez

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
| Cargar registros | ✓ | ✓ |
| Editar la última carga (hasta hacer una nueva) | ✓ | ✓ |
| Estadísticas y gráficos | — | ✓ |
| Ver la planilla completa | — | — (solo el administrador) |

**Validación estricta en cada tecla.** Si se escribe algo fuera de formato, el carácter no se acepta, el campo se pone en rojo, tiembla, suena un aviso y se explica el error. Cada campo muestra arriba cómo se debe completar.

| Campo | Formato aceptado | Ejemplo | Se rechaza |
|---|---|---|---|
| Apellido / Nombre | solo letras y espacios | `González` | números, símbolos |
| DNI | 7 u 8 números | `12345678` | `12.345.678` |
| CUIT/CUIL | 11 números con prefijo y dígito verificador válidos; debe coincidir con el DNI | `20123456786` | `20-12345678-6` |
| Teléfono celular | 10 números: área (sin 0) + número (sin 15) | `1122334455` | `011 15 2233-4455` |
| Mail | usuario@dominio.ext | `hola@net.com` | `hola@net`, `hola @net.com` |
| Domicilio (calle) | solo texto; se permite número **al inicio** | `25 de Mayo` | `Rivadavia 1154` |
| Nro. | solo números, o casilla **S/N** | `1154` | `11a` |
| ¿A quién corresponden los datos? | Titular, Destinatario, Inquilino, Familiar | | |
| Parentesco (solo si es Familiar) | Hijo/a, Esposo/a, Hermano/a, Padre/Madre, Otro | | |

Al tocar **Guardar** con campos vacíos aparece: *«Faltó cargar … ¿Querés guardar igual?»* con **Guardar** / **No guardar**. Con *No guardar* se vuelve al formulario con los campos faltantes en rojo.

## Probarla ya (modo demo)

Si `frontend/assets/config.js` tiene `API_URL: ''`, la app funciona en **modo demo**: los datos quedan en el navegador y trae datos de ejemplo para las estadísticas.

```bash
cd frontend && python3 -m http.server 8080
# abrir http://localhost:8080 — usuarios: carga / analisis, contraseña: demo1234
```

## Puesta en marcha (producción)

### 1. Crear la base de datos y el backend
1. Con la cuenta de Google que será **dueña de los datos**, crear una Google Sheet nueva (por ejemplo «Base Contribuyentes»). **No compartirla.**
2. En la planilla: **Extensiones → Apps Script**. Borrar el contenido y pegar `backend/Code.gs`. Guardar.
3. En el editor elegir la función `setup` y tocar **Ejecutar**. Aceptar los permisos. Se crean las hojas `Registros` y `Usuarios`.
4. **Implementar → Nueva implementación → Tipo: Aplicación web**
   - *Ejecutar como:* **Yo**
   - *Quién tiene acceso:* **Cualquier usuario** (el acceso real lo controla el login de la app)
5. Copiar la URL que termina en `/exec`.

### 2. Crear los usuarios
Volver a la planilla y recargarla: aparece el menú **Contribuyentes**.
- **Crear usuario…** pide usuario, nombre, secretaría, perfil (1 = Carga, 2 = Análisis) y contraseña (mínimo 8 caracteres).
- **Cambiar contraseña…** y **Activar / desactivar usuario…** para la administración diaria.

La secretaría de cada registro se toma **del usuario que lo carga**, así no se puede cargar a nombre de otra secretaría.

### 3. Publicar el frontend
1. Editar `frontend/assets/config.js` y pegar la URL en `API_URL`.
2. Subir el contenido de `frontend/` a su servidor (idealmente con **HTTPS**).

### 4. Respaldo en .xlsx
Menú **Contribuyentes → Programar respaldo .xlsx diario**: todas las noches guarda una copia `.xlsx` en la carpeta privada «Respaldos Base Contribuyentes» de su Drive. También se puede descargar en cualquier momento con *Archivo → Descargar → Microsoft Excel (.xlsx)*.

### Actualizar el backend
Después de modificar `Code.gs`: **Implementar → Administrar implementaciones → editar (lápiz) → Versión: Nueva versión**. Así la URL no cambia.

## Seguridad
- La planilla no se comparte: el script corre con la cuenta del dueño y los usuarios nunca la ven. El perfil Análisis recibe solo totales, no datos personales.
- Las contraseñas se guardan con *hash* + *salt* (nunca en texto plano). Tras 5 intentos fallidos el usuario queda bloqueado 15 minutos.
- Las sesiones vencen a las 6 h y se cierran al cerrar la pestaña.
- El servidor vuelve a validar todos los formatos (no alcanza con saltearse el navegador) y controla que solo se edite la **última** carga de cada usuario.
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
