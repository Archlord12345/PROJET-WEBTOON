/**
 * huggingface.js — Hugging Face Inference API integration
 * Supports text-to-image models (FLUX, SDXL, SD 1.5, etc.)
 */

const HuggingFace = (() => {
  // Requests go through the local proxy server (/api/hf/models/…) so that
  // the browser never contacts api-inference.huggingface.co directly and
  // avoids the CORS preflight rejection.
  const BASE_URL = '/api/hf/models';

  /**
   * Generate an image from a text prompt.
   * @param {string} apiKey        - HF API token (hf_...)
   * @param {string} model         - Model repo (e.g. "black-forest-labs/FLUX.1-schnell")
   * @param {string} prompt        - Text prompt
   * @param {object} [options]     - Optional generation parameters
   * @param {Function} [onProgress]- Progress callback (0–100)
   * @returns {Promise<string>}    - Object URL of the generated image blob
   */
  async function generateImage(apiKey, model, prompt, options = {}, onProgress) {
    if (!apiKey) throw new Error('Clé API Hugging Face manquante.');
    if (!prompt || !prompt.trim()) throw new Error('Le prompt ne peut pas être vide.');

    const url = `${BASE_URL}/${model}`;

    const body = {
      inputs: prompt,
      parameters: {
        num_inference_steps: options.steps ?? 20,
        guidance_scale:      options.guidance ?? 7.5,
        width:               options.width  ?? 512,
        height:              options.height ?? 768,
        ...options.extra,
      },
    };

    if (onProgress) onProgress(10);

    let response = await fetch(url, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(body),
    });

    // Handle model loading (503 with estimated_time)
    let retries = 0;
    while (response.status === 503 && retries < 10) {
      const json = await response.json().catch(() => ({}));
      const wait = (json.estimated_time ?? 10) * 1000;
      if (onProgress) onProgress(10 + retries * 5);
      await delay(Math.min(wait, 20000));
      retries++;
      response = await fetch(url, {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify(body),
      });
    }

    if (!response.ok) {
      let msg = `Erreur ${response.status}`;
      try {
        const err = await response.json();
        msg = err.error ?? msg;
      } catch (_) { /* ignore */ }
      throw new Error(msg);
    }

    if (onProgress) onProgress(90);

    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) {
      throw new Error('La réponse ne contient pas une image valide.');
    }

    if (onProgress) onProgress(100);
    return URL.createObjectURL(blob);
  }

  /**
   * Validate an API key by hitting the whoami endpoint.
   * @param {string} apiKey
   * @returns {Promise<{valid: boolean, username?: string, error?: string}>}
   */
  async function validateKey(apiKey) {
    try {
      const res = await fetch('/api/hf/whoami-v2', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) {
        const data = await res.json();
        return { valid: true, username: data.name };
      }
      return { valid: false, error: `HTTP ${res.status}` };
    } catch (e) {
      return { valid: false, error: e.message };
    }
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  return { generateImage, validateKey };
})();
