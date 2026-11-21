#!/usr/bin/env node
'use strict';

// Servidor del sitio: sirve los archivos estáticos del proyecto y expone
// POST /api/generate, que convierte un texto en una imagen usando la API de
// imágenes de OpenAI. Sin dependencias externas.

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.SOURCE_ROOT || __dirname;
const PORT = Number(process.env.PORT || 3000);
const SKIP = new Set(['.git', 'node_modules']);

// Modelo de imágenes de OpenAI. Se puede cambiar con OPENAI_IMAGE_MODEL si la
// cuenta tiene acceso a otro modelo (gpt-image-1-mini, gpt-image-2, ...).
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1.5';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

const RELOAD_CLIENT = [
  '<script>',
  '(function () {',
  '  var current = null;',
  '  function poll() {',
  "    fetch('/__reload', { cache: 'no-store' })",
  '      .then(function (r) { return r.text(); })',
  '      .then(function (v) {',
  '        if (current !== null && v !== current) { location.reload(); return; }',
  '        current = v;',
  '        setTimeout(poll, 800);',
  '      })',
  '      .catch(function () { setTimeout(poll, 1500); });',
  '  }',
  '  poll();',
  '})();',
  '</script>',
].join('\n');

function newestMtime(dir) {
  let newest = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return newest;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full));
      else newest = Math.max(newest, fs.statSync(full).mtimeMs);
    } catch (err) {
      /* archivo desaparecido a mitad del recorrido: se ignora */
    }
  }
  return newest;
}

function send(res, status, type, body) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(payload));
}

function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > limit) {
        reject(new Error('too-large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error('invalid-json'));
      }
    });
    req.on('error', reject);
  });
}

async function handleGenerate(req, res) {
  let body;
  try {
    body = await readJsonBody(req, 10000);
  } catch (err) {
    const message =
      err.message === 'too-large' ? 'El texto es demasiado largo.' : 'La solicitud no es válida.';
    sendJson(res, 400, { error: message });
    return;
  }

  const prompt = String(body.prompt || '').trim();
  if (!prompt) {
    sendJson(res, 400, { error: 'Escribe una descripción para generar la imagen.' });
    return;
  }
  if (prompt.length > 2000) {
    sendJson(res, 400, { error: 'La descripción no puede pasar de 2000 caracteres.' });
    return;
  }

  // Algunos almacenes de secretos entregan el valor con comillas literales.
  const apiKey = String(process.env.OPENAI_API_KEY || '')
    .trim()
    .replace(/^["']+|["']+$/g, '');
  if (!apiKey) {
    sendJson(res, 500, { error: 'Falta configurar la clave de OpenAI (OPENAI_API_KEY).' });
    return;
  }

  let upstream;
  try {
    upstream = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: IMAGE_MODEL,
        prompt,
        n: 1,
        size: '1024x1024',
      }),
      signal: AbortSignal.timeout(120000),
    });
  } catch (err) {
    sendJson(res, 502, { error: 'No se pudo conectar con OpenAI. Inténtalo de nuevo.' });
    return;
  }

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    const message = (data && data.error && data.error.message) || `OpenAI respondió ${upstream.status}.`;
    sendJson(res, 502, { error: message });
    return;
  }

  const item = (data.data && data.data[0]) || {};
  const image = item.b64_json ? `data:image/png;base64,${item.b64_json}` : item.url;
  if (!image) {
    sendJson(res, 502, { error: 'OpenAI no devolvió ninguna imagen.' });
    return;
  }

  sendJson(res, 200, { image, prompt });
}

const server = http.createServer((req, res) => {
  let urlPath = '/';
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
  } catch (err) {
    send(res, 400, 'text/plain; charset=utf-8', 'Bad request');
    return;
  }

  if (urlPath === '/api/generate') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Método no permitido.' });
      return;
    }
    handleGenerate(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'Error inesperado al generar la imagen.' });
    });
    return;
  }

  if (urlPath === '/__reload') {
    send(res, 200, 'text/plain; charset=utf-8', String(newestMtime(ROOT)));
    return;
  }

  let filePath = path.join(ROOT, path.normalize(urlPath));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    send(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
    return;
  }

  try {
    if (fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch (err) {
    send(res, 404, 'text/plain; charset=utf-8', 'Not found');
    return;
  }

  let body;
  try {
    body = fs.readFileSync(filePath);
  } catch (err) {
    send(res, 404, 'text/plain; charset=utf-8', 'Not found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';

  if (ext === '.html' || ext === '.htm') {
    const html = body.toString('utf8');
    const injected = /<\/body>/i.test(html)
      ? html.replace(/<\/body>/i, RELOAD_CLIENT + '\n</body>')
      : html + '\n' + RELOAD_CLIENT;
    send(res, 200, type, injected);
    return;
  }

  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-length': body.length });
  res.end(body);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('serving ' + ROOT + ' on http://0.0.0.0:' + PORT + ' (live reload enabled)');
});
