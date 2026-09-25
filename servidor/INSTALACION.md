# Red Central de Datos — Instalación en el servidor municipal (Windows)

Guía para el área de Sistemas. Tiempo estimado: 30 minutos, más la gestión del certificado HTTPS.

## 1. Requisitos
- Windows Server 2016 o posterior (o Windows 10/11).
- **Node.js LTS** versión 22.13 o posterior, descargado de <https://nodejs.org> (instalador `.msi`, opciones por defecto). No hace falta instalar nada más: ni base de datos, ni IIS, ni PHP.
- Un puerto libre. Por defecto se usa el **8443**.
- Un **certificado HTTPS** (punto 4).

## 2. Copiar los archivos
Copiar las carpetas `frontend` y `servidor` juntas, por ejemplo:
```
C:\RedCentralDeDatos\
   ├─ frontend\
   └─ servidor\
```

## 3. Configuración (`servidor\config.json`)
Se crea sola la primera vez con estos valores:

| Clave | Por defecto | Qué es |
|---|---|---|
| `puerto` | `8443` | Puerto donde atiende el sistema. |
| `direccion` | `0.0.0.0` | Interfaz de red (`127.0.0.1` si va detrás de un proxy en el mismo equipo). |
| `https` | `null` | Certificado (ver punto 4). **Sin HTTPS no usar en producción.** |
| `detrasDeProxy` | `false` | `true` si hay un IIS/proxy adelante (para registrar la IP real de cada usuario). |
| `baseDeDatos` | `datos/red-central.db` | Archivo de la base. |
| `carpetaRespaldos` | `respaldos` | Dónde se guardan los respaldos cifrados. Recomendado: **otro disco o una carpeta de red**. |
| `horaRespaldo` | `23:00` | Hora del respaldo y la verificación diaria. |
| `respaldosAConservar` | `60` | Cantidad de respaldos diarios que se guardan. |
| `limiteBusquedasPorHora` | `60` | Tope de búsquedas por usuario (el Administrador no tiene tope). |
| `sesionInactividadMin` / `sesionMaximaHoras` | `60` / `12` | Vencimiento de las sesiones. |
| `dobleFactorParaTodos` | `false` | `true` exige código del celular a todos los perfiles. |

## 4. HTTPS (obligatorio si se accede desde fuera del edificio)
Sin HTTPS, las contraseñas viajan sin cifrar y el navegador bloquea las funciones de llave y respaldos. Hay tres opciones:

**A. Certificado propio del municipio (archivo `.pfx`).** Copiarlo a `servidor\` y configurar:
```json
"https": { "pfx": "certificado.pfx", "clave": "contraseña-del-pfx" }
```

**B. Let's Encrypt (gratuito).** Sirve si el servidor tiene un nombre público, por ejemplo `datos.generalrodriguez.gob.ar`. Se puede generar el `.pfx` con [win-acme](https://www.win-acme.com/) y usar la opción A. Hay que renovarlo cada 90 días; win-acme lo hace automáticamente.

**C. IIS como proxy inverso.** Si IIS ya publica HTTPS:
- configurar `"direccion": "127.0.0.1"` y `"detrasDeProxy": true`;
- en IIS, con *Application Request Routing* + *URL Rewrite*, redirigir el sitio a `http://127.0.0.1:8443`.

## 5. Instalar como servicio
En PowerShell **como Administrador**, dentro de `C:\RedCentralDeDatos\servidor`:
```powershell
powershell -ExecutionPolicy Bypass -File .\instalar-servicio.ps1
```
El script hace cuatro cosas:
- crea la tarea programada **«Red Central de Datos»**, que arranca con Windows y se reinicia sola si se cae;
- restringe `datos\`, `respaldos\` y `config.json` a SYSTEM y al grupo Administradores;
- abre el puerto en el Firewall;
- inicia el sistema.

Para probar sin instalar, usar `iniciar.bat`: los mensajes quedan a la vista en la ventana.

## 6. Crear el primer Administrador (una sola vez)
**Con la persona que va a ser Administradora presente**, ejecutar `crear-admin.bat`. Pide:
- usuario;
- nombre;
- secretaría.

Muestra una contraseña temporal, que se le entrega en ese momento. En su primer ingreso, el sistema le pide:
1. elegir su propia contraseña;
2. vincular **Microsoft Authenticator** (o Google Authenticator) en su celular: el doble factor.

A partir de ahí, **Sistemas ya no necesita intervenir**: el Administrador crea los demás usuarios desde el panel.

## 7. Primeros pasos del Administrador (desde el navegador)
1. **Administración → Respaldos → Crear mi llave.**
   - Se descarga un archivo `llave-privada-red-central-XXXX.json`.
   - Guardarlo en un pendrive, **no en el servidor**.
   - Guardar una copia, con la frase secreta anotada aparte, en sobre cerrado.
2. **Administración → Barrios:** pegar el listado oficial, un barrio por renglón.
3. **Administración → Usuarios → Nuevo usuario:** crear los usuarios de cada secretaría. Cada uno recibe una contraseña temporal.

## 8. Respaldos y recuperación
- **Respaldos automáticos:** todas las noches se generan dos archivos cifrados:
  - `respaldo_AAAA-MM-DD_HHMM_planilla.rcd`: la planilla `.xlsx`;
  - `respaldo_..._base.rcd`: la copia exacta de la base.
- **Copia fuera del servidor:** conviene que el Administrador descargue periódicamente algún respaldo a un medio propio.
- **Para abrir un respaldo:** en **Administración → Abrir un respaldo**, con el archivo de la llave y la frase. Se descifra en la computadora del Administrador.
- **Restaurar la base completa:**
  1. Abrir el respaldo `_base.rcd`; se obtiene un archivo `.db`.
  2. Detener la tarea «Red Central de Datos».
  3. Reemplazar `servidor\datos\red-central.db` por ese archivo. Si existen `red-central.db-wal` y `red-central.db-shm`, borrarlos.
  4. Iniciar la tarea.
- **Administrador que perdió el celular o la contraseña:**
  - Si hay otro Administrador, lo resuelve desde el panel: *Reiniciar doble factor* o *Restablecer contraseña*.
  - Si es el único, desde el servidor: `node herramientas\crear-admin.js --restablecer USUARIO`. Esta acción **queda registrada como ALERTA** en el panel.

## 9. Actualizar el sistema
1. Detener la tarea: `Stop-ScheduledTask -TaskName "Red Central de Datos"`.
2. Reemplazar las carpetas `frontend` y `servidor`, **conservando** `servidor\config.json`, `servidor\datos\`, `servidor\respaldos\` y el certificado.
3. Iniciar la tarea: `Start-ScheduledTask -TaskName "Red Central de Datos"`.

La base se adapta sola si la versión nueva agrega campos.

## 10. Recomendaciones adicionales
- Activar **BitLocker** en el disco del servidor.
- Limitar quiénes son Administradores de Windows en ese equipo.
- Mantener Windows y Node.js actualizados (versión LTS).
- No compartir la carpeta `servidor\datos` en la red.
