/**
 * app.js — Webtoon Maker core application
 * Manages panels, generation queue, settings persistence, export, and UI state.
 */

/* ════════════════════════════════════════════════
   STATE
════════════════════════════════════════════════ */
const State = (() => {
  const defaults = {
    title:       'Mon Webtoon',
    panels:      [],
    settings: {
      hfApiKey:       '',
      googleClientId: '',
      canvasWidth:    800,
      panelGap:       16,
      bgColor:        '#ffffff',
    },
    driveFileId: null,
  };

  let _state = deepClone(defaults);

  function get()          { return _state; }
  function getSettings()  { return _state.settings; }
  function getPanels()    { return _state.panels; }

  function updateSettings(patch) {
    Object.assign(_state.settings, patch);
    _persist();
  }

  function setDriveFileId(id) {
    _state.driveFileId = id;
    _persist();
  }

  function addPanel(panel) {
    _state.panels.push(panel);
    _persist();
  }

  function updatePanel(id, patch) {
    const p = _state.panels.find(p => p.id === id);
    if (p) { Object.assign(p, patch); _persist(); }
  }

  function deletePanel(id) {
    _state.panels = _state.panels.filter(p => p.id !== id);
    _persist();
  }

  function reorderPanels(panels) {
    _state.panels = panels;
    _persist();
  }

  function loadProject(project) {
    _state = { ...deepClone(defaults), ...project };
    _persist();
  }

  function newProject() {
    _state = deepClone(defaults);
    _persist();
  }

  function toJSON() {
    return deepClone(_state);
  }

  /** Persist settings to localStorage (panels excluded from settings key). */
  function _persist() {
    try {
      localStorage.setItem('wm_settings', JSON.stringify(_state.settings));
    } catch (_) { /* storage full or blocked */ }
  }

  /** Load persisted settings on startup. */
  function loadFromStorage() {
    try {
      const raw = localStorage.getItem('wm_settings');
      if (raw) Object.assign(_state.settings, JSON.parse(raw));
    } catch (_) { /* ignore */ }

    // config.js values are always authoritative — they override anything in localStorage
    const cfg = window.APP_CONFIG || {};
    if (cfg.HF_API_KEY)       _state.settings.hfApiKey       = cfg.HF_API_KEY;
    if (cfg.GOOGLE_CLIENT_ID) _state.settings.googleClientId = cfg.GOOGLE_CLIENT_ID;

    // Persist immediately so the keys are available on the next visit
    _persist();
  }

  return {
    get, getSettings, getPanels,
    updateSettings, setDriveFileId,
    addPanel, updatePanel, deletePanel, reorderPanels,
    loadProject, newProject, toJSON, loadFromStorage,
  };
})();

/* ════════════════════════════════════════════════
   HELPERS
════════════════════════════════════════════════ */
function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function createPanelData(overrides = {}) {
  return {
    id:             uid(),
    imageUrl:       '',
    imageBlobUrl:   '',
    prompt:         '',
    caption:        '',
    captionPos:     'bottom',
    size:           'full',
    model:          'black-forest-labs/FLUX.1-schnell',
    ...overrides,
  };
}

/* ════════════════════════════════════════════════
   TOAST
════════════════════════════════════════════════ */
const Toast = (() => {
  const container = () => document.getElementById('toast-container');

  function show(message, type = 'info', duration = 3500) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    container().appendChild(el);

    setTimeout(() => {
      el.style.animation = 'toast-out .25s ease forwards';
      setTimeout(() => el.remove(), 280);
    }, duration);
  }

  return { show };
})();

/* ════════════════════════════════════════════════
   PANEL RENDERER
════════════════════════════════════════════════ */
const PanelRenderer = (() => {
  let _activeId = null;

  function render() {
    const panels   = State.getPanels();
    const canvas   = document.getElementById('webtoon-canvas');
    const placeholder = document.getElementById('canvas-placeholder');
    const list     = document.getElementById('panel-list');
    const settings = State.getSettings();

    // Apply canvas-level settings
    canvas.style.width = `${settings.canvasWidth}px`;
    canvas.style.gap   = `${settings.panelGap}px`;
    canvas.style.background = settings.bgColor;

    // Show/hide placeholder
    placeholder.style.display = panels.length === 0 ? 'flex' : 'none';

    // ── Render sidebar thumbnails ──
    list.innerHTML = '';
    panels.forEach((panel, idx) => {
      const li  = document.createElement('li');
      li.className = 'panel-thumb' + (panel.id === _activeId ? ' active' : '');
      li.dataset.id = panel.id;

      const imgSrc = panel.imageBlobUrl || panel.imageUrl;
      const imgEl = imgSrc
        ? `<img class="panel-thumb-img" src="${imgSrc}" alt="Panneau ${idx + 1}" />`
        : `<div class="panel-thumb-img placeholder">🖼</div>`;

      li.innerHTML = `
        ${imgEl}
        <div class="panel-thumb-info">
          <div class="panel-thumb-title">Panneau ${idx + 1}</div>
          <div class="panel-thumb-sub">${panel.caption ? panel.caption.slice(0, 28) + (panel.caption.length > 28 ? '…' : '') : panel.size}</div>
        </div>
        <span class="panel-thumb-drag" title="Déplacer">⠿</span>
      `;

      li.addEventListener('click', () => setActivePanel(panel.id));
      list.appendChild(li);
    });

    // ── Render canvas cards ──
    // Remove existing cards (keep placeholder)
    Array.from(canvas.querySelectorAll('.panel-card, .panel-row')).forEach(el => el.remove());

    // Group panels into rows for layout
    const rows = buildRows(panels);
    rows.forEach(row => {
      if (row.length === 1) {
        canvas.appendChild(buildCard(row[0]));
      } else {
        const rowEl = document.createElement('div');
        rowEl.className = 'panel-row';
        row.forEach(p => rowEl.appendChild(buildCard(p)));
        canvas.appendChild(rowEl);
      }
    });
  }

  /** Group consecutive half/third panels into rows. */
  function buildRows(panels) {
    const rows = [];
    let i = 0;
    while (i < panels.length) {
      const p = panels[i];
      if (p.size === 'full') {
        rows.push([p]);
        i++;
      } else {
        // Collect adjacent non-full panels up to 2 (half) or 3 (third)
        const row = [p];
        const max = p.size === 'half' ? 2 : 3;
        while (row.length < max && i + row.length < panels.length && panels[i + row.length].size === p.size) {
          row.push(panels[i + row.length]);
        }
        rows.push(row);
        i += row.length;
      }
    }
    return rows;
  }

  function buildCard(panel) {
    const card = document.createElement('div');
    card.className = `panel-card size-${panel.size}${panel.id === _activeId ? ' active' : ''}`;
    card.dataset.id = panel.id;

    const imgSrc = panel.imageBlobUrl || panel.imageUrl;

    let imgHtml = '';
    if (imgSrc) {
      imgHtml = `<img class="panel-card-img" src="${imgSrc}" alt="" />`;
    } else {
      imgHtml = `<div class="panel-card-img" style="height:220px;display:flex;align-items:center;justify-content:center;background:#eee;font-size:2rem;">🖼</div>`;
    }

    let captionHtml = '';
    if (panel.caption && panel.captionPos !== 'none') {
      captionHtml = `<div class="panel-card-caption pos-${panel.captionPos}">${escapeHtml(panel.caption)}</div>`;
    }

    if (panel.captionPos === 'top') {
      card.innerHTML = captionHtml + imgHtml;
    } else {
      card.innerHTML = imgHtml + captionHtml;
    }

    card.addEventListener('click', () => setActivePanel(panel.id));
    return card;
  }

  function setActivePanel(id) {
    _activeId = id;
    render();
    EditorPanel.open(id);
  }

  function getActiveId() { return _activeId; }
  function clearActive()  { _activeId = null; }

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/\n/g, '<br/>');
  }

  return { render, setActivePanel, getActiveId, clearActive };
})();

/* ════════════════════════════════════════════════
   EDITOR PANEL
════════════════════════════════════════════════ */
const EditorPanel = (() => {
  const editorEmpty = () => document.getElementById('editor-empty');
  const editorForm  = () => document.getElementById('editor-form');

  function open(panelId) {
    const panel = State.getPanels().find(p => p.id === panelId);
    if (!panel) { close(); return; }

    editorEmpty().classList.add('hidden');
    editorForm().classList.remove('hidden');

    // Populate fields
    document.getElementById('panel-prompt').value        = panel.prompt      || '';
    document.getElementById('panel-caption').value       = panel.caption     || '';
    document.getElementById('caption-position').value    = panel.captionPos  || 'bottom';
    document.getElementById('hf-model-select').value     = panel.model       || 'black-forest-labs/FLUX.1-schnell';
    document.getElementById('panel-image-url').value     = panel.imageUrl    || '';

    // Size buttons
    document.querySelectorAll('.size-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.size === (panel.size || 'full'));
    });
  }

  function close() {
    editorEmpty().classList.remove('hidden');
    editorForm().classList.add('hidden');
  }

  return { open, close };
})();

/* ════════════════════════════════════════════════
   GENERATION QUEUE
════════════════════════════════════════════════ */
const GenerationQueue = (() => {
  let _running = false;

  async function generate(panelId) {
    if (_running) { Toast.show('Une génération est déjà en cours…', 'warning'); return; }
    _running = true;

    const panel    = State.getPanels().find(p => p.id === panelId);
    const settings = State.getSettings();

    if (!settings.hfApiKey) {
      Toast.show('Configurez votre clé API Hugging Face dans ⚙ Paramètres.', 'error');
      _running = false;
      return;
    }

    if (!panel) { _running = false; return; }

    // Build final prompt with style
    const styleChip = document.querySelector('.chip.active');
    const style = styleChip?.dataset.style || '';
    const fullPrompt = [panel.prompt, style].filter(Boolean).join(', ');

    if (!fullPrompt.trim()) {
      Toast.show('Entrez un prompt avant de générer.', 'warning');
      _running = false;
      return;
    }

    // Update model from current selection
    const model = document.getElementById('hf-model-select').value;
    State.updatePanel(panelId, { model });

    // Show progress
    const progressBar = document.getElementById('gen-progress');
    const fill        = document.getElementById('gen-fill');
    const statusLabel = document.getElementById('gen-status');
    progressBar.classList.remove('hidden');

    // Show spinner on card
    _showGeneratingOverlay(panelId, true);

    try {
      const blobUrl = await HuggingFace.generateImage(
        settings.hfApiKey,
        model,
        fullPrompt,
        {
          steps:    20,
          guidance: 7.5,
          width:    512,
          height:   768,
        },
        (pct) => {
          fill.style.width = `${pct}%`;
          statusLabel.textContent = pct < 100 ? `Génération… ${pct}%` : 'Finalisation…';
        },
      );

      State.updatePanel(panelId, { imageBlobUrl: blobUrl, prompt: panel.prompt });
      PanelRenderer.render();
      Toast.show('Image générée avec succès !', 'success');
    } catch (err) {
      Toast.show(`Erreur : ${err.message}`, 'error');
    } finally {
      _running = false;
      progressBar.classList.add('hidden');
      fill.style.width = '0%';
      _showGeneratingOverlay(panelId, false);
    }
  }

  function _showGeneratingOverlay(panelId, show) {
    const card = document.querySelector(`.panel-card[data-id="${panelId}"]`);
    if (!card) return;
    const existing = card.querySelector('.panel-generating');
    if (show && !existing) {
      const ov = document.createElement('div');
      ov.className = 'panel-generating';
      ov.innerHTML = '<div class="spinner"></div><span>Génération en cours…</span>';
      card.appendChild(ov);
    } else if (!show && existing) {
      existing.remove();
    }
  }

  return { generate };
})();

/* ════════════════════════════════════════════════
   SETTINGS
════════════════════════════════════════════════ */
const SettingsUI = (() => {
  function open() {
    const s   = State.getSettings();
    const cfg = window.APP_CONFIG || {};

    // HF API key — hide inputs when pre-configured via config.js
    const hfInputs        = document.getElementById('hf-api-key-inputs');
    const hfPreconfigured = document.getElementById('hf-preconfigured');
    if (cfg.HF_API_KEY) {
      hfInputs.classList.add('hidden');
      hfPreconfigured.classList.remove('hidden');
    } else {
      document.getElementById('hf-api-key').value = s.hfApiKey || '';
      hfInputs.classList.remove('hidden');
      hfPreconfigured.classList.add('hidden');
    }

    // Google Client ID — hide input when pre-configured via config.js
    const googleInputs        = document.getElementById('google-client-id-inputs');
    const googlePreconfigured = document.getElementById('google-preconfigured');
    if (cfg.GOOGLE_CLIENT_ID) {
      googleInputs.classList.add('hidden');
      googlePreconfigured.classList.remove('hidden');
    } else {
      document.getElementById('google-client-id').value = s.googleClientId || '';
      googleInputs.classList.remove('hidden');
      googlePreconfigured.classList.add('hidden');
    }

    document.getElementById('canvas-width').value = s.canvasWidth || 800;
    document.getElementById('panel-gap').value    = s.panelGap    || 16;
    document.getElementById('bg-color').value     = s.bgColor     || '#ffffff';
    document.getElementById('settings-modal').classList.remove('hidden');
  }

  function close() {
    document.getElementById('settings-modal').classList.add('hidden');
  }

  function save() {
    const cfg      = window.APP_CONFIG || {};
    // Use config.js value when pre-configured; otherwise read from the form field
    const hfKey    = cfg.HF_API_KEY    || document.getElementById('hf-api-key').value.trim();
    const clientId = cfg.GOOGLE_CLIENT_ID || document.getElementById('google-client-id').value.trim();
    const width    = parseInt(document.getElementById('canvas-width').value) || 800;
    const gap      = parseInt(document.getElementById('panel-gap').value)    || 16;
    const bg       = document.getElementById('bg-color').value;

    State.updateSettings({
      hfApiKey:       hfKey,
      googleClientId: clientId,
      canvasWidth:    width,
      panelGap:       gap,
      bgColor:        bg,
    });

    // Re-init Drive if client ID changed
    if (clientId) GDrive.init(clientId);

    PanelRenderer.render();
    close();
    Toast.show('Paramètres sauvegardés.', 'success');
  }

  return { open, close, save };
})();

/* ════════════════════════════════════════════════
   DRIVE PICKER MODAL
════════════════════════════════════════════════ */
const DrivePickerModal = (() => {
  let _callback = null;

  function open(files, onSelect) {
    _callback = onSelect;

    const listEl  = document.getElementById('drive-file-list');
    const emptyEl = document.getElementById('drive-file-empty');

    listEl.innerHTML = '';

    if (!files || files.length === 0) {
      emptyEl.classList.remove('hidden');
    } else {
      emptyEl.classList.add('hidden');
      files.forEach(file => {
        const li = document.createElement('li');
        li.className = 'drive-file-item';
        const date = file.modifiedTime
          ? new Date(file.modifiedTime).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
          : '';
        li.innerHTML = `
          <span class="drive-file-icon">📄</span>
          <div class="drive-file-info">
            <div class="drive-file-name">${escapeHtmlModal(file.name.replace(/\.webtoon\.json$/, ''))}</div>
            ${date ? `<div class="drive-file-date">Modifié le ${date}</div>` : ''}
          </div>
        `;
        li.addEventListener('click', () => {
          close();
          if (_callback) _callback(file);
        });
        listEl.appendChild(li);
      });
    }

    document.getElementById('drive-picker-modal').classList.remove('hidden');
  }

  function close() {
    document.getElementById('drive-picker-modal').classList.add('hidden');
    _callback = null;
  }

  function escapeHtmlModal(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  return { open, close };
})();

/* ════════════════════════════════════════════════
const Exporter = (() => {
  function _appName() {
    return (window.APP_CONFIG || {}).APP_NAME || 'Webtoon Maker';
  }

  function exportJSON() {
    const data = JSON.stringify(State.toJSON(), null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    _download(URL.createObjectURL(blob), `${State.get().title || _appName()}.webtoon.json`);
    Toast.show('Projet exporté en JSON.', 'success');
  }

  function importJSON(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const project = JSON.parse(e.target.result);
        State.loadProject(project);
        PanelRenderer.clearActive();
        PanelRenderer.render();
        EditorPanel.close();
        Toast.show(`Projet "${project.title || 'Sans titre'}" chargé.`, 'success');
      } catch (_) {
        Toast.show('Fichier JSON invalide.', 'error');
      }
    };
    reader.readAsText(file);
  }

  async function exportPNG() {
    Toast.show('Export PNG en cours…', 'info', 5000);
    if (!window.html2canvas) {
      await loadScript(CDN_SCRIPTS.html2canvas);
    }
    try {
      const canvas = document.getElementById('webtoon-canvas');
      const c = await window.html2canvas(canvas, { useCORS: true, backgroundColor: State.getSettings().bgColor });
      _download(c.toDataURL('image/png'), `${State.get().title || _appName()}.png`);
      Toast.show('Export PNG terminé.', 'success');
    } catch (e) {
      Toast.show(`Export PNG échoué: ${e.message}`, 'error');
    }
  }

  async function exportPDF() {
    Toast.show('Export PDF en cours…', 'info', 5000);
    if (!window.html2canvas) {
      await loadScript(CDN_SCRIPTS.html2canvas);
    }
    if (!window.jspdf) {
      await loadScript(CDN_SCRIPTS.jspdf);
    }
    try {
      const canvas = document.getElementById('webtoon-canvas');
      const c = await window.html2canvas(canvas, { useCORS: true, backgroundColor: State.getSettings().bgColor });
      const imgData = c.toDataURL('image/jpeg', 0.9);
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'px', format: [c.width, c.height] });
      pdf.addImage(imgData, 'JPEG', 0, 0, c.width, c.height);
      pdf.save(`${State.get().title || _appName()}.pdf`);
      Toast.show('Export PDF terminé.', 'success');
    } catch (e) {
      Toast.show(`Export PDF échoué: ${e.message}`, 'error');
    }
  }

  async function saveToDrive() {
    if (!GDrive.isAuthorized()) {
      Toast.show('Connectez-vous à Google Drive dans ⚙ Paramètres.', 'warning');
      return;
    }
    try {
      const project = State.toJSON();
      const result  = await GDrive.saveProject(project, State.get().driveFileId);
      State.setDriveFileId(result.id);
      Toast.show(`Sauvegardé sur Drive : ${result.name}`, 'success');
    } catch (e) {
      Toast.show(`Erreur Drive : ${e.message}`, 'error');
    }
  }

  async function openFromDrive() {
    if (!GDrive.isAuthorized()) {
      Toast.show('Connectez-vous d\'abord à Google Drive dans ⚙ Paramètres.', 'warning');
      return;
    }
    try {
      const files = await GDrive.listProjects();
      DrivePickerModal.open(files, async (file) => {
        try {
          const project = await GDrive.loadProject(file.id);
          State.loadProject(project);
          State.setDriveFileId(file.id);
          PanelRenderer.clearActive();
          PanelRenderer.render();
          EditorPanel.close();
          Toast.show(`Projet "${project.title || 'Sans titre'}" chargé depuis Drive.`, 'success');
        } catch (e) {
          Toast.show(`Erreur Drive : ${e.message}`, 'error');
        }
      });
    } catch (e) {
      Toast.show(`Erreur Drive : ${e.message}`, 'error');
    }
  }

  // Known SRI hashes for dynamically-loaded CDN libraries
  const CDN_SCRIPTS = {
    html2canvas: {
      src:       'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
      integrity: 'sha512-BNjlUjc/tLAm3CpNYxHDIFKMgG2O2AeSLBLFBkp5GIFLTAZQQPj0MWp+9G/pDLMgCdAlnJQ1Rc4eSF6VuPWQ==',
    },
    jspdf: {
      src:       'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
      integrity: 'sha512-qZvrmS2ekKPF2mSznTQsxqPgnpkI4DNTlrdUmTzrDgektczlKNRRhy5X5AAOnx5S09ydFYWWNSfA6OedpYAsg==',
    },
  };

  function loadScript({ src, integrity }) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.crossOrigin = 'anonymous';
      if (integrity) s.integrity = integrity;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function _download(href, filename) {
    const a = document.createElement('a');
    a.href = href; a.download = filename;
    a.click();
  }

  return { exportJSON, importJSON, exportPNG, exportPDF, saveToDrive, openFromDrive };
})();

/* ════════════════════════════════════════════════
   ZOOM
════════════════════════════════════════════════ */
const Zoom = (() => {
  let _level = 1.0;
  const MIN = 0.25, MAX = 2.0, STEP = 0.15;

  function apply() {
    const scroll = document.getElementById('canvas-scroll');
    scroll.style.zoom = _level;
    document.getElementById('zoom-label').textContent = `${Math.round(_level * 100)} %`;
  }

  function in_()  { _level = Math.min(MAX, _level + STEP); apply(); }
  function out_() { _level = Math.max(MIN, _level - STEP); apply(); }
  function fit()  { _level = 1.0; apply(); }

  return { in: in_, out: out_, fit };
})();

/* ════════════════════════════════════════════════
   DRAG & DROP (panel reorder)
════════════════════════════════════════════════ */
const DragDrop = (() => {
  let _dragging = null;

  function init() {
    const list = document.getElementById('panel-list');
    list.addEventListener('dragstart', onDragStart);
    list.addEventListener('dragover',  onDragOver);
    list.addEventListener('drop',      onDrop);
    list.addEventListener('dragend',   onDragEnd);
  }

  function onDragStart(e) {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    _dragging = li;
    e.dataTransfer.effectAllowed = 'move';
    li.style.opacity = '0.4';
  }

  function onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('li[data-id]');
    if (target && target !== _dragging) {
      const rect = target.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      target.parentNode.insertBefore(_dragging, after ? target.nextSibling : target);
    }
  }

  function onDrop(e) {
    e.preventDefault();
    // Rebuild order from DOM
    const ids = Array.from(document.querySelectorAll('#panel-list li[data-id]')).map(li => li.dataset.id);
    const old = State.getPanels();
    const reordered = ids.map(id => old.find(p => p.id === id)).filter(Boolean);
    State.reorderPanels(reordered);
    PanelRenderer.render();
  }

  function onDragEnd() {
    if (_dragging) { _dragging.style.opacity = ''; _dragging = null; }
  }

  return { init };
})();

/* ════════════════════════════════════════════════
   EVENT WIRING
════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  State.loadFromStorage();

  // Apply app name from config.js
  const appName = (window.APP_CONFIG || {}).APP_NAME || 'Webtoon Maker';
  document.title = appName;
  const brandEl = document.querySelector('.brand-title');
  if (brandEl) brandEl.textContent = appName;

  // Init Drive if client ID saved
  const clientId = State.getSettings().googleClientId;
  if (clientId) GDrive.init(clientId);

  PanelRenderer.render();
  DragDrop.init();

  // ── Header buttons ──
  document.getElementById('btn-new-project').addEventListener('click', () => {
    if (State.getPanels().length > 0 && !confirm('Créer un nouveau projet ? Les modifications non sauvegardées seront perdues.')) return;
    State.newProject();
    PanelRenderer.clearActive();
    PanelRenderer.render();
    EditorPanel.close();
    Toast.show('Nouveau projet créé.', 'success');
  });

  document.getElementById('btn-save-project').addEventListener('click', () => Exporter.saveToDrive());
  document.getElementById('btn-open-project').addEventListener('click', () => Exporter.openFromDrive());

  document.getElementById('btn-export').addEventListener('click', () => {
    document.getElementById('export-modal').classList.remove('hidden');
  });

  document.getElementById('btn-settings').addEventListener('click', () => SettingsUI.open());

  // ── Panel sidebar ──
  document.getElementById('btn-add-panel').addEventListener('click', () => {
    const panel = createPanelData();
    State.addPanel(panel);
    PanelRenderer.render();
    PanelRenderer.setActivePanel(panel.id);
  });

  // ── Canvas zoom ──
  document.getElementById('btn-zoom-in').addEventListener('click',  () => Zoom.in());
  document.getElementById('btn-zoom-out').addEventListener('click', () => Zoom.out());
  document.getElementById('btn-zoom-fit').addEventListener('click', () => Zoom.fit());

  // ── Editor: source tabs ──
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  // ── Editor: style chips ──
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
    });
  });

  // ── Editor: size buttons ──
  document.querySelectorAll('.size-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = PanelRenderer.getActiveId();
      if (!id) return;
      document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      State.updatePanel(id, { size: btn.dataset.size });
      PanelRenderer.render();
    });
  });

  // ── Editor: live field updates ──
  ['panel-prompt', 'panel-caption'].forEach(fieldId => {
    document.getElementById(fieldId).addEventListener('input', () => {
      const id = PanelRenderer.getActiveId();
      if (!id) return;
      const val = document.getElementById(fieldId).value;
      const key = fieldId === 'panel-prompt' ? 'prompt' : 'caption';
      State.updatePanel(id, { [key]: val });
      if (key === 'caption') PanelRenderer.render();
    });
  });

  document.getElementById('caption-position').addEventListener('change', () => {
    const id = PanelRenderer.getActiveId();
    if (!id) return;
    State.updatePanel(id, { captionPos: document.getElementById('caption-position').value });
    PanelRenderer.render();
  });

  // ── Editor: generate ──
  document.getElementById('btn-generate').addEventListener('click', () => {
    const id = PanelRenderer.getActiveId();
    if (!id) { Toast.show('Sélectionnez un panneau.', 'warning'); return; }
    // Sync prompt before generating
    State.updatePanel(id, { prompt: document.getElementById('panel-prompt').value });
    GenerationQueue.generate(id);
  });

  // ── Editor: load URL ──
  document.getElementById('btn-load-url').addEventListener('click', () => {
    const id  = PanelRenderer.getActiveId();
    const url = document.getElementById('panel-image-url').value.trim();
    if (!id || !url) return;
    State.updatePanel(id, { imageUrl: url, imageBlobUrl: '' });
    PanelRenderer.render();
    Toast.show('Image chargée.', 'success');
  });

  // ── Editor: upload file ──
  const uploadZone  = document.getElementById('upload-zone');
  const uploadInput = document.getElementById('upload-input');

  uploadZone.addEventListener('click', () => uploadInput.click());
  uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
  uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
  uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleImageFile(file);
  });
  uploadInput.addEventListener('change', () => {
    if (uploadInput.files[0]) handleImageFile(uploadInput.files[0]);
  });

  function handleImageFile(file) {
    if (!file.type.startsWith('image/')) { Toast.show('Fichier non supporté.', 'error'); return; }
    const id = PanelRenderer.getActiveId();
    if (!id) { Toast.show('Sélectionnez un panneau.', 'warning'); return; }
    const url = URL.createObjectURL(file);
    State.updatePanel(id, { imageBlobUrl: url, imageUrl: '' });
    PanelRenderer.render();
    Toast.show('Image importée.', 'success');
  }

  // ── Editor: duplicate / delete panel ──
  document.getElementById('btn-duplicate-panel').addEventListener('click', () => {
    const id = PanelRenderer.getActiveId();
    if (!id) return;
    const panel = State.getPanels().find(p => p.id === id);
    if (!panel) return;
    const clone = deepClone(panel);
    clone.id = uid();
    State.addPanel(clone);
    PanelRenderer.render();
    PanelRenderer.setActivePanel(clone.id);
    Toast.show('Panneau dupliqué.', 'success');
  });

  document.getElementById('btn-delete-panel').addEventListener('click', () => {
    const id = PanelRenderer.getActiveId();
    if (!id) return;
    if (!confirm('Supprimer ce panneau ?')) return;
    State.deletePanel(id);
    PanelRenderer.clearActive();
    EditorPanel.close();
    PanelRenderer.render();
    Toast.show('Panneau supprimé.', 'success');
  });

  // ── Settings modal ──
  document.getElementById('settings-close').addEventListener('click',  () => SettingsUI.close());
  document.getElementById('btn-settings-cancel').addEventListener('click', () => SettingsUI.close());
  document.getElementById('btn-settings-save').addEventListener('click',   () => SettingsUI.save());

  // Toggle HF key visibility
  document.getElementById('btn-toggle-hf-key').addEventListener('click', () => {
    const input = document.getElementById('hf-api-key');
    input.type  = input.type === 'password' ? 'text' : 'password';
  });

  // Google Drive auth
  document.getElementById('btn-gdrive-auth').addEventListener('click', async () => {
    const cfg      = window.APP_CONFIG || {};
    const clientId = cfg.GOOGLE_CLIENT_ID || document.getElementById('google-client-id').value.trim();
    if (!clientId) { Toast.show('Entrez d\'abord votre Google Client ID.', 'warning'); return; }
    GDrive.init(clientId);
    const statusEl = document.getElementById('gdrive-status');
    statusEl.className = 'status-badge pending';
    statusEl.textContent = 'Connexion…';
    try {
      await GDrive.authorize();
      State.updateSettings({ googleClientId: clientId });
      statusEl.className = 'status-badge ok';
      statusEl.textContent = '✔ Connecté à Google Drive';
      Toast.show('Google Drive connecté !', 'success');
    } catch (e) {
      statusEl.className = 'status-badge error';
      statusEl.textContent = `✘ ${e.message}`;
    }
  });

  // ── Export modal ──
  document.getElementById('export-close').addEventListener('click', () => {
    document.getElementById('export-modal').classList.add('hidden');
  });
  document.getElementById('export-json').addEventListener('click', () => {
    document.getElementById('export-modal').classList.add('hidden');
    Exporter.exportJSON();
  });
  document.getElementById('export-png').addEventListener('click', () => {
    document.getElementById('export-modal').classList.add('hidden');
    Exporter.exportPNG();
  });
  document.getElementById('export-pdf').addEventListener('click', () => {
    document.getElementById('export-modal').classList.add('hidden');
    Exporter.exportPDF();
  });
  document.getElementById('export-drive').addEventListener('click', () => {
    document.getElementById('export-modal').classList.add('hidden');
    Exporter.saveToDrive();
  });

  document.getElementById('drive-picker-close').addEventListener('click', () => DrivePickerModal.close());

  // ── Close modals on overlay click ──
  ['settings-modal', 'export-modal', 'drive-picker-modal'].forEach(id => {
    document.getElementById(id).addEventListener('click', (e) => {
      if (e.target === document.getElementById(id)) {
        document.getElementById(id).classList.add('hidden');
      }
    });
  });

  // ── Keyboard shortcuts ──
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      Exporter.saveToDrive();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
      e.preventDefault();
      document.getElementById('btn-add-panel').click();
    }
    if (e.key === 'Escape') {
      document.getElementById('settings-modal').classList.add('hidden');
      document.getElementById('export-modal').classList.add('hidden');
      document.getElementById('drive-picker-modal').classList.add('hidden');
    }
  });
});
