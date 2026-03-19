const https = require('https');
const http = require('http');

const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_BRASIL_TOKEN || '94e85cc0-e392-400e-b57e-e419788601c9';

const server = http.createServer((req, res) => {
  // CORS — permite chamada do Netlify
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Health check
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({status:'ok', service:'oficina-proxy'}));
    return;
  }

  // Rota: GET /placa/:placa
  const match = req.url.match(/^\/placa\/([A-Z0-9]{7,8})$/i);
  if (!match) {
    res.writeHead(404, {'Content-Type':'application/json'});
    res.end(JSON.stringify({error:'Rota não encontrada. Use /placa/ABC1234'}));
    return;
  }

  const placa = match[1].toUpperCase();
  console.log(`[${new Date().toISOString()}] Consultando placa: ${placa}`);

  const options = {
    hostname: 'gateway.apibrasil.io',
    path: `/api/v2/vehicles/dados/placa/${placa}`,
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'DeviceToken': API_TOKEN,
      'Content-Type': 'application/json'
    }
  };

  const apiReq = https.request(options, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      res.writeHead(apiRes.statusCode, {'Content-Type':'application/json'});
      res.end(data);
    });
  });

  apiReq.on('error', (e) => {
    console.error('Erro na API Brasil:', e.message);
    res.writeHead(502, {'Content-Type':'application/json'});
    res.end(JSON.stringify({error:'Erro ao conectar com a API Brasil', detail: e.message}));
  });

  apiReq.end();
});

server.listen(PORT, () => {
  console.log(`Proxy rodando na porta ${PORT}`);
});
