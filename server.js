const https = require('https');
const http = require('http');

const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_BRASIL_TOKEN || '94e85cc0-e392-400e-b57e-e419788601c9';

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

  // Health check
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'oficina-proxy' }));
    return;
  }

  // /placa/ABC1234
  const match = req.url.match(/^\/placa\/([A-Z0-9]{7,8})$/i);
  if (!match) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Use /placa/ABC1234' }));
    return;
  }

  const placa = match[1].toUpperCase().replace('-', '');
  console.log(`Consultando placa: ${placa}`);

  // API Brasil usa POST com body JSON
  const body = JSON.stringify({ placa: placa });

  const options = {
    hostname: 'gateway.apibrasil.io',
    path: '/api/v2/vehicles/dados',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'DeviceToken': API_TOKEN,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  };

  const apiReq = https.request(options, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      console.log(`API Brasil respondeu: ${apiRes.statusCode} — ${data.substring(0, 200)}`);
      res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
      res.end(data);
    });
  });

  apiReq.setTimeout(15000, () => {
    console.error('Timeout na API Brasil');
    apiReq.destroy();
    res.writeHead(504, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Timeout na consulta da placa' }));
  });

  apiReq.on('error', (e) => {
    console.error('Erro:', e.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Erro ao conectar com API Brasil', detail: e.message }));
  });

  apiReq.write(body);
  apiReq.end();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Proxy rodando na porta ${PORT}`);
});
