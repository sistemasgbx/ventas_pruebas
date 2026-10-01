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

## Despliegue en Render

El archivo `render.yaml` configura la app, PostgreSQL privado y un job diario de respaldo S3. Render proporciona HTTPS y define `PORT`; SQLite se conserva únicamente para desarrollo local. Se puede usar el espacio Hobby (USD 0) con cómputo pagado, sin contratar el espacio Pro de USD 25 si no necesitas sus funciones de equipo.

1. En GitHub confirma que `grubox.db`, `.cert/`, llaves, `.env`, entornos virtuales y Excel estén ignorados. El repositorio ya debe tener al menos un commit publicado.
2. En Render selecciona **New > Blueprint**, conecta el repositorio y aplica `render.yaml`. El servicio usa Ohio y la base no acepta conexiones públicas.
3. Render solicitará `BOOTSTRAP_ADMIN_USERNAME` y `BOOTSTRAP_ADMIN_PASSWORD`. Usa un nombre y una contraseña única de al menos 16 caracteres; no uses `admin123` ni `ana123`.
4. Crea un bucket S3 privado en `us-east-2` (Ohio), con cifrado, versionado y ciclo de vida de 30 días. Limita la llave IAM a lectura/escritura del prefijo `grubox/`. Al sincronizar el Blueprint, Render pedirá `S3_BUCKET_NAME`, `AWS_ACCESS_KEY_ID` y `AWS_SECRET_ACCESS_KEY`.
5. Abre el dominio HTTPS de Render, inicia sesión y crea las cuentas de vendedores desde **Usuarios**. Configura notificaciones de fallos por correo o Slack en **Integrations > Notifications**.

La nube inicia vacía con solo el administrador; no copia automáticamente `grubox.db`. Para conservar datos: cambia primero las contraseñas demo en el CRM local y crea una copia del archivo. Despliega PostgreSQL vacío, detén el servicio web y agrega temporalmente tu IP a la lista de acceso de la base. Usa la URL externa TLS como `DATABASE_URL` y define `BOOTSTRAP_ADMIN_USERNAME` en una terminal segura; ejecuta `python migrate_sqlite_to_postgres.py` para revisar los conteos y después `python migrate_sqlite_to_postgres.py --execute`. La herramienta no modifica SQLite y se detiene si la base destino ya tiene actividad. Quita tu IP de acceso externo y reinicia el servicio al terminar.

El costo base estimado en el espacio Hobby es **USD 13/mes**: web 512 MB USD 7 + PostgreSQL 256 MB USD 6. Se añaden S3, impuestos y consumo adicional. Render Pro suma USD 25/mes al costo de cómputo; no es necesario solo por tener vendedores con cuentas dentro del CRM.

El CRM almacena datos de contacto y ubicación de vendedores. Antes de usarlo con datos reales, define aviso de privacidad, roles de acceso, periodo de conservación y responsables de restauración.

### Rendimiento, archivos y recuperación

- Clientes se consulta en páginas de 50 registros, con búsqueda/filtros SQL y exportación CSV completa de los resultados filtrados. Las consultas frecuentes de análisis, KPI y resumen gerencial se cachean 20 segundos; los cambios registrados invalidan esa caché. Cada proceso mantiene su propia caché, así que al escalar a varias instancias se debe reemplazar por una caché compartida.
- Hay índices B-tree para propietario, etapa, fecha de seguimiento, correo y teléfonos; PostgreSQL agrega índices trigram para búsqueda parcial de empresa, contacto y datos de contacto. SQLAlchemy mantiene un pool local de conexiones por proceso.
- Actualmente el CRM no sube adjuntos. Si se agregan fichas, planos o muestras, guárdalos en almacenamiento de objetos privado (S3), y en PostgreSQL conserva solo clave, tipo, tamaño y fecha; entrégalos con URLs firmadas y vencimiento corto.
- El cron se ejecuta diariamente a las 09:00 UTC (03:00 Ciudad de México). Genera el dump, lo sube cifrado, lo vuelve a descargar desde S3 y lo restaura en un PostgreSQL efímero aislado; verifica tablas clave antes de marcarse exitoso. Esto prueba el respaldo y su recuperación diaria sin tocar producción.
- PostgreSQL de Render ofrece recuperación a un punto en el tiempo: Hobby conserva 3 días y Pro o superior, 7. El dump diario a S3 es una segunda copia independiente.
- Al menos trimestralmente restaura el dump más reciente en una base PostgreSQL aislada, confirma que abre con `psql`, consulta conteos de tablas y valida que un usuario pueda iniciar sesión. Nunca pruebes restauraciones sobre producción.

### Costos aproximados

- **Render Hobby + cómputo**: USD 0 de espacio + servicio web de 512 MB USD 7/mes + PostgreSQL de 256 MB USD 6/mes = **USD 13/mes** antes de S3, impuestos y tráfico adicional.
- **Render Pro + el mismo cómputo**: espacio Pro USD 25/mes + web USD 7 + PostgreSQL USD 6 = **USD 38/mes**. Pro aporta funciones para equipos; no agrega CPU/RAM automáticamente.

Precios consultados el 1 de octubre de 2026 en [Render](https://render.com/pricing); pueden cambiar y el costo final depende del uso.

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

#   v e n t a s _ p r u e b a s 
 
 