require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const Stripe = require('stripe');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const DB_FILE = path.join(__dirname, 'data', 'tickets.json');
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

// Aseguramos que la carpeta data/ exista (GitHub no sube carpetas vacías)
if (!fs.existsSync(path.dirname(DB_FILE))) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
}

// Zonas y precios REALES definidos en el servidor.
// Nunca confiamos en el precio que manda el navegador: así nadie puede pagar $1 por un asiento de $2,400.
const ZONAS = {
  ringside: { nombre: '1ª Fila Ring Side', precio: 2400 },
  general: { nombre: 'Ring General', precio: 1200 },
  balcon: { nombre: 'Balcón', precio: 650 },
  gradas: { nombre: 'Gradas', precio: 350 },
};

function leerDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; }
}
function guardarDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// El webhook necesita el body crudo -> va ANTES de express.json()
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook inválido:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const confirmarPago = (sessionId, paymentIntentId) => {
    const db = leerDB();
    const ticket = db[sessionId];
    if (ticket && !ticket.pagado) {
      ticket.pagado = true;
      ticket.payment_intent = paymentIntentId;
      guardarDB(db);
      console.log(`✅ Pago confirmado, boleto ${ticket.code}`);
    }
  };

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    // Tarjeta: se paga al instante en este evento.
    if (session.payment_status === 'paid') {
      confirmarPago(session.id, session.payment_intent);
    }
  }

  if (event.type === 'checkout.session.async_payment_succeeded') {
    // OXXO / transferencias: se confirman más tarde, aquí llega el aviso real.
    const session = event.data.object;
    confirmarPago(session.id, session.payment_intent);
  }

  if (event.type === 'checkout.session.async_payment_failed') {
    const session = event.data.object;
    const db = leerDB();
    if (db[session.id]) { db[session.id].fallo = true; guardarDB(db); }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Crear la sesión de pago (tarjeta / OXXO / lo que tengas habilitado en tu Dashboard de Stripe)
app.post('/api/crear-sesion', async (req, res) => {
  try {
    const { name, email, zone, seats } = req.body;
    const zonaInfo = ZONAS[zone];
    if (!zonaInfo) return res.status(400).json({ error: 'Zona inválida' });
    if (!Array.isArray(seats) || seats.length < 1 || seats.length > 6) {
      return res.status(400).json({ error: 'Selecciona entre 1 y 6 asientos' });
    }
    if (!name || !email) return res.status(400).json({ error: 'Faltan nombre o correo' });

    const total = zonaInfo.precio * seats.length;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      currency: 'mxn',
      customer_email: email,
      line_items: [{
        price_data: {
          currency: 'mxn',
          product_data: {
            name: `Mucha Lucha Chimal · ${zonaInfo.nombre}`,
            description: `Asientos: ${seats.join(', ')}`,
          },
          unit_amount: zonaInfo.precio * 100, // Stripe usa centavos
        },
        quantity: seats.length,
      }],
      success_url: `${APP_URL}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/`,
      metadata: { name, email, zone, zoneName: zonaInfo.nombre, seats: seats.join(',') },
    });

    // Pre-registramos el boleto como "no pagado" hasta que el webhook confirme
    const db = leerDB();
    db[session.id] = {
      code: 'MLC-' + Date.now().toString(36).toUpperCase(),
      name, email, zone: zonaInfo.nombre, seats, total,
      pagado: false,
      usado: false,
      usado_en: null,
    };
    guardarDB(db);

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo iniciar el pago' });
  }
});

// El frontend consulta aquí si ya se confirmó el pago (nunca confía solo en la redirección)
app.get('/api/boleto/:sessionId', async (req, res) => {
  try {
    const db = leerDB();
    const ticket = db[req.params.sessionId];
    if (!ticket) return res.status(404).json({ estado: 'no_encontrado' });

    if (ticket.pagado) {
      return res.json({ estado: 'pagado', ticket });
    }

    // Puede que el webhook aún no llegue; consultamos directo a Stripe como respaldo
    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId, { expand: ['payment_intent'] });
    if (session.payment_status === 'paid') {
      ticket.pagado = true;
      guardarDB(db);
      return res.json({ estado: 'pagado', ticket });
    }
    if (ticket.fallo) return res.json({ estado: 'fallido' });

    const pi = session.payment_intent;
    const voucherUrl = pi?.next_action?.oxxo_display_details?.hosted_voucher_url;
    res.json({ estado: 'pendiente', voucher_url: voucherUrl || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ estado: 'error' });
  }
});

// Esta página se abre al escanear el QR del boleto (con el celular del staff en la puerta).
// Primer escaneo: marca el boleto como usado y muestra "Válido". Segundo escaneo: avisa que ya entró.
app.get('/verificar/:code', (req, res) => {
  const db = leerDB();
  const entrada = Object.values(db).find(t => t.code === req.params.code);

  const pagina = (titulo, color, detalle) => `<!doctype html><html lang="es"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Verificación de boleto</title>
    <style>body{font-family:sans-serif;background:#12131a;color:#fff;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:20px;text-align:center}
    .card{background:#1e1f27;border-radius:18px;padding:32px;max-width:380px;width:100%}
    h1{font-size:26px;color:${color};margin:0 0 10px}p{color:#98a0b5;line-height:1.5}</style></head>
    <body><div class="card"><h1>${titulo}</h1><p>${detalle}</p></div></body></html>`;

  if (!entrada || !entrada.pagado) {
    return res.status(404).send(pagina('❌ Boleto no válido', '#ff1744', 'Este código no corresponde a un boleto pagado.'));
  }

  if (entrada.usado) {
    return res.send(pagina('⚠️ Ya fue usado', '#ffb800', `Este boleto ya entró el ${new Date(entrada.usado_en).toLocaleString('es-MX')}. Titular: ${entrada.name}.`));
  }

  entrada.usado = true;
  entrada.usado_en = new Date().toISOString();
  guardarDB(db);
  res.send(pagina('✅ Boleto válido', '#66f2a0', `${entrada.name} · ${entrada.zone} · Asientos: ${entrada.seats.join(', ')}. Acceso registrado.`));
});

// Cobro en efectivo (staff en taquilla): no pasa por Stripe, pero requiere la clave del servidor.
// La clave vive en .env, nunca en el código del navegador, así no se puede ver con "Inspeccionar".
app.post('/api/pago-efectivo', (req, res) => {
  try {
    const { name, email, zone, seats, clave } = req.body;

    if (clave !== process.env.STAFF_CASH_CODE) {
      return res.status(401).json({ error: 'Clave incorrecta' });
    }

    const zonaInfo = ZONAS[zone];
    if (!zonaInfo) return res.status(400).json({ error: 'Zona inválida' });
    if (!Array.isArray(seats) || seats.length < 1 || seats.length > 6) {
      return res.status(400).json({ error: 'Selecciona entre 1 y 6 asientos' });
    }
    if (!name || !email) return res.status(400).json({ error: 'Faltan nombre o correo' });

    const total = zonaInfo.precio * seats.length;
    const ticket = {
      code: 'MLC-' + Date.now().toString(36).toUpperCase(),
      name, email, zone: zonaInfo.nombre, seats, total,
      pagado: true,
      metodo: 'efectivo',
      usado: false,
      usado_en: null,
    };

    const db = leerDB();
    db['efectivo_' + ticket.code] = ticket;
    guardarDB(db);

    res.json({ ticket });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo generar el boleto' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mucha Lucha Chimal escuchando en ${APP_URL}`));
