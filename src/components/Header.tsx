import { Settings, Layers } from 'lucide-react';

interface HeaderProps {
  onOpenSettings: () => void;
}

export default function Header({ onOpenSettings }: HeaderProps) {
  return (
    <header style={headerStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={logoBox}>
          <Layers size={18} color="#6366F1" />
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, color: '#0F172A', lineHeight: 1 }}>
            Airflow DAG Viewer
          </div>
          <div style={{ fontSize: 10, color: '#94A3B8', marginTop: 2 }}>
            Google Cloud Composer · Interactive SQL Inspector
          </div>
        </div>
      </div>

      <button onClick={onOpenSettings} style={settingsBtn} title="Settings">
        <Settings size={16} />
        <span>Settings</span>
      </button>
    </header>
  );
}

const headerStyle: React.CSSProperties = {
  display:        'flex',
  alignItems:     'center',
  justifyContent: 'space-between',
  padding:        '0 20px',
  height:         56,
  background:     '#fff',
  borderBottom:   '1px solid #E2E8F0',
  flexShrink:     0,
  boxShadow:      '0 1px 4px rgba(0,0,0,0.06)',
};

const logoBox: React.CSSProperties = {
  width:        34,
  height:       34,
  background:   '#EEF2FF',
  borderRadius: 8,
  display:      'flex',
  alignItems:   'center',
  justifyContent:'center',
};

const settingsBtn: React.CSSProperties = {
  display:      'flex',
  alignItems:   'center',
  gap:          6,
  background:   '#F8FAFC',
  border:       '1px solid #E2E8F0',
  borderRadius: 7,
  padding:      '6px 12px',
  cursor:       'pointer',
  fontSize:     12,
  fontWeight:   600,
  color:        '#374151',
};
