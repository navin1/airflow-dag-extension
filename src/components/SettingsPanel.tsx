import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Pencil, X, ChevronRight, ExternalLink, Upload, CheckCheck } from 'lucide-react';
import type { EnvConfig, Settings } from '../types';

// ── Storage helpers ───────────────────────────────────────────────────────────

async function loadSettings(): Promise<Settings> {
  if (typeof chrome !== 'undefined' && chrome.storage) {
    return new Promise(resolve =>
      chrome.storage.sync.get(
        ['envs', 'oauthClientId', 'manualToken', 'manualTokenExpiry', 'useManualToken'],
        r => resolve(r as Settings),
      ),
    );
  }
  try { return JSON.parse(localStorage.getItem('adv_settings') ?? '{}') as Settings; }
  catch { return {} as Settings; }
}

async function saveSettings(patch: Partial<Settings>): Promise<void> {
  if (typeof chrome !== 'undefined' && chrome.storage) {
    return new Promise(resolve => chrome.storage.sync.set(patch, resolve));
  }
  const cur = JSON.parse(localStorage.getItem('adv_settings') ?? '{}');
  localStorage.setItem('adv_settings', JSON.stringify({ ...cur, ...patch }));
}

async function loadVertexLocal(): Promise<{ serviceAccountJson: string; vertexModel: string; vertexRegion: string; vertexProjectId: string }> {
  if (typeof chrome !== 'undefined' && chrome.storage) {
    const local = await new Promise<Record<string, string>>(r =>
      chrome.storage.local.get(['serviceAccountJson'], v => r(v as Record<string, string>)),
    );
    const sync = await new Promise<Record<string, string>>(r =>
      chrome.storage.sync.get(['vertexModel', 'vertexRegion', 'vertexProjectId'], v => r(v as Record<string, string>)),
    );
    return {
      serviceAccountJson: local.serviceAccountJson ?? '',
      vertexModel:        sync.vertexModel        ?? 'gemini-2.5-pro',
      vertexRegion:       sync.vertexRegion        ?? 'us-central1',
      vertexProjectId:    sync.vertexProjectId     ?? '',
    };
  }
  return { serviceAccountJson: '', vertexModel: 'gemini-2.5-pro', vertexRegion: 'us-central1', vertexProjectId: '' };
}

async function saveVertexSettings(saJson: string, model: string, region: string, projectId: string): Promise<void> {
  if (typeof chrome !== 'undefined' && chrome.storage) {
    await Promise.all([
      new Promise<void>(r => chrome.storage.local.set({ serviceAccountJson: saJson }, r)),
      new Promise<void>(r => chrome.storage.sync.set({ vertexModel: model, vertexRegion: region, vertexProjectId: projectId }, r)),
    ]);
    return;
  }
  localStorage.setItem('vertex_sa', saJson);
}

// ── Env components ────────────────────────────────────────────────────────────

function EnvRow({ env, onEdit, onDelete }: { env: EnvConfig; onEdit: (e: EnvConfig) => void; onDelete: () => void }) {
  return (
    <div style={rowStyle}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: '#1E293B' }}>{env.name}</div>
        <div style={{ fontSize: 11, color: '#64748B', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{env.url}</div>
      </div>
      <button onClick={() => onEdit(env)} style={iconBtn}><Pencil size={14} /></button>
      <button onClick={onDelete} style={{ ...iconBtn, color: '#EF4444' }}><Trash2 size={14} /></button>
    </div>
  );
}

function EnvForm({ initial, onSave, onCancel }: { initial: Partial<EnvConfig>; onSave: (e: EnvConfig) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial.name ?? '');
  const [url,  setUrl]  = useState(initial.url  ?? '');
  const valid = name.trim() && url.trim().startsWith('http');
  return (
    <div style={{ background: '#F1F5F9', borderRadius: 8, padding: 12, marginTop: 6 }}>
      <label style={labelStyle}>Environment name</label>
      <input value={name} onChange={e => setName(e.target.value)} placeholder="prod / staging" style={inputStyle} />
      <label style={labelStyle}>Airflow base URL</label>
      <input value={url}  onChange={e => setUrl(e.target.value)}  placeholder="https://xxx.composer.cloud.google.com" style={inputStyle} />
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button onClick={() => valid && onSave({ name: name.trim(), url: url.trim() })} disabled={!valid} style={primaryBtn(!!valid)}>Save</button>
        <button onClick={onCancel} style={secondaryBtn}>Cancel</button>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SettingsPanel({ onClose }: { onClose: () => void }) {
  // Environments
  const [envs,       setEnvs]       = useState<EnvConfig[]>([]);
  const [editingEnv, setEditingEnv] = useState<Partial<EnvConfig> | null>(null);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);

  // Auth
  const [oauthClientId, setOauthClientId] = useState('');
  const [manualToken,   setManualToken]   = useState('');
  const [useManual,     setUseManual]     = useState(true);
  const [authSaved,     setAuthSaved]     = useState(false);

  // Vertex AI
  const [saJson,       setSaJson]       = useState('');
  const [saFileName,   setSaFileName]   = useState('');
  const [vertexModel,  setVertexModel]  = useState('gemini-2.5-pro');
  const [vertexRegion, setVertexRegion] = useState('us-central1');
  const [vertexProject,setVertexProject]= useState('');
  const [vertexSaved,  setVertexSaved]  = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadSettings().then(s => {
      setEnvs(s.envs ?? []);
      setOauthClientId(s.oauthClientId ?? '');
      setManualToken(s.manualToken ?? '');
      setUseManual(s.useManualToken ?? true);
    });
    loadVertexLocal().then(v => {
      setSaJson(v.serviceAccountJson);
      setVertexModel(v.vertexModel);
      setVertexRegion(v.vertexRegion);
      setVertexProject(v.vertexProjectId);
      if (v.serviceAccountJson) {
        try {
          const parsed = JSON.parse(v.serviceAccountJson);
          setSaFileName(`${parsed.client_email ?? 'service-account'}.json`);
          if (!v.vertexProjectId && parsed.project_id) setVertexProject(parsed.project_id);
        } catch { /* ignore */ }
      }
    });
  }, []);

  const saveEnv = (env: EnvConfig) => {
    const next = [...envs];
    if (editingIdx !== null) next[editingIdx] = env; else next.push(env);
    setEnvs(next);
    setEditingEnv(null); setEditingIdx(null);
    saveSettings({ envs: next });
  };

  const deleteEnv = (idx: number) => {
    const next = envs.filter((_, i) => i !== idx);
    setEnvs(next);
    saveSettings({ envs: next });
  };

  const handleSaveAuth = () => {
    saveSettings({ oauthClientId, manualToken, useManualToken: useManual });
    setAuthSaved(true);
    setTimeout(() => setAuthSaved(false), 2000);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSaFileName(file.name);
    const reader = new FileReader();
    reader.onload = ev => {
      const text = ev.target?.result as string;
      setSaJson(text);
      try {
        const parsed = JSON.parse(text);
        if (parsed.project_id && !vertexProject) setVertexProject(parsed.project_id);
      } catch { /* ignore */ }
    };
    reader.readAsText(file);
  };

  const handleSaveVertex = async () => {
    await saveVertexSettings(saJson, vertexModel, vertexRegion, vertexProject);
    setVertexSaved(true);
    setTimeout(() => setVertexSaved(false), 2000);
  };

  const redirectUri = typeof chrome !== 'undefined' && chrome.identity
    ? chrome.identity.getRedirectURL()
    : 'https://<extension-id>.chromiumapp.org/';

  const MODELS = [
    'gemini-2.0-flash-001',
    'gemini-2.0-pro-exp-02-05',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-pro',
  ];

  const REGIONS = [
    'us-central1', 'us-east1', 'us-east4', 'us-west1',
    'europe-west1', 'europe-west2', 'europe-west4',
    'asia-east1', 'asia-northeast1', 'asia-southeast1',
  ];

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={drawerStyle} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={drawerHeader}>
          <span style={{ fontWeight: 700, fontSize: 15 }}>Settings</span>
          <button onClick={onClose} style={{ ...iconBtn, marginLeft: 'auto' }}><X size={16} /></button>
        </div>

        <div style={scrollArea}>

          {/* ── Environments ────────────────────────────────────────────── */}
          <section style={section}>
            <div style={sectionTitle}><ChevronRight size={14} style={{ marginRight: 4 }} />Environments</div>
            <p style={helpText}>Configure up to 6 Cloud Composer Airflow URLs.</p>
            {envs.map((env, i) => (
              <EnvRow key={i} env={env}
                onEdit={e  => { setEditingEnv(e); setEditingIdx(i); }}
                onDelete={() => deleteEnv(i)} />
            ))}
            {editingEnv !== null && (
              <EnvForm initial={editingEnv} onSave={saveEnv}
                onCancel={() => { setEditingEnv(null); setEditingIdx(null); }} />
            )}
            {envs.length < 6 && editingEnv === null && (
              <button onClick={() => { setEditingEnv({}); setEditingIdx(null); }} style={addEnvBtn}>
                <Plus size={14} /> Add environment
              </button>
            )}
          </section>

          {/* ── Authentication ────────────────────────────────────────── */}
          <section style={section}>
            <div style={sectionTitle}><ChevronRight size={14} style={{ marginRight: 4 }} />Authentication</div>

            <div style={{ display: 'flex', gap: 0, marginBottom: 12, borderRadius: 7, overflow: 'hidden', border: '1px solid #E2E8F0' }}>
              {(['manual', 'oauth'] as const).map(mode => (
                <button key={mode} onClick={() => setUseManual(mode === 'manual')} style={{
                  flex: 1, padding: '7px 0', fontSize: 12, fontWeight: 600, cursor: 'pointer', border: 'none',
                  background: (mode === 'manual') === useManual ? '#6366F1' : '#F8FAFC',
                  color:      (mode === 'manual') === useManual ? '#fff'    : '#64748B',
                }}>
                  {mode === 'manual' ? 'Manual Token' : 'OAuth'}
                </button>
              ))}
            </div>

            {useManual ? (
              <>
                <p style={helpText}>Paste a GCP Bearer token from <code style={inlineCode}>gcloud auth print-access-token</code>.</p>
                <label style={labelStyle}>Bearer token</label>
                <input type="password" value={manualToken} onChange={e => setManualToken(e.target.value)}
                  placeholder="ya29.xxx…" style={inputStyle} />
              </>
            ) : (
              <>
                <p style={helpText}>
                  OAuth 2.0 client (Web Application) with redirect URI:
                  <code style={{ ...inlineCode, wordBreak: 'break-all', display: 'block', marginTop: 4 }}>{redirectUri}</code>
                  <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer"
                    style={{ color: '#6366F1', fontSize: 11 }}>
                    Open GCP Console <ExternalLink size={10} style={{ verticalAlign: 'middle' }} />
                  </a>
                </p>
                <label style={labelStyle}>OAuth 2.0 Client ID</label>
                <input value={oauthClientId} onChange={e => setOauthClientId(e.target.value)}
                  placeholder="xxx.apps.googleusercontent.com" style={inputStyle} />
              </>
            )}

            <button onClick={handleSaveAuth} style={primaryBtn(true)}>
              {authSaved ? <><CheckCheck size={13} /> Saved</> : 'Save auth settings'}
            </button>
          </section>

          {/* ── Vertex AI ────────────────────────────────────────────────── */}
          <section style={section}>
            <div style={sectionTitle}><ChevronRight size={14} style={{ marginRight: 4 }} />Vertex AI (SQL Optimization)</div>
            <p style={helpText}>
              Used for BigQuery SQL optimization in the SQL viewer. Requires a GCP service account with
              <strong> Vertex AI User</strong> role.
            </p>

            {/* Service account JSON upload */}
            <label style={labelStyle}>Service account JSON key</label>
            <div style={uploadZone} onClick={() => fileRef.current?.click()}>
              <Upload size={16} color="#6366F1" />
              <span style={{ fontSize: 12, color: '#64748B' }}>
                {saFileName ? saFileName : 'Click to upload JSON key file'}
              </span>
              {saFileName && <CheckCheck size={14} color="#10B981" style={{ marginLeft: 'auto' }} />}
            </div>
            <input ref={fileRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleFileUpload} />

            {/* Or paste JSON */}
            <details style={{ marginTop: 8 }}>
              <summary style={{ fontSize: 11, color: '#6366F1', cursor: 'pointer' }}>Or paste JSON text</summary>
              <textarea
                value={saJson}
                onChange={e => setSaJson(e.target.value)}
                placeholder='{"type":"service_account","project_id":"…"}'
                rows={5}
                style={{ ...inputStyle, fontFamily: 'monospace', fontSize: 10, marginTop: 6, resize: 'vertical' }}
              />
            </details>

            {/* Model */}
            <label style={{ ...labelStyle, marginTop: 10 }}>Model</label>
            <select value={vertexModel} onChange={e => setVertexModel(e.target.value)} style={selectStyle}>
              {MODELS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>

            {/* Region */}
            <label style={{ ...labelStyle, marginTop: 10 }}>Region</label>
            <select value={vertexRegion} onChange={e => setVertexRegion(e.target.value)} style={selectStyle}>
              {REGIONS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>

            {/* Project ID */}
            <label style={{ ...labelStyle, marginTop: 10 }}>Project ID</label>
            <input value={vertexProject} onChange={e => setVertexProject(e.target.value)}
              placeholder="Auto-detected from JSON" style={inputStyle} />

            <button onClick={handleSaveVertex} style={{ ...primaryBtn(true), marginTop: 4 }}>
              {vertexSaved ? <><CheckCheck size={13} /> Saved</> : 'Save Vertex AI settings'}
            </button>
          </section>

        </div>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 100,
  background: 'rgba(15,23,42,0.45)',
  display: 'flex', justifyContent: 'flex-end',
};
const drawerStyle: React.CSSProperties = {
  width: 400, height: '100%', background: '#fff',
  display: 'flex', flexDirection: 'column',
  boxShadow: '-4px 0 24px rgba(0,0,0,0.18)',
};
const drawerHeader: React.CSSProperties = {
  display: 'flex', alignItems: 'center', padding: '14px 16px',
  borderBottom: '1px solid #E2E8F0', flexShrink: 0,
};
const scrollArea: React.CSSProperties = { flex: 1, overflow: 'auto', padding: '8px 0' };
const section:    React.CSSProperties = { padding: '16px', borderBottom: '1px solid #F1F5F9' };
const sectionTitle: React.CSSProperties = {
  fontWeight: 700, fontSize: 12, color: '#374151',
  textTransform: 'uppercase', letterSpacing: '0.06em',
  marginBottom: 8, display: 'flex', alignItems: 'center',
};
const helpText:   React.CSSProperties = { fontSize: 12, color: '#64748B', marginBottom: 10, lineHeight: 1.55 };
const labelStyle: React.CSSProperties = { display: 'block', fontSize: 11, fontWeight: 600, color: '#374151', marginBottom: 4 };
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '7px 10px', fontSize: 12,
  border: '1px solid #E2E8F0', borderRadius: 6, outline: 'none',
  marginBottom: 10, boxSizing: 'border-box', fontFamily: 'Inter, system-ui',
};
const selectStyle: React.CSSProperties = {
  width: '100%', padding: '7px 10px', fontSize: 12,
  border: '1px solid #E2E8F0', borderRadius: 6, outline: 'none',
  marginBottom: 10, background: '#fff', cursor: 'pointer',
};
const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '8px 10px', background: '#F8FAFC',
  borderRadius: 7, marginBottom: 6, border: '1px solid #E2E8F0',
};
const iconBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer',
  color: '#64748B', padding: 4, borderRadius: 4,
  display: 'flex', alignItems: 'center',
};
const addEnvBtn: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600,
  color: '#6366F1', background: '#EEF2FF', border: '1px dashed #A5B4FC',
  borderRadius: 7, padding: '8px 12px', cursor: 'pointer', width: '100%', marginTop: 4,
};
const primaryBtn = (enabled: boolean): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: 5,
  padding: '8px 16px', background: enabled ? '#6366F1' : '#E2E8F0',
  color: enabled ? '#fff' : '#9CA3AF', border: 'none',
  borderRadius: 7, fontSize: 12, fontWeight: 600,
  cursor: enabled ? 'pointer' : 'not-allowed',
});
const secondaryBtn: React.CSSProperties = {
  padding: '8px 16px', background: '#F1F5F9', color: '#374151',
  border: 'none', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer',
};
const inlineCode: React.CSSProperties = {
  background: '#F1F5F9', padding: '1px 4px', borderRadius: 3, fontSize: 11,
};
const uploadZone: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  border: '1px dashed #A5B4FC', borderRadius: 7,
  padding: '10px 12px', cursor: 'pointer',
  background: '#EEF2FF', marginBottom: 6,
};
