const https = require('https');
const http  = require('http');
const { Pool } = require('pg');

const PORT         = process.env.PORT         || 3000;
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || '94e85cc0-e392-400e-b57e-e419788601c9';
const BEARER_TOKEN = process.env.BEARER_TOKEN || '';
const DATABASE_URL = process.env.DATABASE_URL || '';

// ─── BANCO DE DADOS ──────────────────────────────────────────────
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS checkins (
      id           BIGINT PRIMARY KEY,
      placa        VARCHAR(10) NOT NULL,
      modelo       TEXT,
      ano          VARCHAR(4),
      cor          TEXT,
      combustivel_tipo TEXT,
      km           VARCHAR(20),
      combustivel  VARCHAR(5),
      proprietario TEXT,
      telefone     TEXT,
      doc          TEXT,
      zones        JSONB,
      assinatura   TEXT,
      checkin_at   TEXT,
      checkout_at  TEXT,
      status       VARCHAR(20) DEFAULT 'checkin',
      operador     TEXT,
      created_at   TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('Banco de dados pronto');
}

// ─── CORS ────────────────────────────────────────────────────────
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

// ─── BODY PARSER ────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch(e) { reject(e); }
    });
  });
}

// ─── SERVIDOR ────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCORS(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  console.log(`${req.method} ${req.url}`);

  // Health check
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'oficina-proxy' }));
    return;
  }

  // ── CONSULTA PLACA ──────────────────────────────────────────
  const matchPlaca = req.url.match(/^\/placa\/([A-Z0-9]{7,8})$/i);
  if (matchPlaca) {
    const placa = matchPlaca[1].toUpperCase().replace('-', '');
    const body  = JSON.stringify({ placa });

    const options = {
      hostname: 'gateway.apibrasil.io',
      path: '/api/v2/vehicles/dados',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'DeviceToken': DEVICE_TOKEN,
        'Authorization': `Bearer ${BEARER_TOKEN}`,
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const apiReq = https.request(options, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        console.log(`API Brasil: ${apiRes.statusCode}`);
        res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(data);
      });
    });
    apiReq.setTimeout(15000, () => {
      apiReq.destroy();
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Timeout' }));
    });
    apiReq.on('error', e => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    apiReq.write(body);
    apiReq.end();
    return;
  }

  // ── SALVAR CHECK-IN ─────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/checkins') {
    try {
      const r = await readBody(req);
      await pool.query(`
        INSERT INTO checkins
          (id, placa, modelo, ano, cor, combustivel_tipo, km, combustivel,
           proprietario, telefone, doc, zones, assinatura,
           checkin_at, checkout_at, status, operador)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        ON CONFLICT (id) DO UPDATE SET
          checkout_at = EXCLUDED.checkout_at,
          status      = EXCLUDED.status
      `, [
        r.id, r.placa, r.modelo, r.ano, r.cor, r.combustivelTipo,
        r.km, r.combustivel, r.proprietario, r.telefone, r.doc,
        JSON.stringify(r.zones), r.assinatura,
        r.checkinAt, r.checkoutAt || null, r.status, r.operador
      ]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) {
      console.error('Erro ao salvar:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── LISTAR HISTÓRICO ────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/checkins') {
    try {
      const result = await pool.query(
        'SELECT * FROM checkins ORDER BY created_at DESC LIMIT 200'
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.rows));
    } catch(e) {
      console.error('Erro ao listar:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── ATUALIZAR CHECK-OUT ─────────────────────────────────────
  if (req.method === 'PUT' && req.url.match(/^\/checkins\/\d+\/checkout$/)) {
    try {
      const id = req.url.split('/')[2];
      const checkoutAt = new Date().toLocaleString('pt-BR');
      await pool.query(
        'UPDATE checkins SET status=$1, checkout_at=$2 WHERE id=$3',
        ['checkout', checkoutAt, id]
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, checkoutAt }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Rota não encontrada' }));
});

// ─── INICIALIZAR ─────────────────────────────────────────────────
initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Proxy rodando na porta ${PORT}`);
  });
}).catch(e => {
  console.error('Erro ao inicializar banco:', e.message);
  // Sobe o servidor mesmo sem banco para não derrubar o serviço
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Proxy rodando na porta ${PORT} (sem banco)`);
  });
});
