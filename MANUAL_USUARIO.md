# Manual de usuario de Grubox CRM

Este manual te acompaña en el uso diario del CRM. La idea es sencilla: guardar la información de cada oportunidad, dejar claro cuál es el siguiente paso y registrar lo que pasó para que nada importante dependa de la memoria.

## 1. Entrar al CRM

1. La persona responsable inicia el CRM en la computadora que funciona como servidor.
2. Abre en tu navegador la dirección que aparece en la ventana del servidor. Si estás usando esa misma computadora, también puedes entrar desde `https://localhost:8000`.
3. Escribe el usuario y la contraseña que te asignaron. Si eres vendedor, marca la casilla de aviso de ubicación; al iniciar sesión el navegador pedirá permiso para registrar tu ubicación.

La primera vez, el navegador puede mostrar una advertencia del certificado local. En el uso dentro de la red de la empresa, continúa al sitio siguiendo las indicaciones de tu navegador. Si no puedes abrir la página, avisa a la persona administradora; el servidor debe estar encendido y ambos dispositivos deben estar en la misma red.

En una instalación local nueva podrían estar habilitados estos accesos de demostración:

| Perfil | Usuario | Contraseña inicial |
|---|---|---|
| Administrador | `admin` | `admin123` |
| Vendedora | `ana` | `ana123` |

Úsalos solo si siguen vigentes en tu instalación. Antes de trabajar con información real, cambia las contraseñas. En una instalación publicada en Render, la cuenta de administrador se configura durante el despliegue y puede ser distinta.

## 2. Qué encontrarás en la pantalla

La barra superior contiene las secciones principales:

- **Clientes:** prospectos, etapas de venta, búsqueda y resumen de oportunidades.
- **Seguimiento:** pendientes vencidos, para hoy, próximos y sin fecha.
- **Citas:** reuniones programadas y registro de sus resultados.
- **Dashboard:** resultados anuales y análisis de citas y avance comercial del periodo.
- **Indicadores:** actividad comercial de la semana seleccionada.
- **Movimientos:** cambios de etapa y seguimientos registrados.
- **Ubicaciones, Auditoría y Usuarios:** herramientas disponibles solo para administración.

Cada persona ve la información que corresponde a su perfil. El vendedor trabaja con sus prospectos; el administrador puede revisar la operación del equipo y gestionar usuarios.

Al iniciar sesión, el administrador entra al **Dashboard comercial**. Ahí consulta la meta anual, el forecast ponderado, las ventas reales, el cumplimiento, el gap, el pipeline, las cuentas recuperadas y los clientes nuevos. La meta se captura para cada año desde el formulario del tablero. El semáforo marca verde con cumplimiento de 100% o más, amarillo entre 90% y 99%, y rojo debajo de 90%.

La gráfica mensual distribuye la meta anual en doce partes iguales y coloca las oportunidades abiertas por su fecha estimada de cierre. Se clasifican según su probabilidad: comprometidas de 70% a 100%, probables de 40% a 69% y posibles de 0% a 39%. El forecast ponderado usa el valor de cada oportunidad multiplicado por su probabilidad.

## 3. Registrar un prospecto

1. Entra en **Clientes** y selecciona **Nuevo prospecto**.
2. En **Datos de la empresa**, captura el nombre de la empresa, la persona y el medio de contacto. Puedes elegir llamada, WhatsApp, correo, visita o redes sociales (Facebook, LinkedIn, TikTok e Instagram). Agrega los teléfonos, el correo y la ubicación.
3. En **Checklist para cotizar**, registra los datos de entrega y las especificaciones del producto. Si la dirección de entrega es la misma que la ubicación de la empresa, marca **Usar la ubicación de la empresa como dirección de entrega** para no volver a escribirla. Indica si recibiste una muestra física y un plano; esos dos campos son obligatorios. Captura el volumen de piezas y el precio estimado por pieza.
4. En **Pipeline comercial**, selecciona la etapa de negociación una sola vez; el estado del pipeline se actualiza automáticamente a partir de esa selección. Si eliges **Ganado**, captura el importe real vendido; si eliges **Perdido**, indica el motivo. Completa tipo de oportunidad, industria o sector, probabilidad, fecha estimada de cierre, siguiente acción y observaciones. El valor estimado se calcula automáticamente como precio por pieza × volumen, y el forecast ponderado como ese valor × probabilidad. Si el producto/medida es el mismo que el tipo registrado en Checklist, conserva la opción predeterminada; solo agrega otro detalle cuando sea diferente. La fecha de registro y el vendedor se guardan con la oportunidad.
5. Al pulsar **Siguiente** en **Empresa** o **Checklist**, el CRM guarda ese módulo y avanza; en la tarjeta del prospecto puedes desplegar **Ver 3 tablas de captura** para consultar lo guardado en cada módulo. Los módulos pendientes se indican ahí mismo. También puedes guardar y cerrar un borrador con **Guardar avance**, retomarlo con **Continuar captura** y completar el Pipeline con **Guardar oportunidad**.

El **valor estimado de oportunidad** es precio estimado por pieza multiplicado por volumen; se usa como importe previsto y no como una venta confirmada. La probabilidad pondera ese importe para el forecast. Si registras el prospecto directamente como **Ganado**, el sistema también pedirá el importe real vendido; si lo registras como **Perdido**, pedirá el motivo de pérdida.

### Qué significan las etapas

- **Nuevo:** oportunidad recién registrada, aún en exploración.
- **En negociación:** hay conversación activa sobre la necesidad, condiciones o propuesta.
- **Cotizado:** ya se envió una cotización.
- **Ganado:** el cliente confirmó la compra.
- **Perdido:** la oportunidad no se concretó.

En la vista **Tablero**, puedes cambiar la etapa desde el selector de la tarjeta o arrastrar la tarjeta a otra columna. Las tarjetas muestran además datos clave del pipeline. En la vista **Lista**, puedes revisar los datos de compras y planeación y abrir el seguimiento o la edición de los datos de empresa, checklist y pipeline.

Al marcar una oportunidad como **Ganado**, captura el **importe real vendido**. No uses el valor estimado como sustituto si el pedido confirmado tiene otro monto. Al marcarla como **Perdido**, elige el motivo para que quede documentado.

## 4. Buscar, filtrar y exportar

En **Clientes** puedes:

- Buscar por nombre de empresa o contacto.
- Filtrar por etapa o por estado del seguimiento: vencido, para hoy, sin fecha o sin actividad.
- Ordenar por fecha, valor, empresa o próximo contacto.
- En la cuenta administradora, filtrar además por vendedor.
- Cambiar entre **Tablero** y **Lista**.
- Usar **Anterior** y **Siguiente** para recorrer los resultados.
- Seleccionar **Exportar CSV** para descargar los resultados que coinciden con los filtros activos y abrirlos en una hoja de cálculo.

Los totales del resumen corresponden al conjunto de oportunidades, aunque estés viendo una página de resultados. “Dinero ganado” usa ventas reales; “oportunidades activas” y el pronóstico se refieren a oportunidades todavía abiertas.

## 5. Registrar un seguimiento

Puedes empezar desde la tarjeta de un prospecto o desde **Seguimiento**. En el formulario:

1. Revisa los datos de contacto. Si hay teléfono o correo, puedes abrir la llamada, WhatsApp o correo desde los accesos disponibles.
2. Indica el medio utilizado y el resultado, por ejemplo, contacto realizado, sin respuesta, cotización enviada o reunión programada.
3. Escribe brevemente qué hablaron: necesidad, dudas, acuerdos o información pendiente.
4. Anota la próxima acción y programa fecha y hora del siguiente contacto.
5. Guarda el seguimiento.

El historial del prospecto conserva los movimientos registrados, quién los realizó, las notas y la próxima acción. Si necesitas mover una fecha sin registrar una conversación, usa **Reprogramar** en la sección Seguimiento.

La vista **Seguimiento** agrupa las oportunidades abiertas en vencidas, para hoy, próximos tres días, sin seguimiento programado y enfriándose (más de siete días sin actividad). Atiende primero las vencidas y las de hoy. Los avisos del navegador y recordatorios requieren tener el CRM abierto; son un apoyo, no sustituyen revisar tus pendientes.

## 6. Agendar una cita y registrar qué ocurrió

1. Selecciona **Nueva cita** en Clientes o en la sección **Citas**.
2. Elige el prospecto, fecha, hora y tipo de cita. Indica la etapa y la venta estimada; puedes agregar notas para preparar la reunión.
3. Guarda la cita.
4. Después de la reunión, abre **Citas** y selecciona **Registrar resultado**.
5. Indica si se realizó, se reprogramó o se canceló. Actualiza también la etapa comercial.
6. Si se realizó, escribe qué ocurrió y los acuerdos. Registra la próxima acción y, si corresponde, la fecha del siguiente contacto.

Si la etapa queda como **Ganado**, captura el importe real. Si queda como **Perdido**, registra el motivo. Una cita reprogramada necesita la nueva fecha de contacto.

## 7. Registrar actividad e indicadores

Usa **Registrar actividad** para contabilizar llamadas o correos de prospección, contactos efectivos, cotizaciones enviadas y solicitudes de muestra o prototipo. Elige el prospecto, el tipo de actividad y agrega una nota breve. Para una cotización, captura también el monto.

En **Indicadores**, elige la semana que quieres consultar. Verás los registros de actividad, montos cotizados y vendidos, citas y conversión de prospectos cotizados a ganados. Las metas que aparecen son referencias sugeridas, no una garantía de resultado. Los indicadores dependen de que las actividades y cierres se registren correctamente.

En **Dashboard** puedes consultar las citas programadas, realizadas, reprogramadas y canceladas, además del avance de etapa. Ajusta las fechas para revisar otro periodo. El administrador también ve el resumen gerencial del equipo y la gráfica anual de ventas.

## 8. Funciones de administración

Estas opciones aparecen únicamente para el administrador:

- **Usuarios:** crear accesos para vendedores, restablecer sus contraseñas o desactivarlos. La contraseña inicial de un vendedor debe tener al menos ocho caracteres. Al desactivar una cuenta, el vendedor ya no podrá entrar, pero sus prospectos históricos se conservan.
- **Ubicaciones:** consultar la última señal compartida por cada vendedor y su historial, con filtros por persona y fecha.
- **Auditoría:** revisar las acciones registradas y filtrar por periodo.
- **Resumen gerencial:** comparar oportunidades, ventas, pendientes y motivos de pérdida del equipo.

Cada usuario puede cambiar su propia contraseña desde **Mi cuenta**. Se pide la contraseña actual y una nueva de al menos ocho caracteres.

## 9. Compartir ubicación

Al iniciar sesión, la cuenta de vendedor solicita permiso al navegador y registra la ubicación una sola vez por sesión. Volver a cargar la página no agrega otro registro; cerrar sesión y entrar de nuevo sí registra una ubicación nueva. En **Clientes** puedes utilizar **Reintentar ubicación** si el permiso se rechazó o no se pudo obtener señal. El administrador podrá ver la última ubicación y, desde **Ubicaciones**, eliminar todos los registros del historial sin borrar la última ubicación que se muestra en el mapa.

El navegador debe permitir la ubicación y el CRM debe abrirse por HTTPS (o desde `localhost` en la computadora servidor). Si el permiso se denegó, habilítalo en la configuración del navegador y selecciona **Reintentar ubicación**.

La ubicación es un dato personal. Compártela solo conforme a las reglas y el aviso de privacidad de la empresa.

## 10. Buenas prácticas y ayuda rápida

- Registra cada oportunidad una sola vez y busca la empresa antes de crear otra.
- Escribe notas claras, respetuosas y útiles para que otra persona pueda entender el contexto.
- Mantén actualizadas la etapa, la próxima acción y la fecha de contacto.
- Diferencia siempre un importe estimado de una venta confirmada.
- No compartas tu contraseña. Si no puedes entrar, solicita apoyo al administrador.
- Si el CRM no carga, confirma que el servidor siga abierto y que tengas conexión a la red correcta. No cierres la ventana del servidor mientras el equipo esté usando el sistema.
- Si cambias de teléfono o computadora, vuelve a iniciar sesión desde el navegador; no necesitas instalar una aplicación.

**Un buen cierre del día:** revisa los vencidos y pendientes de hoy, registra las conversaciones realizadas y deja una próxima acción con fecha para cada oportunidad abierta.