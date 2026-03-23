/**
 * gdrive.js — Google Drive API integration (OAuth2 via Google Identity Services)
 * Saves and loads webtoon project JSON files in the user's Drive.
 */

const GDrive = (() => {
  const SCOPE      = 'https://www.googleapis.com/auth/drive.file';
  const FOLDER_NAME = 'WebtoonMaker';
  const FILE_MIME   = 'application/json';
  const FILE_EXT    = '.webtoon.json';

  let _clientId    = '';
  let _accessToken = '';
  let _folderId    = '';
  let _tokenClient = null;

  // ── Init ─────────────────────────────────────────
  /**
   * Call once after the GIS script has loaded.
   * @param {string} clientId  - Google OAuth2 Client ID
   */
  function init(clientId) {
    _clientId = clientId;
    _accessToken = '';
    _folderId    = '';
    _tokenClient = null;
  }

  // ── Auth ─────────────────────────────────────────
  /**
   * Trigger OAuth2 popup and obtain an access token.
   * @returns {Promise<string>} accessToken
   */
  function authorize() {
    return new Promise((resolve, reject) => {
      if (!_clientId) {
        reject(new Error('Google Client ID non configuré.'));
        return;
      }

      if (!window.google?.accounts?.oauth2) {
        reject(new Error('La bibliothèque Google Identity Services n\'est pas chargée.'));
        return;
      }

      _tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: _clientId,
        scope:     SCOPE,
        callback:  (response) => {
          if (response.error) {
            reject(new Error(`Auth Google échouée: ${response.error}`));
            return;
          }
          _accessToken = response.access_token;
          resolve(_accessToken);
        },
      });

      _tokenClient.requestAccessToken({ prompt: 'consent' });
    });
  }

  function isAuthorized() {
    return Boolean(_accessToken);
  }

  function signOut() {
    if (_accessToken && window.google?.accounts?.oauth2) {
      window.google.accounts.oauth2.revoke(_accessToken);
    }
    _accessToken = '';
    _folderId    = '';
  }

  // ── Drive helpers ────────────────────────────────
  async function _request(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${_accessToken}`,
        'Content-Type':  'application/json',
        ...(options.headers ?? {}),
      },
    });
    if (!res.ok) {
      let msg = `Drive API ${res.status}`;
      try { const d = await res.json(); msg = d.error?.message ?? msg; } catch (_) { /* ignore */ }
      throw new Error(msg);
    }
    return res.json();
  }

  /** Find or create the WebtoonMaker folder. */
  async function _ensureFolder() {
    if (_folderId) return _folderId;

    const q = `mimeType='application/vnd.google-apps.folder' and name='${FOLDER_NAME}' and trashed=false`;
    const list = await _request(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`,
    );

    if (list.files.length > 0) {
      _folderId = list.files[0].id;
      return _folderId;
    }

    // Create folder
    const folder = await _request('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      body: JSON.stringify({
        name:     FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder',
      }),
    });

    _folderId = folder.id;
    return _folderId;
  }

  // ── Public API ───────────────────────────────────

  /**
   * Save a project to Google Drive (create or update).
   * @param {object} project  - The project data object
   * @param {string} [fileId] - Existing Drive file ID to update (optional)
   * @returns {Promise<{id: string, name: string}>}
   */
  async function saveProject(project, fileId = null) {
    if (!_accessToken) throw new Error('Non connecté à Google Drive.');

    const folderId = await _ensureFolder();
    const fileName = `${project.title || 'Sans titre'}${FILE_EXT}`;
    const content  = JSON.stringify(project, null, 2);
    const blob     = new Blob([content], { type: FILE_MIME });

    if (fileId) {
      // Update existing file (multipart)
      return _multipartUpload(blob, { name: fileName }, fileId, 'PATCH');
    }

    // Create new file
    return _multipartUpload(blob, {
      name:    fileName,
      parents: [folderId],
    }, null, 'POST');
  }

  /**
   * List all webtoon project files in the WebtoonMaker folder.
   * @returns {Promise<Array<{id,name,modifiedTime,size}>>}
   */
  async function listProjects() {
    if (!_accessToken) throw new Error('Non connecté à Google Drive.');

    const folderId = await _ensureFolder();
    const q = `'${folderId}' in parents and name contains '${FILE_EXT}' and trashed=false`;
    const list = await _request(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime,size)&orderBy=modifiedTime+desc`,
    );
    return list.files;
  }

  /**
   * Load (download) a project file from Drive.
   * @param {string} fileId
   * @returns {Promise<object>} parsed project JSON
   */
  async function loadProject(fileId) {
    if (!_accessToken) throw new Error('Non connecté à Google Drive.');

    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { Authorization: `Bearer ${_accessToken}` } },
    );
    if (!res.ok) throw new Error(`Impossible de charger le fichier (${res.status}).`);
    return res.json();
  }

  /**
   * Upload a Blob using multipart/related to the Drive API.
   */
  async function _multipartUpload(blob, metadata, fileId, method) {
    const boundary = 'webtoon_maker_boundary';
    const metaPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`;
    const dataPart = `--${boundary}\r\nContent-Type: ${FILE_MIME}\r\n\r\n`;
    const endPart  = `\r\n--${boundary}--`;

    const bodyParts = [metaPart, dataPart, blob, endPart];
    const body = new Blob(bodyParts, { type: `multipart/related; boundary="${boundary}"` });

    const url = fileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';

    const res = await fetch(url, {
      method,
      headers: {
        Authorization:  `Bearer ${_accessToken}`,
        'Content-Type': `multipart/related; boundary="${boundary}"`,
      },
      body,
    });

    if (!res.ok) {
      let msg = `Drive upload ${res.status}`;
      try { const d = await res.json(); msg = d.error?.message ?? msg; } catch (_) { /* ignore */ }
      throw new Error(msg);
    }

    return res.json(); // {id, name, ...}
  }

  return { init, authorize, isAuthorized, signOut, saveProject, listProjects, loadProject };
})();
