const https = require('https');
const http = require('http');

const PORT = process.env.PORT || 3000;
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || '94e85cc0-e392-400e-b57e-e419788601c9';
const BEARER_TOKEN = process.env.BEARER_TOKEN || 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJodHRwczovL2dhdGV3YXkuYXBpYnJhc2lsLmlvL2FwaS9vYXV0aC9leGNoYW5nZSIsImlhdCI6MTc3MDY2MTU3OSwiZXhwIjoxODAyMTk3NTc5LCJuYmYiOjE3NzA2NjE1NzksImp0aSI6Ikh0UGVtalRmSGYwdVNBeTkiLCJzdWIiOiI5ODI3IiwicHJ2IjoiMjNiZDVjODk0OWY2MDBhZGIzOWU3MDFjNDAwODcyZGI3YTU5NzZmNyIsInVzZXJfaWQiOjE2MzY0LCJlbWFpbCI6ImFydHVyLnVtYmVsaW5vQGFwaWJyYXNpbC5jb20uYnIifQ.vCDbwTogg_I7GDqZDRZ2V61rGzwlDJES0I1JKHG25ho';

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

const server = http.createServer((req, res) => {
  setCORS(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  console.log(`${req.method} ${req.url}`);

  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'oficina-proxy' }));
    return;
  }

  const match = req.url.match(/^\/placa\/([A-Z0-9]{7,8})$/i);
  if (!match) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Use /placa/ABC1234' }));
    return;
  }

  const placa = match[1].toUpperCase().replace('-', '');
  console.log(`Consultando placa: ${placa}`);

  const body = JSON.stringify({ placa: placa });

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
      console.log(`API Brasil status: ${apiRes.statusCode} — ${data.substring(0, 300)}`);
      res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
      res.end(data);
    });
  });

  apiReq.setTimeout(15000, () => {
    console.error('Timeout');
    apiReq.destroy();
    res.writeHead(504, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Timeout na consulta' }));
  });

  apiReq.on('error', (e) => {
    console.error('Erro:', e.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Erro ao conectar', detail: e.message }));
  });

  apiReq.write(body);
  apiReq.end();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Proxy rodando na porta ${PORT}`);
});
