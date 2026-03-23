/**
 * server.js — Lightweight Express proxy server for Webtoon Maker
 *
 * Solves the browser CORS restriction by routing Hugging Face API
 * calls through this server instead of making them directly from
 * the browser.
 *
 * Endpoints proxied:
 *   POST /api/hf/models/:org/:repo  →  https://api-inference.huggingface.co/models/:org/:repo
 *   GET  /api/hf/whoami-v2          →  https://huggingface.co/api/whoami-v2
 *
 * Usage:
 *   npm install
 *   node server.js          (default port 3000)
 *   PORT=8080 node server.js
 */

'use strict';

const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }));

// Serve all static files (HTML, CSS, JS, assets…)
app.use(express.static(path.join(__dirname)));

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Validate that the Authorization header looks like a Hugging Face token.
 * HF tokens start with "hf_" and are at least 30 characters long after
 * the "Bearer " prefix, e.g. "Bearer hf_XXXX…" (≥ 37 chars total).
 * This prevents proxy abuse from malformed or missing tokens.
 */
function requireHFToken(req, res) {
  const auth = (req.headers['authorization'] || '').trim();
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token.startsWith('hf_') || token.length < 30) {
    res.status(401).json({ error: 'En-tête Authorization invalide.' });
    return false;
  }
  return true;
}

// ── Proxy: image generation ──────────────────────────────────────────────────

app.post('/api/hf/models/*', async (req, res) => {
  if (!requireHFToken(req, res)) return;

  const modelPath = req.params[0];
  const targetUrl = `https://api-inference.huggingface.co/models/${modelPath}`;

  try {
    const hfRes = await fetch(targetUrl, {
      method:  'POST',
      headers: {
        'Authorization': req.headers['authorization'],
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(req.body),
    });

    const contentType = hfRes.headers.get('content-type') || 'application/octet-stream';
    res.status(hfRes.status).set('Content-Type', contentType);
    hfRes.body.pipe(res);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── Proxy: API-key validation ────────────────────────────────────────────────

app.get('/api/hf/whoami-v2', async (req, res) => {
  if (!requireHFToken(req, res)) return;

  try {
    const hfRes = await fetch('https://huggingface.co/api/whoami-v2', {
      headers: { 'Authorization': req.headers['authorization'] },
    });
    const data = await hfRes.json();
    res.status(hfRes.status).json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Webtoon Maker disponible sur http://localhost:${PORT}`);
});
