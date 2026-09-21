# Mucha Lucha Chimal — pagos reales

Tu sitio (`public/index.html`) ahora se conecta a un backend (`server.js`) que
crea sesiones de pago reales en Stripe. Ya no se genera el boleto solo con
JavaScript del navegador — el boleto solo aparece cuando Stripe confirma que
sí se pagó (vía webhook).

## 1. Cuenta de Stripe (esto lo haces tú)
1. Regístrate: https://dashboard.stripe.com/register
2. **Mientras no actives tu cuenta con datos reales (RFC, cuenta bancaria MX),
   solo puedes usar modo prueba** — no se cobra dinero real, pero puedes
   probar todo el flujo.
3. Copia tu `Secret key` en **Developers > API keys**.

## 2. Activar OXXO (opcional pero lo pediste)
En el Dashboard: **Settings > Payment methods** → activa "OXXO".
Requiere cuenta verificada para México, en MXN.
El pago en OXXO se confirma horas/días después de que el cliente paga en tienda — por eso el sitio muestra "pago pendiente" hasta que Stripe avisa.

## 3. Instalar y correr
```bash
npm install
cp .env.example .env   # pon tu STRIPE_SECRET_KEY real
npm start
```
Abre http://localhost:3000

## 4. Webhook (obligatorio, es lo que confirma el pago real)
Local, con el CLI de Stripe:
```bash
stripe listen --forward-to localhost:3000/webhook
```
Copia el `whsec_...` que te da el comando a tu `.env`.

En producción: Dashboard > Developers > Webhooks > agrega tu URL pública
`https://tudominio.com/webhook`, escucha estos eventos:
- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`

## 5. Probar SIN cobrar de verdad
Con llaves `sk_test_...`, en la página de pago de Stripe usa:
- Tarjeta éxito: `4242 4242 4242 4242`, cualquier fecha futura, CVC 123
- Tarjeta rechazada: `4000 0000 0000 0002`
- Para OXXO en modo prueba, Stripe simula la confirmación unos segundos después de generarse el talón.

## 6. Cómo saber que SÍ es real
- El total que se cobra lo calcula el **servidor** (`ZONAS` en `server.js`),
  no el navegador — nadie puede manipular el precio abriendo la consola.
- El boleto solo se marca "pagado" cuando llega el webhook de Stripe, no
  cuando el usuario llena el formulario.
- Los datos de compra se guardan en `data/tickets.json` (base de datos simple
  de archivo). Para producción real con más de unas pocas ventas, cambia esto
  por una base de datos de verdad (Postgres, SQLite, etc.) — pregúntame y te
  la conecto.

## 7. Desplegar (subir a internet)
Necesitas un hosting que corra Node.js (Render, Railway, Fly.io, un VPS).
No sirve subir esto a un hosting solo-estático porque `server.js` necesita
ejecutarse. Cuando tengas dominio, ponlo en `APP_URL` de tu `.env`.
