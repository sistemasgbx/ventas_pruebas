# Grubox CRM local

CRM ligero con Python estándar: usa SQLite en desarrollo local y PostgreSQL administrado al desplegarse. No necesita Node ni PHP.

## Iniciar

1. Conecta la laptop y los demás equipos a la misma red Wi-Fi o cableada.
2. Abre `iniciar_crm.bat` en la laptop servidor.
3. En esa ventana busca la línea `Grubox CRM en la red`.
4. Desde cualquier equipo conectado a la misma red abre la dirección HTTPS mostrada, por ejemplo `https://192.168.0.147:8000`.
5. Mantén abierta la ventana del servidor mientras el equipo use el CRM.

La primera vez, el navegador mostrará un aviso porque el certificado es local. Entra a opciones avanzadas y continúa al sitio; después podrás conceder el permiso de ubicación. También puedes usar `https://localhost:8000` directamente en la laptop servidor.

### Firewall de Windows

La red Wi-Fi de la laptop debe estar configurada como **Privada**. En Windows ve a **Configuración > Red e Internet > Wi-Fi > Propiedades de la red conectada > Tipo de perfil de red > Privada**. El perfil Público bloquea las conexiones entrantes y el celular no podrá cargar el CRM.

Después, abre PowerShell como administrador y ejecuta:

```powershell
New-NetFirewallRule -DisplayName "Grubox CRM LAN" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8000 -Profile Private
```

Si Windows pregunta si Python puede comunicarse, permite únicamente **Redes privadas**. No abras el puerto en el perfil Público ni configures el router para exponerlo a Internet. Esta versión está pensada para la red interna de la empresa. El celular tampoco debe estar conectado a una red de invitados, porque esas redes suelen aislar a los dispositivos entre sí.

La base se crea automaticamente en `grubox.db` al iniciar por primera vez.

## Accesos iniciales

- Administrador: `admin` / `admin123`
- Vendedora: `ana` / `ana123`

Cambia estas contrasenas antes de usar el sistema con datos reales. Desde `Mi cuenta` cada usuario puede cambiar su propia contraseña. El administrador puede crear vendedores y restablecer sus contraseñas desde `Usuarios`.

## Despliegue en Railway

La app ya acepta PostgreSQL en `DATABASE_URL`, el `PORT` inyectado por Railway y el HTTPS administrado por su dominio público. SQLite sigue disponible para desarrollo local. Railway IaC actual permite declarar web y Postgres, pero el Cron se configura aparte desde el panel; `railway.json` ya está deprecado, por eso estos pasos usan el panel vigente.

1. Crea un repositorio privado en GitHub. Antes de subirlo, confirma que `grubox.db`, `.cert/`, llaves, `.env`, entornos virtuales y archivos Excel no aparezcan en `git status`; `.gitignore` no elimina archivos ya versionados.
2. En Railway crea un proyecto y despliega el repositorio como servicio `grubox-crm`. Configura el comando de inicio `python server.py`, health check `/healthz` y genera el dominio HTTPS desde **Settings > Networking**.
3. Añade un servicio PostgreSQL al mismo proyecto y región. En las variables de `grubox-crm`, referencia la URL privada como `DATABASE_URL=${{Postgres.DATABASE_URL}}` (usa el nombre exacto de tu servicio Postgres), y define `APP_ENV=production`, `APP_TIMEZONE=America/Mexico_City`, `BOOTSTRAP_ADMIN_USERNAME` y una contraseña única de al menos 16 caracteres.
4. Despliega una vez. La base nueva crea solo el administrador configurado, sin vendedores o prospectos demo. Entra por el dominio HTTPS y crea los vendedores en **Usuarios**.
5. Para respaldos externos, crea un bucket S3 privado, con cifrado y una regla de ciclo de vida, por ejemplo 30 días. Añade otro servicio desde el mismo repositorio; configura **Dockerfile path** como `Dockerfile.backup`, su **Cron Schedule** como `0 9 * * *` (09:00 UTC) y las variables `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `AWS_REGION`, `S3_BUCKET_NAME`, `BACKUP_PREFIX=grubox`, `AWS_ACCESS_KEY_ID` y `AWS_SECRET_ACCESS_KEY`. Usa credenciales IAM restringidas al prefijo de backup, con lectura y escritura.
6. Ejecuta el servicio de respaldo y comprueba sus logs. Cada ejecución genera un dump, lo sube a S3, vuelve a descargarlo y lo restaura en un PostgreSQL temporal antes de reportar éxito.

Para conservar los datos locales, cambia primero las contraseñas demo de `admin` y `ana`, crea una copia de `grubox.db` y despliega PostgreSQL vacío. Usa temporalmente `DATABASE_URL` con la conexión pública/TCP Proxy de Railway y `BOOTSTRAP_ADMIN_USERNAME` desde una terminal segura para ejecutar `python migrate_sqlite_to_postgres.py`, revisar conteos y luego `python migrate_sqlite_to_postgres.py --execute`. El importador se niega a usar un destino con actividad, conserva IDs e historiales y no modifica SQLite. Después quita el acceso público a la base y vuelve a usar la referencia privada del servicio.

Railway Hobby cuesta USD 5/mes e incluye USD 5 de uso de recursos; app y PostgreSQL encendidos pueden exceder ese crédito y el resto se cobra por consumo. Almacenamiento de volúmenes cuesta USD 0.15/GB-mes; salida de red, USD 0.05/GB. S3 se factura aparte. Revisa el uso y configura alertas de gasto en Railway.

El health check `/healthz` verifica la base durante el despliegue; Railway no lo consulta continuamente tras publicar. Configura monitoreo externo de disponibilidad o revisa métricas y logs en Railway. El PostgreSQL de Railway puede tener respaldos programados de su volumen desde **Backups**; la copia S3 agrega una recuperación fuera del proyecto Railway.

El CRM almacena datos de contacto y ubicación de vendedores. Antes de usarlo con datos reales, define aviso de privacidad, roles de acceso, periodo de conservación y responsables de restauración.

### Rendimiento, archivos y recuperación

- Clientes se consulta en páginas de 50 registros, con búsqueda/filtros SQL y exportación CSV completa de los resultados filtrados. Las consultas frecuentes de análisis, KPI y resumen gerencial se cachean 20 segundos; los cambios registrados invalidan esa caché. Cada proceso mantiene su propia caché, así que al escalar a varias instancias se debe reemplazar por una caché compartida.
- Hay índices B-tree para propietario, etapa, fecha de seguimiento, correo y teléfonos; PostgreSQL agrega índices trigram para búsqueda parcial de empresa, contacto y datos de contacto. SQLAlchemy mantiene un pool local de conexiones por proceso.
- Actualmente el CRM no sube adjuntos. Si se agregan fichas, planos o muestras, guárdalos en almacenamiento de objetos privado (S3), y en PostgreSQL conserva solo clave, tipo, tamaño y fecha; entrégalos con URLs firmadas y vencimiento corto.
- El cron se ejecuta diariamente a las 09:00 UTC (03:00 Ciudad de México). Genera el dump, lo sube cifrado, lo vuelve a descargar desde S3 y lo restaura en un PostgreSQL efímero aislado; verifica tablas clave antes de marcarse exitoso. Esto prueba el respaldo y su recuperación diaria sin tocar producción.
- Railway permite configurar respaldos de volúmenes diarios (retención de 6 días), semanales (27 días) o mensuales (89 días); revisa el costo incremental. El dump diario a S3 es una segunda copia independiente.
- Al menos trimestralmente restaura el dump más reciente en una base PostgreSQL aislada, confirma que abre con `psql`, consulta conteos de tablas y valida que un usuario pueda iniciar sesión. Nunca pruebes restauraciones sobre producción.

### Costos aproximados

- **Railway Hobby**: USD 5/mes, incluye USD 5 de uso. Memoria: USD 10/GB-mes; CPU: USD 20/vCPU-mes; volumen: USD 0.15/GB-mes; egreso: USD 0.05/GB. El cargo total será el mayor entre la suscripción y el consumo, no un precio fijo por servicio. El cron y S3 añaden consumo.

Precios consultados el 1 de octubre de 2026 en [Railway](https://railway.com/pricing); pueden cambiar y el costo final depende del uso.

## Incluye

- Inicio de sesión con sesiones locales y roles.
- Clientes y prospectos separados por vendedor.
- Alta y cambio de etapa persistidos en PostgreSQL en producción y SQLite localmente, con código interno, canal de contacto, muestra, plano y fechas de entrega solicitada y prevista. El tablero pagina registros y conserva los totales globales.
- Vista de prospectos en tablero por etapa o lista, con planta, código MP, OC, piezas/kg, UM, requerimiento planeado, fecha de entrega y proveedor; estos datos también se incluyen en el CSV.
- Agenda de citas por prospecto, ejecutivo, fecha, hora, tipo, etapa, venta estimada y resultado.
- Análisis por periodo de citas programadas, reuniones realizadas, cancelaciones, reprogramaciones y avances de etapa. Cada cita conserva una bitácora de acuerdos y próxima acción.
- Registro semanal de llamadas, correos, contactos efectivos, cotizaciones, seguimientos, muestras y oportunidades.
- Cierre de venta con captura del importe real, separado del valor estimado; KPI semanal con conversión de cotizados a ganados.
- Resumen gerencial integrado en Análisis, disponible para el administrador.
- Bitácora de auditoría de accesos y cambios.
- Alta de vendedores y restablecimiento de contraseñas.
- Desactivación de vendedores desde administración, conservando sus prospectos históricos.
- Resumen de dinero separado en venta real, oportunidades activas y oportunidades perdidas.

## Ubicación de vendedores

El vendedor puede entrar desde su celular, iniciar sesión y activar **Compartir mi ubicación**. El administrador tiene la sección **Ubicaciones**, donde ve la última señal recibida, su hora, precisión aproximada y un mapa de los vendedores que están compartiendo.

El sistema conserva la última ubicación compartida y un historial de señales recibidas. El navegador debe permanecer abierto con el permiso de ubicación activo; una página web no puede garantizar el envío de GPS después de cerrarse o cuando el sistema del teléfono la suspende. La ubicación se inicia mediante permiso explícito del vendedor y debe tratarse como dato personal.

Para usar GPS desde un celular, el navegador requiere un origen seguro. El servidor genera automáticamente un certificado HTTPS local y muestra la dirección correcta al iniciar. No uses la dirección `http://192.168.x.x:8000`, porque el navegador cargará el CRM pero bloqueará el botón **Compartir mi ubicación**.

Para rastreo con la aplicación cerrada se necesitaría una app móvil nativa con permisos de ubicación en segundo plano y una política de privacidad específica.

# activacion de servidor 
cd "C:\Users\rhgbx\OneDrive\Documents\Ventas"
& "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe" server.py

# detener servidor

#   v e n t a s _ p r u e b a s  
 