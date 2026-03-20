// ═══════════════════════════════════════════════════════════
//  JOSS DESIGN — Backend con Base de Datos PostgreSQL
//  Node.js + Express + pg
//
//  VARIABLES EN RAILWAY:
//    DATABASE_URL     → Railway lo pone automáticamente con PostgreSQL
//    IZIPAY_SHOP_ID   → 19131378
//    IZIPAY_PASSWORD  → prodpassword_4qOwaYvg...
//    IZIPAY_API_URL   → https://api.micuentaweb.pe
//    ADMIN_SECRET     → contraseña para endpoints admin (pon la que quieras)
// ═══════════════════════════════════════════════════════════

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use(cors());

// ── PostgreSQL pool ──────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ── Izipay config ────────────────────────────────────────────
const SHOP_ID      = process.env.IZIPAY_SHOP_ID  || '19131378';
const PASSWORD     = process.env.IZIPAY_PASSWORD || 'prodpassword_4qOwaYvgLvrBWaqp1ny8qBX3so9mxQJBXBAxlWsGKvzP5';
const API_URL      = process.env.IZIPAY_API_URL  || 'https://api.micuentaweb.pe';
const AUTH         = 'Basic ' + Buffer.from(SHOP_ID + ':' + PASSWORD).toString('base64');
const ADMIN_SECRET = process.env.ADMIN_SECRET    || 'jossdesign2025';

async function izipayPost(endpoint, body) {
  const res = await fetch(API_URL + endpoint, {
    method: 'POST',
    headers: { 'Authorization': AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

// ── Crear tablas ─────────────────────────────────────────────
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pending_orders (
        id         SERIAL PRIMARY KEY,
        email      TEXT NOT NULL,
        name       TEXT,
        pass_hash  TEXT NOT NULL,
        method     TEXT DEFAULT 'manual',
        order_id   TEXT UNIQUE NOT NULL,
        affiliate  TEXT,
        country    TEXT,
        phone      TEXT,
        status     TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS approved_users (
        id          SERIAL PRIMARY KEY,
        email       TEXT UNIQUE NOT NULL,
        name        TEXT,
        pass_hash   TEXT NOT NULL,
        method      TEXT,
        order_id    TEXT,
        affiliate   TEXT,
        approved_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS activity_log (
        id         SERIAL PRIMARY KEY,
        action     TEXT NOT NULL,
        type       TEXT DEFAULT 'lg',
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS config (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
      INSERT INTO config (key,value) VALUES ('price_txt','S/ 1.00') ON CONFLICT(key) DO NOTHING;
    `);
    console.log('✅ DB lista');
  } catch (e) { console.error('initDB error:', e.message); }
}

// ── Auth admin middleware ────────────────────────────────────
function adminOnly(req, res, next) {
  const s = req.headers['x-admin-secret'] || req.query.secret;
  if (s !== ADMIN_SECRET) return res.status(401).json({ error: 'No autorizado' });
  next();
}

async function log(action, type = 'lg') {
  try { await pool.query(`INSERT INTO activity_log(action,type) VALUES($1,$2)`, [action, type]); } catch {}
}

// ════════════════════════════════════════════════════════════
//  PÚBLICOS
// ════════════════════════════════════════════════════════════

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Joss Design Backend v2' }));

// ── POST /check-email ────────────────────────────────────────
//  Verifica si un correo ya tiene solicitud pendiente o acceso aprobado
//  Usado para bloquear registros duplicados
app.post('/check-email', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ status: 'error', error: 'Email requerido' });
  try {
    const approved = await pool.query(
      `SELECT 1 FROM approved_users WHERE email = $1`, [email]
    );
    if (approved.rows.length > 0) return res.json({ status: 'approved' });

    const pending = await pool.query(
      `SELECT 1 FROM pending_orders WHERE email = $1 AND status = 'pending'`, [email]
    );
    if (pending.rows.length > 0) return res.json({ status: 'pending' });

    res.json({ status: 'available' });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

// Guardar solicitud pendiente (Yape/Plin/PayPal/Izipay antes de redirigir)
app.post('/register-pending', async (req, res) => {
  const { email, name, passHash, method, orderId, affiliate, country, phone } = req.body;
  if (!email || !orderId || !passHash) return res.status(400).json({ error: 'Faltan campos' });
  try {
    await pool.query(
      `INSERT INTO pending_orders(email,name,pass_hash,method,order_id,affiliate,country,phone,status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending') ON CONFLICT(order_id) DO NOTHING`,
      [email, name||'', passHash, method||'manual', orderId, affiliate||null, country||null, phone||null]
    );
    await log(`Solicitud: ${email} via ${method||'manual'}`, 'lg');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Activar usuario automáticamente (Izipay pago confirmado)
app.post('/activate-user', async (req, res) => {
  const { email, name, passHash, method, orderId, affiliate } = req.body;
  if (!email || !passHash) return res.status(400).json({ error: 'Faltan campos' });
  try {
    await pool.query(
      `INSERT INTO approved_users(email,name,pass_hash,method,order_id,affiliate)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(email) DO UPDATE SET
         name=EXCLUDED.name, pass_hash=EXCLUDED.pass_hash,
         method=EXCLUDED.method, order_id=EXCLUDED.order_id, approved_at=NOW()`,
      [email, name||'', passHash, method||'izipay', orderId, affiliate||null]
    );
    await pool.query(`DELETE FROM pending_orders WHERE email=$1`, [email]);
    await log(`Acceso activado: ${email}`, 'lg');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Login de estudiante
app.post('/login', async (req, res) => {
  const { email, passHash } = req.body;
  if (!email || !passHash) return res.status(400).json({ error: 'Faltan campos' });
  try {
    const ok = await pool.query(
      `SELECT email,name,method,order_id FROM approved_users WHERE email=$1 AND pass_hash=$2`,
      [email, passHash]
    );
    if (ok.rows.length) return res.json({ status: 'approved', user: ok.rows[0] });

    const pend = await pool.query(
      `SELECT order_id FROM pending_orders WHERE email=$1 AND pass_hash=$2 AND status='pending'`,
      [email, passHash]
    );
    if (pend.rows.length) return res.json({ status: 'pending', order: pend.rows[0].order_id });

    const exists = await pool.query(
      `SELECT 1 FROM approved_users WHERE email=$1 UNION SELECT 1 FROM pending_orders WHERE email=$1`,
      [email]
    );
    if (exists.rows.length) return res.json({ status: 'wrong_password' });

    res.json({ status: 'not_found' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Config pública (precio)
app.get('/config', async (req, res) => {
  try {
    const r = await pool.query(`SELECT key,value FROM config`);
    const cfg = {};
    r.rows.forEach(row => { cfg[row.key] = row.value; });
    res.json(cfg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
//  ADMIN (requieren header: x-admin-secret)
// ════════════════════════════════════════════════════════════

app.get('/admin/pending', adminOnly, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, email, name, method, order_id, affiliate, country, phone,
              to_char(created_at AT TIME ZONE 'America/Lima','DD/MM/YYYY HH24:MI') as date
       FROM pending_orders WHERE status='pending' ORDER BY created_at DESC`
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/users', adminOnly, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT email, name, method, order_id, affiliate,
              to_char(approved_at AT TIME ZONE 'America/Lima','DD/MM/YYYY') as approved_at
       FROM approved_users ORDER BY approved_at DESC`
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/log', adminOnly, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT action, type, to_char(created_at AT TIME ZONE 'America/Lima','HH24:MI') as time
       FROM activity_log ORDER BY created_at DESC LIMIT 30`
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/approve', adminOnly, async (req, res) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'orderId requerido' });
  try {
    const r = await pool.query(
      `SELECT * FROM pending_orders WHERE order_id=$1 AND status='pending'`, [orderId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Orden no encontrada' });
    const p = r.rows[0];
    await pool.query(
      `INSERT INTO approved_users(email,name,pass_hash,method,order_id,affiliate)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(email) DO UPDATE SET
         pass_hash=EXCLUDED.pass_hash, method=EXCLUDED.method,
         order_id=EXCLUDED.order_id, approved_at=NOW()`,
      [p.email, p.name, p.pass_hash, p.method, p.order_id, p.affiliate]
    );
    await pool.query(`DELETE FROM pending_orders WHERE order_id=$1`, [orderId]);
    await log(`Aprobado: ${p.email} (${orderId})`, 'lg');
    res.json({ success: true, email: p.email });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/reject', adminOnly, async (req, res) => {
  const { orderId } = req.body;
  try {
    const r = await pool.query(`SELECT email FROM pending_orders WHERE order_id=$1`, [orderId]);
    await pool.query(`DELETE FROM pending_orders WHERE order_id=$1`, [orderId]);
    await log(`Rechazado: ${r.rows[0]?.email || orderId}`, 'lr');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/revoke', adminOnly, async (req, res) => {
  const { email } = req.body;
  try {
    await pool.query(`DELETE FROM approved_users WHERE email=$1`, [email]);
    await log(`Revocado: ${email}`, 'lr');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/add-user', adminOnly, async (req, res) => {
  const { email, passHash, name } = req.body;
  if (!email || !passHash) return res.status(400).json({ error: 'Faltan campos' });
  try {
    await pool.query(
      `INSERT INTO approved_users(email,name,pass_hash,method,order_id)
       VALUES($1,$2,$3,'manual','MANUAL')
       ON CONFLICT(email) DO UPDATE SET pass_hash=EXCLUDED.pass_hash, name=EXCLUDED.name, approved_at=NOW()`,
      [email, name||email, passHash]
    );
    await pool.query(`DELETE FROM pending_orders WHERE email=$1`, [email]);
    await log(`Usuario manual: ${email}`, 'lg');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/admin/config', adminOnly, async (req, res) => {
  const { key, value } = req.body;
  try {
    await pool.query(
      `INSERT INTO config(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2`,
      [key, value]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Izipay create-payment ────────────────────────────────────
app.post('/create-payment', async (req, res) => {
  const { amount, currency='PEN', orderId, customer, returnUrl, cancelUrl } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Monto inválido' });
  try {
    const payload = {
      amount, currency, orderId,
      customer: {
        email     : customer?.email     || '',
        firstName : customer?.firstName || '',
        lastName  : customer?.lastName  || ''
      }
    };
    // Si vienen URLs de retorno, incluirlas para el hosted checkout
    if (returnUrl) payload.vads_return_url = returnUrl;
    if (cancelUrl) payload.vads_cancel_url = cancelUrl;

    const data = await izipayPost('/api-payment/V4/Charge/CreatePayment', payload);

    if (data.status === 'SUCCESS' && data.answer?.formToken) {
      return res.json({
        formToken : data.answer.formToken,
        // URL directa del hosted checkout de Izipay
        checkoutUrl: `https://secure.micuentaweb.pe/vads-payment/?kr-form-token=${encodeURIComponent(data.answer.formToken)}`
      });
    }
    console.error('Izipay error:', JSON.stringify(data));
    return res.status(500).json({ error: data.answer?.errorMessage || 'Error Izipay: ' + data.status });
  } catch (e) {
    console.error('create-payment exception:', e);
    return res.status(500).json({ error: e.message });
  }
});

// ── IPN — Izipay notifica el pago aquí ──────────────────────
// Configurar en Back Office → Configuración → Reglas de notificaciones
// URL: https://josb-design-production.up.railway.app/ipn
app.post('/ipn', async (req, res) => {
  console.log('IPN recibido:', JSON.stringify(req.body));
  const orderStatus = req.body?.vads_trans_status || req.body?.orderStatus;
  const orderId     = req.body?.vads_order_id     || req.body?.orderId;
  // Si el pago fue aprobado, activar automáticamente
  if ((orderStatus === 'AUTHORISED' || orderStatus === 'CAPTURED') && orderId) {
    try {
      const r = await pool.query(
        `SELECT * FROM pending_orders WHERE order_id = $1`, [orderId]
      );
      if (r.rows.length > 0) {
        const p = r.rows[0];
        await pool.query(
          `INSERT INTO approved_users(email,name,pass_hash,method,order_id,affiliate)
           VALUES($1,$2,$3,'izipay',$4,$5)
           ON CONFLICT(email) DO UPDATE SET
             pass_hash=EXCLUDED.pass_hash, method=EXCLUDED.method,
             order_id=EXCLUDED.order_id, approved_at=NOW()`,
          [p.email, p.name, p.pass_hash, p.order_id, p.affiliate]
        );
        await pool.query(`DELETE FROM pending_orders WHERE order_id=$1`, [orderId]);
        await log(`Pago IPN aprobado: ${p.email} (${orderId})`, 'lg');
        console.log('✅ Acceso activado automáticamente:', p.email);
      }
    } catch(e) { console.error('IPN DB error:', e); }
  }
  res.sendStatus(200);
});

// ── Start ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ Backend en puerto ${PORT}`);
  await initDB();
});