const https   = require('https');
const http    = require('http');
const { Pool } = require('pg');
const crypto  = require('crypto');

const PORT         = process.env.PORT         || 3000;
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || '';
const BEARER_TOKEN = process.env.BEARER_TOKEN || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const AWS_ACCESS_KEY = process.env.AWS_ACCESS_KEY || '';
const AWS_SECRET_KEY = process.env.AWS_SECRET_KEY || '';
const AWS_REGION     = process.env.AWS_REGION     || 'sa-east-1';
const AWS_BUCKET     = process.env.AWS_BUCKET     || '';

// ─── BANCO ───────────────────────────────────────────────────────
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  await pool.query(`ALTER TABLE checkins ADD COLUMN IF NOT EXISTS assinatura_mec TEXT`).catch(()=>{});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS checkins (
      id               BIGINT PRIMARY KEY,
      placa            VARCHAR(10) NOT NULL,
      modelo           TEXT, ano VARCHAR(4), cor TEXT,
      combustivel_tipo TEXT, km VARCHAR(20), combustivel VARCHAR(5),
      proprietario     TEXT, telefone TEXT, doc TEXT,
      zones            JSONB, assinatura TEXT, assinatura_mec TEXT,
      checkin_at       TEXT, checkout_at TEXT,
      status           VARCHAR(20) DEFAULT 'checkin',
      operador         TEXT, created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('Banco pronto');
}

// ─── CORS ────────────────────────────────────────────────────────
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

// ─── BODY PARSER ─────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch(e) { reject(e); } });
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ─── AWS S3 UPLOAD (sem SDK, usando Signature V4) ────────────────
function hmac(key, data, enc) {
  return crypto.createHmac('sha256', key).update(data).digest(enc || undefined);
}
function hash(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function uploadS3(fileBuffer, fileName, contentType) {
  const bucket = AWS_BUCKET;
  const region = AWS_REGION;
  const host   = `${bucket}.s3.${region}.amazonaws.com`;
  const key    = `checkins/${fileName}`;

  const now    = new Date();
  const date   = now.toISOString().slice(0,10).replace(/-/g,'');
  const datetime = now.toISOString().replace(/[:-]/g,'').slice(0,15) + 'Z';

  const payloadHash = hash(fileBuffer);

  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${datetime}\n`;

  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [
    'PUT', `/${key}`, '',
    canonicalHeaders, signedHeaders, payloadHash
  ].join('\n');

  const credentialScope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', datetime, credentialScope, hash(canonicalRequest)
  ].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${AWS_SECRET_KEY}`, date), region), 's3'), 'aws4_request'
  );
  const signature = hmac(signingKey, stringToSign, 'hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${AWS_ACCESS_KEY}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: host,
      path: `/${key}`,
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Content-Length': fileBuffer.length,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': datetime,
        'Authorization': authorization,
        'x-amz-acl': 'public-read'
      }
    };
    const req = https.request(options, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(`https://${host}/${key}`);
        } else {
          reject(new Error(`S3 error ${res.statusCode}: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.write(fileBuffer);
    req.end();
  });
}

// ─── SERVIDOR ────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  console.log(`${req.method} ${req.url}`);

  // Health
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'oficina-proxy' }));
    return;
  }

  // ── UPLOAD FOTO → S3 ──────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/upload') {
    try {
      const contentType = req.headers['content-type'] || 'image/jpeg';
      const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
      const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
      const buffer = await readRawBody(req);
      const url = await uploadS3(buffer, fileName, contentType);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url }));
    } catch(e) {
      console.error('Upload S3 erro:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── CONSULTA PLACA ────────────────────────────────────────────
  const matchPlaca = req.url.match(/^\/placa\/([A-Z0-9]{7,8})$/i);
  if (matchPlaca) {
    const placa = matchPlaca[1].toUpperCase().replace('-','');
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
    const apiReq = https.request(options, apiRes => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => { res.writeHead(apiRes.statusCode, {'Content-Type':'application/json'}); res.end(data); });
    });
    apiReq.setTimeout(15000, () => { apiReq.destroy(); res.writeHead(504); res.end(JSON.stringify({error:'Timeout'})); });
    apiReq.on('error', e => { res.writeHead(502); res.end(JSON.stringify({error:e.message})); });
    apiReq.write(body); apiReq.end();
    return;
  }

  // ── SALVAR CHECK-IN ───────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/checkins') {
    try {
      const r = await readBody(req);
      await pool.query(`
        INSERT INTO checkins
          (id,placa,modelo,ano,cor,combustivel_tipo,km,combustivel,
           proprietario,telefone,doc,zones,assinatura,assinatura_mec,
           checkin_at,checkout_at,status,operador)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        ON CONFLICT (id) DO UPDATE SET
          checkout_at=EXCLUDED.checkout_at, status=EXCLUDED.status
      `, [
        r.id, r.placa, r.modelo, r.ano, r.cor, r.combustivelTipo,
        r.km, r.combustivel, r.proprietario, r.telefone, r.doc,
        JSON.stringify(r.zones), r.assinatura, r.assinaturaMec||null,
        r.checkinAt, r.checkoutAt||null, r.status, r.operador
      ]);
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true}));
    } catch(e) {
      console.error('Erro ao salvar:', e.message);
      res.writeHead(500, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error:e.message}));
    }
    return;
  }

  // ── LISTAR HISTÓRICO ──────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/checkins') {
    try {
      const result = await pool.query('SELECT * FROM checkins ORDER BY created_at DESC LIMIT 200');
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify(result.rows));
    } catch(e) {
      res.writeHead(500); res.end(JSON.stringify({error:e.message}));
    }
    return;
  }

  // ── CHECK-OUT ─────────────────────────────────────────────────
  if (req.method === 'PUT' && req.url.match(/^\/checkins\/\d+\/checkout$/)) {
    try {
      const id = req.url.split('/')[2];
      const checkoutAt = new Date().toLocaleString('pt-BR');
      await pool.query('UPDATE checkins SET status=$1,checkout_at=$2 WHERE id=$3', ['checkout',checkoutAt,id]);
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true,checkoutAt}));
    } catch(e) {
      res.writeHead(500); res.end(JSON.stringify({error:e.message}));
    }
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({error:'Rota não encontrada'}));
});

initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => console.log(`Proxy rodando na porta ${PORT}`));
}).catch(e => {
  console.error('Erro DB:', e.message);
  server.listen(PORT, '0.0.0.0', () => console.log(`Proxy rodando na porta ${PORT} (sem banco)`));
});
