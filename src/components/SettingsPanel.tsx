import { useEffect, useState } from 'react';
import { Plus, Trash2, Pencil, X, ChevronRight, ExternalLink } from 'lucide-react';
import type { EnvConfig, Settings } from '../types';

// ── Chrome storage helpers (with localStorage fallback for dev) ───────────────

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

// ── Env editor row ────────────────────────────────────────────────────────────

interface EnvRowProps {
  env:      EnvConfig;
  onEdit:   (env: EnvConfig) => void;
  onDelete: () => void;
}

function EnvRow({ env, onEdit, onDelete }: EnvRowProps) {
  return (
    <div style={rowStyle}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: '#1E293B' }}>{env.name}</div>
        <div style={{ fontSize: 11, color: '#64748B', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {env.url}
        </div>
      </div>
      <button onClick={() => onEdit(env)} style={iconBtn} title="Edit">
        <Pencil size={14} />
      </button>
      <button onClick={onDelete} style={{ ...iconBtn, color: '#EF4444' }} title="Delete">
        <Trash2 size={14} />
      </button>
    </div>
  );
}

// ── Env form ──────────────────────────────────────────────────────────────────

interface EnvFormProps {
  initial:  Partial<EnvConfig>;
  onSave:   (env: EnvConfig) => void;
  onCancel: () => void;
}

function EnvForm({ initial, onSave, onCancel }: EnvFormProps) {
  const [name, setName] = useState(initial.name ?? '');
  const [url,  setUrl]  = useState(initial.url  ?? '');

  const valid = name.trim() && url.trim().startsWith('http');

  return (
    <div style={{ background: '#F1F5F9', borderRadius: 8, padding: 12, marginTop: 6 }}>
      <label style={labelStyle}>Environment name</label>
      <input value={name} onChange={e => setName(e.target.value)}
        placeholder="prod / staging / dev" style={inputStyle} />
      <label style={labelStyle}>Airflow base URL</label>
      <input value={url} onChange={e => setUrl(e.target.value)}
        placeholder="https://xxx.composer.cloud.google.com" style={inputStyle} />
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button onClick={() => valid && onSave({ name: name.trim(), url: url.trim() })}
          disabled={!valid} style={primaryBtn(!!valid)}>
          Save
        </button>
        <button onClick={onCancel} style={secondaryBtn}>Cancel</button>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface SettingsPanelProps {
  onClose: () => void;
}

export default function SettingsPanel({ onClose }: SettingsPanelProps) {
  const [envs,          setEnvs]          = useState<EnvConfig[]>([]);
  const [editingEnv,    setEditingEnv]    = useState<Partial<EnvConfig> | null>(null);
  const [editingIdx,    setEditingIdx]    = useState<number | null>(null);
  const [oauthClientId, setOauthClientId] = useState('');
  const [manualToken,   setManualToken]   = useState('');
  const [tokenExpiry,   setTokenExpiry]   = useState('');
  const [useManual,     setUseManual]     = useState(true);
  const [saved,         setSaved]         = useState(false);

  useEffect(() => {
    loadSettings().then(s => {
      setEnvs(s.envs ?? []);
      setOauthClientId(s.oauthClientId ?? '');
      setManualToken(s.manualToken ?? '');
      setTokenExpiry(s.manualTokenExpiry ?? '');
      setUseManual(s.useManualToken ?? true);
    });
  }, []);

  const saveEnv = (env: EnvConfig) => {
    const next = [...envs];
    if (editingIdx !== null) next[editingIdx] = env;
    else next.push(env);
    setEnvs(next);
    setEditingEnv(null);
    setEditingIdx(null);
    saveSettings({ envs: next });
  };

  const deleteEnv = (idx: number) => {
    const next = envs.filter((_, i) => i !== idx);
    setEnvs(next);
    saveSettings({ envs: next });
  };

  const handleSaveAuth = () => {
    const expiry = manualToken
      ? new Date(Date.now() + 55 * 60_000).toISOString() // 55-min default
      : '';
    saveSettings({
      oauthClientId,
      manualToken,
      manualTokenExpiry: tokenExpiry || expiry,
      useManualToken:    useManual,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const redirectUri = typeof chrome !== 'undefined' && chrome.identity
    ? chrome.identity.getRedirectURL()
    : 'https://<extension-id>.chromiumapp.org/';

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={drawerStyle} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={drawerHeader}>
          <span style={{ fontWeight: 700, fontSize: 15 }}>Settings</span>
          <button onClick={onClose} style={{ ...iconBtn, marginLeft: 'auto' }}>
            <X size={16} />
          </button>
        </div>

        <div style={scrollArea}>

          {/* ── Environments ──────────────────────────────────────────── */}
          <section style={section}>
            <div style={sectionTitle}>
              <ChevronRight size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />
              Environments
            </div>
            <p style={helpText}>Configure up to 6 Cloud Composer Airflow URLs.</p>

            {envs.map((env, i) => (
              <EnvRow
                key={i}
                env={env}
                onEdit={e => { setEditingEnv(e); setEditingIdx(i); }}
                onDelete={() => deleteEnv(i)}
              />
            ))}

            {editingEnv !== null && (
              <EnvForm
                initial={editingEnv}
                onSave={saveEnv}
                onCancel={() => { setEditingEnv(null); setEditingIdx(null); }}
              />
            )}

            {envs.length < 6 && editingEnv === null && (
              <button
                onClick={() => { setEditingEnv({}); setEditingIdx(null); }}
                style={addEnvBtn}
              >
                <Plus size={14} /> Add environment
              </button>
            )}
          </section>

          {/* ── Authentication ────────────────────────────────────────── */}
          <section style={section}>
            <div style={sectionTitle}>
              <ChevronRight size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />
              Authentication
            </div>

            {/* Mode toggle */}
            <div style={{ display: 'flex', gap: 0, marginBottom: 12, borderRadius: 7, overflow: 'hidden', border: '1px solid #E2E8F0' }}>
              {(['manual', 'oauth'] as const).map(mode => (
                <button
                  key={mode}
                  onClick={() => setUseManual(mode === 'manual')}
                  style={{
                    flex: 1, padding: '7px 0', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    border: 'none',
                    background: (mode === 'manual') === useManual ? '#6366F1' : '#F8FAFC',
                    color:      (mode === 'manual') === useManual ? '#fff'    : '#64748B',
                    transition: 'all 0.15s',
                  }}
                >
                  {mode === 'manual' ? 'Manual Token' : 'OAuth (launchWebAuthFlow)'}
                </button>
              ))}
            </div>

            {useManual ? (
              <>
                <p style={helpText}>
                  Paste a GCP Bearer token from{' '}
                  <code style={{ background: '#F1F5F9', padding: '1px 4px', borderRadius: 3, fontSize: 11 }}>
                    gcloud auth print-access-token
                  </code>
                  . Tokens expire after ~60 minutes.
                </p>
                <label style={labelStyle}>Bearer token</label>
                <input
                  type="password"
                  value={manualToken}
                  onChange={e => setManualToken(e.target.value)}
                  placeholder="ya29.xxx…"
                  style={inputStyle}
                />
              </>
            ) : (
              <>
                <p style={helpText}>
                  Requires a GCP OAuth 2.0 client (Web Application type) with this redirect URI
                  whitelisted:{' '}
                  <code style={{ background: '#F1F5F9', padding: '1px 4px', borderRadius: 3, fontSize: 10, wordBreak: 'break-all' }}>
                    {redirectUri}
                  </code>
                  <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer"
                    style={{ marginLeft: 6, color: '#6366F1', fontSize: 11 }}>
                    Open GCP Console <ExternalLink size={10} style={{ verticalAlign: 'middle' }} />
                  </a>
                </p>
                <label style={labelStyle}>OAuth 2.0 Client ID</label>
                <input
                  value={oauthClientId}
                  onChange={e => setOauthClientId(e.target.value)}
                  placeholder="xxx.apps.googleusercontent.com"
                  style={inputStyle}
                />
              </>
            )}

            <button onClick={handleSaveAuth} style={primaryBtn(true)}>
              {saved ? '✓ Saved' : 'Save auth settings'}
            </button>
          </section>

        </div>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const overlayStyle: React.CSSProperties = {
  position:  'fixed', inset: 0, zIndex: 100,
  background: 'rgba(15,23,42,0.45)',
  display:   'flex', justifyContent: 'flex-end',
};

const drawerStyle: React.CSSProperties = {
  width:        380,
  height:       '100%',
  background:   '#fff',
  display:      'flex',
  flexDirection:'column',
  boxShadow:    '-4px 0 24px rgba(0,0,0,0.18)',
};

const drawerHeader: React.CSSProperties = {
  display:      'flex',
  alignItems:   'center',
  padding:      '14px 16px',
  borderBottom: '1px solid #E2E8F0',
  flexShrink:   0,
};

const scrollArea: React.CSSProperties = { flex: 1, overflow: 'auto', padding: '8px 0' };

const section: React.CSSProperties = {
  padding:      '16px',
  borderBottom: '1px solid #F1F5F9',
};

const sectionTitle: React.CSSProperties = {
  fontWeight:   700,
  fontSize:     12,
  color:        '#374151',
  textTransform:'uppercase',
  letterSpacing:'0.06em',
  marginBottom: 8,
};

const helpText: React.CSSProperties = {
  fontSize: 12, color: '#64748B', marginBottom: 10, lineHeight: 1.55,
};

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 11, fontWeight: 600, color: '#374151', marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  width:        '100%',
  padding:      '7px 10px',
  fontSize:     12,
  border:       '1px solid #E2E8F0',
  borderRadius: 6,
  outline:      'none',
  marginBottom: 10,
  boxSizing:    'border-box',
  fontFamily:   'Inter, system-ui, sans-serif',
};

const rowStyle: React.CSSProperties = {
  display:      'flex',
  alignItems:   'center',
  gap:          8,
  padding:      '8px 10px',
  background:   '#F8FAFC',
  borderRadius: 7,
  marginBottom: 6,
  border:       '1px solid #E2E8F0',
};

const iconBtn: React.CSSProperties = {
  background:   'none',
  border:       'none',
  cursor:       'pointer',
  color:        '#64748B',
  padding:      4,
  borderRadius: 4,
  display:      'flex',
  alignItems:   'center',
};

const addEnvBtn: React.CSSProperties = {
  display:      'flex',
  alignItems:   'center',
  gap:          6,
  fontSize:     12,
  fontWeight:   600,
  color:        '#6366F1',
  background:   '#EEF2FF',
  border:       '1px dashed #A5B4FC',
  borderRadius: 7,
  padding:      '8px 12px',
  cursor:       'pointer',
  width:        '100%',
  marginTop:    4,
};

const primaryBtn = (enabled: boolean): React.CSSProperties => ({
  padding:      '8px 16px',
  background:   enabled ? '#6366F1' : '#E2E8F0',
  color:        enabled ? '#fff'    : '#9CA3AF',
  border:       'none',
  borderRadius: 7,
  fontSize:     12,
  fontWeight:   600,
  cursor:       enabled ? 'pointer' : 'not-allowed',
});

const secondaryBtn: React.CSSProperties = {
  padding:      '8px 16px',
  background:   '#F1F5F9',
  color:        '#374151',
  border:       'none',
  borderRadius: 7,
  fontSize:     12,
  fontWeight:   600,
  cursor:       'pointer',
};
