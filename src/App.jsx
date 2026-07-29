import React, { useState, useEffect, useCallback } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { supabase } from './supabaseClient';
import Login from './Login';
import ResetPassword from './ResetPassword';
import ChatBot from './ChatBot';
import { REGIONS, getUnitInfo } from './locationConfig';
import { getAllowedBuildingIds, NODE_PLACEMENT } from './accessConfig';
import {
  Zap, Search, LogOut, Factory, CheckCircle2, AlertTriangle, AlertOctagon,
  Clock, ChevronRight, MapPin, Cpu, Wind, Filter as FilterIcon, Wifi, WifiOff, ShieldCheck, ArrowRight, Wrench, Plus,
  Maximize2, X,
} from 'lucide-react';

const REFRESH_INTERVAL_MS = 15000;
const STALE_THRESHOLD_MS = 30 * 60 * 1000;
const ACCENT = '#E86A00';

const AHU_IMAGE_SRC = '/ahu-schematic.png';

const PIN_POSITIONS = {
  filter: { x: 81, y: 40, side: 'top', dist: 140 },
  motor: { x: 57, y: 48, side: 'top', dist: 110 },
  belt: { x: 66, y: 44, side: 'bottom', dist: 150 },
};

// Recommended service interval per component, in days — tune to your real maintenance schedule.
const SERVICE_INTERVAL_DAYS = { motor: 180, belt: 90, filter: 60 };

const SENSOR_LINES = [
  { key: 'motor_temperature', label: 'Motor Temp', unit: '°C', color: '#CC0C39' },
  { key: 'motor_vibration', label: 'Vibration', unit: 'mm/s', color: '#7C3AED' },
  { key: 'motor_current', label: 'Motor Current', unit: 'A', color: '#2874F0' },
  { key: 'motor_rpm', label: 'Motor RPM', unit: 'rpm', color: '#0F766E' },
  { key: 'blower_rpm', label: 'Blower RPM', unit: 'rpm', color: ACCENT },
  { key: 'filter_dp', label: 'Filter ΔP', unit: 'Pa', color: '#1E7E34' },
];

const statusMeta = {
  healthy: { label: 'All good', color: '#1E7E34', bg: '#E9F6EC', border: '#C3E6CB', Icon: CheckCircle2 },
  warning: { label: 'Needs attention', color: '#946200', bg: '#FFF3D6', border: '#F5DE9A', Icon: AlertTriangle },
  critical: { label: 'Act now', color: '#CC0C39', bg: '#FDECEA', border: '#F5C6CE', Icon: AlertOctagon },
  unknown: { label: 'Waiting for data', color: '#565959', bg: '#F1F3F6', border: '#E3E6E8', Icon: Clock },
};

function classify(pred) {
  if (!pred) return 'unknown';
  if (pred.is_anomaly) return 'critical';
  if (pred.predicted_fault && pred.predicted_fault !== 'HEALTHY') return 'warning';
  return 'healthy';
}

function timeAgo(iso) {
  if (!iso) return '—';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function daysAgo(dateStr) {
  if (!dateStr) return null;
  const diff = (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24);
  return Math.floor(diff);
}

function isReporting(latest) {
  if (!latest?.scored_at) return false;
  return Date.now() - new Date(latest.scored_at).getTime() < STALE_THRESHOLD_MS;
}

function getNodeStatuses(latest) {
  const overall = classify(latest);
  const fault = (latest?.predicted_fault || '').toUpperCase();
  const escalate = overall === 'critical' ? 'critical' : overall === 'warning' ? 'warning' : 'healthy';

  const motorMatch = /MOTOR|BEARING|ROTOR|SHAFT|OVERLOAD|OVERHEAT/.test(fault);
  const beltMatch = /BELT|SLIP|LOOSENESS|MISALIGN/.test(fault);
  const filterMatch = /FILTER|DUST|CLOG|BLOCK/.test(fault);

  return {
    motor: motorMatch ? escalate : 'healthy',
    belt: beltMatch ? escalate : 'healthy',
    filter: filterMatch ? escalate : 'healthy',
    overall,
  };
}

export default function App() {
  const [session, setSession] = useState(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [isPasswordRecovery, setIsPasswordRecovery] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setCheckingSession(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') setIsPasswordRecovery(true);
      setSession(session);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  if (checkingSession) return null;
  if (isPasswordRecovery) return <ResetPassword onDone={() => setIsPasswordRecovery(false)} />;
  if (!session) return <Login onLogin={setSession} />;
  return <Dashboard session={session} />;
}

function Dashboard({ session }) {
  const [predictions, setPredictions] = useState([]);
  const [maintenanceLogs, setMaintenanceLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastFetch, setLastFetch] = useState(null);
  const [search, setSearch] = useState('');

  const role = session.user.user_metadata?.role || 'admin';
  const scope = session.user.user_metadata?.scope || 'ALL';
  const allowedBuildingIds = getAllowedBuildingIds(role, scope, REGIONS);

  const initialView = role === 'engineer' ? 'nodes' : role === 'manager' ? 'units' : 'regions';
  const [view, setView] = useState(initialView);
  const [selectedRegion, setSelectedRegion] = useState(role === 'manager' ? scope : null);
  const [selectedBuildingId, setSelectedBuildingId] = useState(role === 'engineer' ? scope : null);

  const SUPABASE_URL = "https://xmnpvguxhnnumwimhsvo.supabase.co";
  const SUPABASE_KEY = "sb_publishable_uxRRYKxXbIkYCQD2ftblzA_sJ9n8knY";

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/predictions?select=*&order=scored_at.desc&limit=300`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      setPredictions(await res.json());
      setError(null);
      setLastFetch(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchMaintenance = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('maintenance_log')
        .select('*')
        .order('maintenance_date', { ascending: false });
      if (!error) setMaintenanceLogs(data || []);
    } catch (e) {
      // non-fatal — maintenance log is supplementary
    }
  }, []);

  useEffect(() => {
    fetchData();
    fetchMaintenance();
    const id = setInterval(fetchData, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchData, fetchMaintenance]);

  const byBuilding = {};
  predictions.forEach((p) => {
    const id = p.building_id ?? 'unassigned';
    if (!byBuilding[id]) byBuilding[id] = [];
    byBuilding[id].push(p);
  });
  Object.values(byBuilding).forEach((arr) =>
    arr.sort((a, b) => new Date(b.scored_at) - new Date(a.scored_at))
  );

  const rank = { healthy: 0, unknown: 0, warning: 1, critical: 2 };

  const visibleRegions = Object.keys(REGIONS).filter((r) =>
    REGIONS[r].units.some((u) => allowedBuildingIds.includes(u.buildingId))
  );

  function regionStatus(regionKey) {
    const unitIds = REGIONS[regionKey].units.map((u) => u.buildingId);
    return unitIds.reduce((worst, id) => {
      const s = classify(byBuilding[id]?.[0]);
      return rank[s] > rank[worst] ? s : worst;
    }, 'healthy');
  }

  function regionWorstUnit(regionKey) {
    const units = REGIONS[regionKey].units.filter((u) => allowedBuildingIds.includes(u.buildingId));
    let best = null;
    units.forEach((u) => {
      const latest = byBuilding[u.buildingId]?.[0];
      const s = classify(latest);
      if (!best || rank[s] > rank[best.status]) {
        best = { name: u.name, buildingId: u.buildingId, status: s, fault: latest?.predicted_fault || null };
      }
    });
    return best;
  }

  const overallStatus = visibleRegions.reduce(
    (worst, r) => (rank[regionStatus(r)] > rank[worst] ? regionStatus(r) : worst),
    'healthy'
  );
  const overallMeta = statusMeta[overallStatus];
  const OverallIcon = overallMeta.Icon;
  const visibleUnits = visibleRegions.flatMap((r) => REGIONS[r].units).filter((u) => allowedBuildingIds.includes(u.buildingId));
  const totalUnits = visibleUnits.length;
  const healthyUnits = visibleUnits.filter((u) => classify(byBuilding[u.buildingId]?.[0]) === 'healthy').length;

  let overallWorstUnit = null;
  visibleUnits.forEach((u) => {
    const latest = byBuilding[u.buildingId]?.[0];
    const s = classify(latest);
    if (!overallWorstUnit || rank[s] > rank[overallWorstUnit.status]) {
      overallWorstUnit = { name: u.name, status: s, fault: latest?.predicted_fault || null };
    }
  });

  return (
    <div style={styles.page}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; }
        body { margin: 0; }
        .hover-card { transition: border-color 0.15s ease, box-shadow 0.15s ease; cursor: pointer; }
        .hover-card:hover { border-color: #C7CDD4; box-shadow: 0 4px 14px rgba(15,17,17,0.08); }
        input:focus, textarea:focus { outline: none; border-color: ${ACCENT} !important; box-shadow: 0 0 0 3px rgba(232,106,0,0.14); }
        .nx-crumb { cursor: pointer; transition: color 0.15s ease; }
        .nx-crumb:hover { color: ${ACCENT}; }
        .nx-logout-btn:hover { background: #F1F3F6; }
        .nx-maint-btn:hover { background: #F1F3F6; }
        .nx-trend-card { transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease; cursor: pointer; }
        .nx-trend-card:hover { border-color: #C7CDD4; box-shadow: 0 4px 14px rgba(15,17,17,0.10); transform: translateY(-1px); }
        .nx-expand-btn { opacity: 0; transition: opacity 0.15s ease; }
        .nx-trend-card:hover .nx-expand-btn { opacity: 1; }
        .nx-modal-close:hover { background: #F1F3F6; }
        @keyframes nx-flow {
          0% { background-position: 0 0; }
          100% { background-position: 28px 0; }
        }
        @keyframes nx-modal-in {
          from { opacity: 0; transform: scale(0.97); }
          to { opacity: 1; transform: scale(1); }
        }
      `}</style>

      <nav style={styles.nav}>
        <div style={styles.navLeft}>
          <span style={styles.logoIcon}><Zap size={18} color={ACCENT} fill={ACCENT} /></span>
          <span style={styles.logoText}>Nexora</span>
        </div>
        <div style={styles.searchWrap}>
          <Search size={14} color="#8A93A3" />
          <input
            style={styles.searchInput}
            placeholder="Search unit number…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div style={styles.navRight}>
          <div style={styles.roleBadge}>
            <ShieldCheck size={12} /> {role.charAt(0).toUpperCase() + role.slice(1)}
          </div>
          <div style={styles.avatar}>{session.user.email[0].toUpperCase()}</div>
          <button className="nx-logout-btn" style={styles.logoutBtn} onClick={() => supabase.auth.signOut()}>
            <LogOut size={13} /> Log out
          </button>
        </div>
      </nav>

      <div style={styles.trustBar}>
        <ShieldCheck size={13} /> Equipment monitoring, synced every 15 seconds
      </div>

      <div style={styles.hero}>
        <div style={styles.heroContent}>
          <div style={styles.heroEyebrow}>PLANT OVERVIEW</div>
          <h1 style={styles.heroTitle}>How's your plant doing today?</h1>
          <div style={{ ...styles.heroBadge, background: overallMeta.bg, color: overallMeta.color, border: `1px solid ${overallMeta.border}` }}>
            <OverallIcon size={18} />
            <div>
              <div style={styles.heroBadgeLabel}>{overallMeta.label}</div>
              <div style={styles.heroBadgeSub}>
                {loading ? 'Connecting…' : lastFetch ? `Updated ${timeAgo(lastFetch.toISOString())}` : '—'}
              </div>
              {overallWorstUnit && overallWorstUnit.status !== 'healthy' && (
                <div style={styles.heroBadgeCallout}>
                  {overallWorstUnit.name}{overallWorstUnit.fault ? ` — ${overallWorstUnit.fault}` : ''}
                </div>
              )}
            </div>
          </div>
          <div style={styles.heroStats}>
            <div style={styles.heroStat}>
              <div style={styles.heroStatNum}>{totalUnits}</div>
              <div style={styles.heroStatLabel}>Units tracked</div>
            </div>
            <div style={styles.heroStat}>
              <div style={styles.heroStatNum}>{healthyUnits}</div>
              <div style={styles.heroStatLabel}>Running healthy</div>
            </div>
            <div style={styles.heroStat}>
              <div style={styles.heroStatNum}>{predictions.length}</div>
              <div style={styles.heroStatLabel}>Readings logged</div>
            </div>
          </div>
        </div>
      </div>

      <div style={styles.content}>
        <div style={styles.breadcrumb}>
          {role === 'admin' && (
            <span
              className="nx-crumb"
              style={view === 'regions' ? styles.crumbActive : styles.crumbInactive}
              onClick={() => { setView('regions'); setSelectedRegion(null); setSelectedBuildingId(null); }}
            >
              All Regions
            </span>
          )}
          {role === 'manager' && (
            <span style={styles.crumbActive}>{REGIONS[selectedRegion]?.name}</span>
          )}
          {role === 'admin' && selectedRegion && (
            <>
              <ChevronRight size={13} color="#8A93A3" />
              <span
                className="nx-crumb"
                style={view === 'units' ? styles.crumbActive : styles.crumbInactive}
                onClick={() => { setView('units'); setSelectedBuildingId(null); }}
              >
                {REGIONS[selectedRegion].name}
              </span>
            </>
          )}
          {(role === 'admin' || role === 'manager') && selectedBuildingId && (
            <>
              <ChevronRight size={13} color="#8A93A3" />
              <span style={styles.crumbActive}>{getUnitInfo(selectedBuildingId).name}</span>
            </>
          )}
          {role === 'engineer' && (
            <span style={styles.crumbActive}>{getUnitInfo(selectedBuildingId).name}</span>
          )}
        </div>

        {error && <div style={styles.errorBanner}>Couldn't reach Supabase: {error}</div>}

        {view === 'regions' && role === 'admin' && (
          <section style={styles.cardGrid}>
            {visibleRegions.map((regionKey) => (
              <RegionCard
                key={regionKey}
                regionKey={regionKey}
                status={regionStatus(regionKey)}
                worstUnit={regionWorstUnit(regionKey)}
                onClick={() => { setSelectedRegion(regionKey); setView('units'); }}
              />
            ))}
          </section>
        )}

        {view === 'units' && selectedRegion && (
          <section style={styles.cardGrid}>
            {REGIONS[selectedRegion].units
              .filter((u) => allowedBuildingIds.includes(u.buildingId))
              .filter((u) => !search.trim() || u.buildingId.includes(search.trim()))
              .map((u) => (
                <UnitCard
                  key={u.buildingId}
                  unit={u}
                  latest={byBuilding[u.buildingId]?.[0]}
                  onClick={() => { setSelectedBuildingId(u.buildingId); setView('nodes'); }}
                />
              ))}
          </section>
        )}

        {view === 'nodes' && selectedBuildingId && (
          <NodeView
            buildingId={selectedBuildingId}
            history={byBuilding[selectedBuildingId] || []}
            maintenanceLogs={maintenanceLogs.filter((m) => String(m.building_id) === String(selectedBuildingId))}
            onLogMaintenance={async (component, date, notes) => {
              await supabase.from('maintenance_log').insert({
                building_id: String(selectedBuildingId),
                component,
                maintenance_date: date,
                notes,
              });
              fetchMaintenance();
            }}
            onBack={role !== 'engineer' ? () => { setView('units'); setSelectedBuildingId(null); } : null}
            onHome={
              role === 'admin'
                ? () => { setView('regions'); setSelectedRegion(null); setSelectedBuildingId(null); }
                : null
            }
          />
        )}

        {(view === 'regions' || (role === 'manager' && view === 'units') || (role === 'engineer' && view === 'nodes')) && (
          <section style={styles.logSection}>
            <h2 style={styles.sectionTitle}>Recent activity</h2>
            <div style={styles.logList}>
              {predictions
                .filter((p) => allowedBuildingIds.includes(String(p.building_id)))
                .slice(0, 15)
                .map((p) => {
                  const status = classify(p);
                  const meta = statusMeta[status];
                  const info = getUnitInfo(p.building_id);
                  return (
                    <div key={p.id} style={styles.logRow}>
                      <div style={{ ...styles.logDot, background: meta.color }} />
                      <div style={styles.logMain}>
                        <div style={styles.logTitle}>
                          {info.name} · {p.predicted_fault || 'No fault detected'}
                        </div>
                        <div style={styles.logSub}>
                          Est. {p.predicted_remaining_life_days != null ? `${Number(p.predicted_remaining_life_days).toFixed(1)} days left` : 'life unknown'}
                        </div>
                      </div>
                      <div style={styles.logTime}>{timeAgo(p.scored_at)}</div>
                    </div>
                  );
                })}
              {predictions.length === 0 && <div style={styles.logEmpty}>Nothing logged yet.</div>}
            </div>
          </section>
        )}
      </div>

      <ChatBot role={role} scope={scope} />
    </div>
  );
}

function RegionCard({ regionKey, status, worstUnit, onClick }) {
  const meta = statusMeta[status];
  const Icon = meta.Icon;
  return (
    <div className="hover-card" style={styles.card} onClick={onClick}>
      <div style={styles.cardTop}>
        <div style={styles.cardTopLeft}>
          <div style={{ ...styles.cardEmoji, background: meta.bg, border: `1px solid ${meta.border}` }}>
            <MapPin size={18} color={meta.color} />
          </div>
          <div>
            <div style={styles.cardTitle}>{REGIONS[regionKey].name}</div>
            <div style={styles.cardSub}>{REGIONS[regionKey].units.length} units</div>
          </div>
        </div>
        <div style={{ ...styles.ratingChip, background: meta.bg, color: meta.color, border: `1px solid ${meta.border}` }}>
          <Icon size={12} /> {meta.label}
        </div>
      </div>
      {status !== 'healthy' && worstUnit && (
        <div style={{ ...styles.offenderCallout, background: meta.bg, border: `1px solid ${meta.border}`, color: meta.color }}>
          <Icon size={12} />
          <span>
            <strong>{worstUnit.name}</strong>{worstUnit.fault ? ` is facing ${worstUnit.fault.replaceAll('_', ' ').toLowerCase()}` : ' needs attention'}
          </span>
        </div>
      )}
      <div style={styles.expandHint}><ChevronRight size={12} /> View units</div>
    </div>
  );
}

function UnitCard({ unit, latest, onClick }) {
  const status = classify(latest);
  const meta = statusMeta[status];
  const Icon = meta.Icon;
  const reporting = isReporting(latest);
  return (
    <div className="hover-card" style={styles.card} onClick={onClick}>
      <div style={styles.cardTop}>
        <div style={styles.cardTopLeft}>
          <div style={{ ...styles.cardEmoji, background: meta.bg, border: `1px solid ${meta.border}` }}>
            <Factory size={18} color={meta.color} />
          </div>
          <div>
            <div style={styles.cardTitle}>{unit.name}</div>
            <div style={styles.cardSub}>AHU · Unit #{unit.buildingId}</div>
          </div>
        </div>
        <div style={{ ...styles.ratingChip, background: meta.bg, color: meta.color, border: `1px solid ${meta.border}` }}>
          <Icon size={12} /> {meta.label}
        </div>
      </div>
      <div style={styles.statsRow}>
        <div style={styles.statBox}>
          <div style={styles.statLabel}>Predicted fault</div>
          <div style={styles.statValue}>{latest?.predicted_fault || '—'}</div>
        </div>
        <div style={styles.statBox}>
          <div style={styles.statLabel}>Remaining life</div>
          <div style={styles.statValue}>
            {latest?.predicted_remaining_life_days != null ? `${Number(latest.predicted_remaining_life_days).toFixed(1)}d` : '—'}
          </div>
        </div>
      </div>
      <div style={{ ...styles.reportingRow, color: reporting ? '#1E7E34' : '#8A93A3' }}>
        {reporting ? <Wifi size={12} /> : <WifiOff size={12} />} {reporting ? 'Reporting live' : 'Not reporting'}
      </div>
      <div style={styles.expandHint}><ChevronRight size={12} /> View node layout</div>
    </div>
  );
}

/* ---------- Gauge (speedometer-style) ---------- */

function polarPoint(cx, cy, r, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad) };
}

function Gauge({ fraction, size = 108 }) {
  const clamped = Math.max(0, Math.min(1, fraction));
  const cx = 54, cy = 54, r = 42;
  const startAngle = 180;
  const endAngle = 180 - clamped * 180;
  const p0 = polarPoint(cx, cy, r, 180);
  const p1 = polarPoint(cx, cy, r, 0);
  const pCurrent = polarPoint(cx, cy, r, endAngle);

  const color = clamped < 0.6 ? '#1E7E34' : clamped < 1 ? '#946200' : '#CC0C39';

  return (
    <svg width={size} height={size * 0.62} viewBox="0 0 108 68">
      <path
        d={`M ${p0.x} ${p0.y} A ${r} ${r} 0 0 1 ${p1.x} ${p1.y}`}
        fill="none" stroke="#E3E6E8" strokeWidth="9" strokeLinecap="round"
      />
      <path
        d={`M ${p0.x} ${p0.y} A ${r} ${r} 0 0 1 ${pCurrent.x} ${pCurrent.y}`}
        fill="none" stroke={color} strokeWidth="9" strokeLinecap="round"
      />
    </svg>
  );
}

/* ---------- Maintenance card with gauge + log-record form ---------- */

function MaintenanceCard({ componentKey, label, Icon, logs, onLog }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const componentLogs = logs.filter((m) => m.component === componentKey);
  const last = componentLogs[0]; // already sorted desc by maintenance_date
  const interval = SERVICE_INTERVAL_DAYS[componentKey];
  const since = last ? daysAgo(last.maintenance_date) : null;
  const fraction = since != null ? since / interval : null;
  const daysRemaining = since != null ? Math.max(0, interval - since) : null;

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    await onLog(componentKey, date, notes);
    setSaving(false);
    setNotes('');
    setOpen(false);
  }

  return (
    <div style={styles.maintCard}>
      <div style={styles.maintCardTop}>
        <Icon size={15} color="#565959" />
        <span style={styles.maintCardLabel}>{label}</span>
      </div>

      {fraction != null ? (
        <>
          <Gauge fraction={fraction} />
          <div style={styles.maintDaysRemaining}>
            {daysRemaining}d <span style={styles.maintDaysRemainingSub}>to next service</span>
          </div>
          <div style={styles.maintLastServiced}>
            Last serviced {since}d ago · {new Date(last.maintenance_date).toLocaleDateString()}
          </div>
        </>
      ) : (
        <div style={styles.maintNoRecord}>No maintenance logged yet</div>
      )}

      {!open ? (
        <button className="nx-maint-btn" style={styles.maintLogBtn} onClick={() => setOpen(true)}>
          <Plus size={12} /> Log maintenance
        </button>
      ) : (
        <form onSubmit={handleSubmit} style={styles.maintForm}>
          <label style={styles.maintFormLabel}>Date</label>
          <input
            type="date" value={date} onChange={(e) => setDate(e.target.value)}
            style={styles.maintFormInput} required
          />
          <label style={styles.maintFormLabel}>Notes (optional)</label>
          <textarea
            value={notes} onChange={(e) => setNotes(e.target.value)}
            style={styles.maintFormTextarea} rows={2} placeholder="What was done…"
          />
          <div style={styles.maintFormBtnRow}>
            <button type="button" style={styles.maintFormCancel} onClick={() => setOpen(false)}>Cancel</button>
            <button type="submit" style={styles.maintFormSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/* ---------- AHU diagram: photo with pins ---------- */

function AhuPin({ pos, segment, reporting }) {
  const meta = statusMeta[segment.status];
  const Icon = segment.Icon;
  const isTop = pos.side === 'top';

  return (
    <div
      style={{
        position: 'absolute',
        left: `${pos.x}%`,
        top: `${pos.y}%`,
        transform: isTop ? 'translate(-50%, -100%)' : 'translate(-50%, 0%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        zIndex: 2,
      }}
    >
      {isTop && (
        <div style={{ ...styles.pinCard, borderColor: meta.border }}>
          <PinCardBody segment={segment} meta={meta} Icon={Icon} reporting={reporting} />
        </div>
      )}
      {isTop && <div style={{ ...styles.pinLine, height: pos.dist ?? styles.pinLine.height, background: meta.color }} />}
      <div style={{ ...styles.pinDot, background: meta.color, borderColor: '#fff' }} />
      {!isTop && <div style={{ ...styles.pinLine, height: pos.dist ?? styles.pinLine.height, background: meta.color }} />}
      {!isTop && (
        <div style={{ ...styles.pinCard, borderColor: meta.border }}>
          <PinCardBody segment={segment} meta={meta} Icon={Icon} reporting={reporting} />
        </div>
      )}
    </div>
  );
}

function PinCardBody({ segment, meta, Icon, reporting }) {
  return (
    <>
      <div style={styles.pinCardHeader}>
        <Icon size={13} color={meta.color} />
        <span style={styles.pinCardLabel}>{segment.label}</span>
        <span style={{ ...styles.pinStatusChip, background: meta.bg, color: meta.color }}>{meta.label}</span>
      </div>
      <div style={segment.stats.length > 1 ? styles.pinStatGrid : styles.pinStatSingle}>
        {segment.stats.map((s, i) => (
          <div key={i} style={styles.pinStatCell}>
            <div style={styles.pinStatValue}>{s.value}</div>
            <div style={styles.pinStatLabel}>{s.label}</div>
          </div>
        ))}
      </div>
      <div style={{ ...styles.pinReporting, color: reporting ? '#1E7E34' : '#8A93A3' }}>
        {reporting ? <Wifi size={9} /> : <WifiOff size={9} />} {reporting ? 'Reporting' : 'No data'}
      </div>
    </>
  );
}

/* ---------- Sensor trend chart (shared by card + modal) ---------- */

function SensorLineChart({ data, s, height, fontSize = 9.5, showGrid = true }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 14, left: 4, bottom: 24 }}>
        {showGrid && <CartesianGrid stroke="#E3E6E8" strokeDasharray="3 3" vertical={false} />}
        <XAxis
          dataKey="time"
          tick={{ fill: '#565959', fontSize }}
          axisLine={{ stroke: '#D5D9D9' }}
          tickLine={false}
          interval="preserveStartEnd"
          label={{ value: 'Time', position: 'insideBottom', offset: -16, fontSize: fontSize + 0.5, fill: '#565959', fontWeight: 600 }}
        />
        <YAxis
          tick={{ fill: '#565959', fontSize }}
          axisLine={{ stroke: '#D5D9D9' }}
          tickLine={false}
          width={48}
          label={{
            value: s.unit ? `${s.label} (${s.unit})` : s.label,
            angle: -90,
            position: 'insideLeft',
            fontSize: fontSize + 0.5,
            fill: '#565959',
            fontWeight: 600,
          }}
        />
        <Tooltip
          contentStyle={{ background: '#131A2C', border: 'none', borderRadius: 8, fontSize: 12 }}
          labelStyle={{ color: '#D1D5DB' }}
          itemStyle={{ color: s.color }}
          formatter={(value) => [`${value}${s.unit ? ' ' + s.unit : ''}`, s.label]}
        />
        <Line type="monotone" dataKey="value" stroke={s.color} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}

function TrendCard({ s, data, hasData, onExpand }) {
  return (
    <div className="nx-trend-card" style={styles.trendCard} onClick={onExpand}>
      <div style={styles.trendCardHeader}>
        <span style={{ ...styles.trendDot, background: s.color }} />
        <span style={styles.trendCardTitle}>{s.label}</span>
        {s.unit && <span style={styles.trendCardUnit}>({s.unit})</span>}
        <button className="nx-expand-btn" style={styles.expandBtn} onClick={(e) => { e.stopPropagation(); onExpand(); }} aria-label="Expand chart">
          <Maximize2 size={12} />
        </button>
      </div>
      {hasData ? (
        <SensorLineChart data={data} s={s} height={150} />
      ) : (
        <div style={styles.trendEmpty}>No data yet</div>
      )}
    </div>
  );
}

function TrendModal({ s, data, hasData, onClose }) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modalCard} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <div style={styles.modalHeaderLeft}>
            <span style={{ ...styles.trendDot, background: s.color, width: 11, height: 11 }} />
            <span style={styles.modalTitle}>{s.label}</span>
            {s.unit && <span style={styles.modalUnit}>({s.unit})</span>}
          </div>
          <button className="nx-modal-close" style={styles.modalCloseBtn} onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div style={styles.modalBody}>
          {hasData ? (
            <SensorLineChart data={data} s={s} height={440} fontSize={12} />
          ) : (
            <div style={{ ...styles.trendEmpty, padding: '60px 0' }}>No data yet</div>
          )}
        </div>
      </div>
    </div>
  );
}

function NodeView({ buildingId, history, maintenanceLogs, onLogMaintenance, onBack, onHome }) {
  const latest = history[0];
  const nodes = getNodeStatuses(latest);
  const info = getUnitInfo(buildingId);
  const overallMeta = statusMeta[nodes.overall];
  const OverallIcon = overallMeta.Icon;
  const reporting = isReporting(latest);
  const [expandedKey, setExpandedKey] = useState(null);

  const trendHistory = [...history].slice(0, 30).reverse();

  const segments = [
    {
      key: 'filter', label: 'Filter', Icon: FilterIcon, status: nodes.filter,
      stats: [
        { label: 'Filter ΔP', value: latest?.filter_dp != null ? `${Number(latest.filter_dp).toFixed(1)} Pa` : '—' },
      ],
    },
    {
      key: 'belt', label: 'Belt / Blower', Icon: Wind, status: nodes.belt,
      stats: [
        { label: 'Blower RPM', value: latest?.blower_rpm != null ? Number(latest.blower_rpm).toFixed(0) : '—' },
      ],
    },
    {
      key: 'motor', label: 'Motor', Icon: Cpu, status: nodes.motor,
      stats: [
        { label: 'Motor Temp', value: latest?.motor_temperature != null ? `${Number(latest.motor_temperature).toFixed(1)}°C` : '—' },
        { label: 'Vibration', value: latest?.motor_vibration != null ? Number(latest.motor_vibration).toFixed(2) : '—' },
        { label: 'Motor Current', value: latest?.motor_current != null ? `${Number(latest.motor_current).toFixed(1)} A` : '—' },
        { label: 'Motor RPM', value: latest?.motor_rpm != null ? Number(latest.motor_rpm).toFixed(0) : '—' },
      ],
    },
  ];

  const sensorDataByKey = {};
  SENSOR_LINES.forEach((s) => {
    sensorDataByKey[s.key] = trendHistory.map((p) => ({
      time: new Date(p.scored_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      value: p[s.key],
    }));
  });

  const expandedSensor = expandedKey ? SENSOR_LINES.find((s) => s.key === expandedKey) : null;
  const expandedData = expandedKey ? sensorDataByKey[expandedKey] : null;
  const expandedHasData = expandedData ? expandedData.some((d) => d.value != null) : false;

  return (
    <div style={styles.nodeViewWrap}>
      {(onBack || onHome) && (
        <div style={styles.navBackRow}>
          {onBack && (
            <button style={styles.navBackBtn} onClick={onBack}>
              <ChevronRight size={13} style={{ transform: 'rotate(180deg)' }} /> Back to units
            </button>
          )}
          {onHome && (
            <button style={styles.navBackBtn} onClick={onHome}>
              <MapPin size={13} /> Main menu
            </button>
          )}
        </div>
      )}

      <div style={{ ...styles.ahuBanner, background: overallMeta.bg, color: overallMeta.color, border: `1px solid ${overallMeta.border}` }}>
        <OverallIcon size={20} />
        <div>
          <div style={{ fontWeight: 700, fontSize: 14.5 }}>{info.name} — AHU Health: {overallMeta.label}</div>
          <div style={{ fontSize: 12, opacity: 0.85 }}>
            Predicted fault: {latest?.predicted_fault || '—'} · Est. remaining life: {latest?.predicted_remaining_life_days != null ? `${Number(latest.predicted_remaining_life_days).toFixed(1)}d` : '—'}
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700 }}>
          {reporting ? <Wifi size={14} /> : <WifiOff size={14} />} {reporting ? 'Live' : 'Offline'}
        </div>
      </div>

      <div style={styles.diagramCard}>
        <div style={styles.diagramHeaderRow}>
          <div style={styles.diagramTitle}>Unit layout — AHU components</div>
          <div style={styles.diagramTag}>AHU-{String(buildingId)} · Draw-through</div>
        </div>

        <div style={styles.ahuPhotoRow}>
          <div style={styles.ahuPhotoOuter}>
            <div style={styles.ahuPhotoInner}>
              <img src={AHU_IMAGE_SRC} alt="Air handling unit schematic" style={styles.ahuPhotoImg} />
            </div>
            {segments.map((seg) => (
              <AhuPin key={seg.key} pos={PIN_POSITIONS[seg.key]} segment={seg} reporting={reporting} />
            ))}
          </div>
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>Maintenance</div>
        <div style={styles.maintGrid}>
          <MaintenanceCard componentKey="motor" label="Motor" Icon={Cpu} logs={maintenanceLogs} onLog={onLogMaintenance} />
          <MaintenanceCard componentKey="belt" label="Belt" Icon={Wind} logs={maintenanceLogs} onLog={onLogMaintenance} />
          <MaintenanceCard componentKey="filter" label="Filter" Icon={FilterIcon} logs={maintenanceLogs} onLog={onLogMaintenance} />
        </div>
      </div>

      {trendHistory.length > 1 && (
        <div style={styles.card}>
          <div style={styles.trendSectionHeaderRow}>
            <div style={styles.cardTitle}>Sensor trends</div>
            <div style={styles.trendSectionHint}>Click any chart to view full size</div>
          </div>
          <div style={styles.trendGrid}>
            {SENSOR_LINES.map((s) => {
              const data = sensorDataByKey[s.key];
              const hasData = data.some((d) => d.value != null);
              return (
                <TrendCard
                  key={s.key}
                  s={s}
                  data={data}
                  hasData={hasData}
                  onExpand={() => setExpandedKey(s.key)}
                />
              );
            })}
          </div>
        </div>
      )}

      {expandedSensor && (
        <TrendModal
          s={expandedSensor}
          data={expandedData}
          hasData={expandedHasData}
          onClose={() => setExpandedKey(null)}
        />
      )}
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', fontFamily: "'Inter', sans-serif", color: '#0F1111', background: '#F1F3F6' },

  nav: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 28px',
    background: '#131A2C', position: 'sticky', top: 0, zIndex: 10, gap: 16, flexWrap: 'wrap',
  },
  navLeft: { display: 'flex', alignItems: 'center', gap: 9 },
  logoIcon: { display: 'inline-flex' },
  logoText: { fontWeight: 700, fontSize: 17, color: '#FFFFFF' },
  searchWrap: { flex: 1, maxWidth: 380, display: 'flex', alignItems: 'center', gap: 8, background: '#FFFFFF', border: '2px solid transparent', borderRadius: 8, padding: '9px 13px' },
  searchInput: { border: 'none', background: 'transparent', fontSize: 14, width: '100%', fontFamily: "'Inter', sans-serif", color: '#0F1111' },
  navRight: { display: 'flex', alignItems: 'center', gap: 12 },
  roleBadge: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, color: ACCENT, background: 'rgba(232,106,0,0.14)', padding: '5px 10px', borderRadius: 7 },
  avatar: { width: 32, height: 32, borderRadius: 8, background: ACCENT, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 12 },
  logoutBtn: { border: '1px solid #3A465F', background: 'transparent', borderRadius: 8, padding: '7px 13px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', color: '#FFFFFF', display: 'flex', alignItems: 'center', gap: 6 },

  trustBar: {
    background: '#FFF3D6', color: '#795000', fontSize: 12, fontWeight: 600, textAlign: 'center',
    padding: '7px 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  },

  hero: { background: '#131A2C', padding: '32px 28px 40px', color: '#fff' },
  heroContent: { maxWidth: 1120, margin: '0 auto' },
  heroEyebrow: { fontSize: 11.5, letterSpacing: 1.4, opacity: 0.6, fontWeight: 700, marginBottom: 10 },
  heroTitle: { fontSize: 26, fontWeight: 700, margin: '0 0 16px', letterSpacing: -0.2 },
  heroBadge: { display: 'inline-flex', alignItems: 'center', gap: 10, padding: '9px 16px', borderRadius: 10, marginBottom: 22 },
  heroBadgeLabel: { fontWeight: 700, fontSize: 14 },
  heroBadgeSub: { fontSize: 11, opacity: 0.85 },
  heroBadgeCallout: { fontSize: 12, fontWeight: 700, marginTop: 5 },
  heroStats: { display: 'flex', gap: 30 },
  heroStat: {},
  heroStatNum: { fontSize: 24, fontWeight: 700, color: '#FFA968' },
  heroStatLabel: { fontSize: 11.5, opacity: 0.7 },

  content: { padding: '28px 28px 64px', maxWidth: 1120, margin: '0 auto' },
  breadcrumb: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 20, fontSize: 13, fontWeight: 600 },
  crumbActive: { color: '#0F1111' },
  crumbInactive: { color: '#8A93A3' },
  errorBanner: { background: '#FDECEA', color: '#CC0C39', padding: '12px 16px', borderRadius: 10, fontSize: 13, marginBottom: 20, fontWeight: 600, border: '1px solid #F5C6CE' },

  cardGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16, marginBottom: 36 },
  card: { background: '#FFFFFF', border: '1px solid #E3E6E8', borderRadius: 12, padding: 18, marginTop: 18 },
  cardTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 },
  cardTopLeft: { display: 'flex', alignItems: 'center', gap: 10 },
  cardEmoji: { width: 38, height: 38, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontWeight: 600, fontSize: 15.5, color: '#0F1111', marginBottom: 4 },
  cardSub: { fontSize: 12, color: '#565959' },
  ratingChip: { fontSize: 11.5, fontWeight: 700, padding: '5px 9px', borderRadius: 7, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 5 },
  statsRow: { display: 'flex', gap: 10, marginBottom: 12 },
  statBox: { flex: 1, background: '#F7F8FA', border: '1px solid #EFF1F4', borderRadius: 10, padding: '9px 11px' },
  statLabel: { fontSize: 9.5, color: '#565959', marginBottom: 3, fontWeight: 600 },
  statValue: { fontSize: 14, fontWeight: 700, color: '#0F1111' },
  reportingRow: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, marginBottom: 8 },
  expandHint: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: ACCENT, fontWeight: 600, marginTop: 6 },
  offenderCallout: { display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 11.5, fontWeight: 600, padding: '8px 10px', borderRadius: 8, marginBottom: 4, lineHeight: 1.4 },

  logSection: {},
  sectionTitle: { fontSize: 18, fontWeight: 600, marginBottom: 12, color: '#0F1111' },
  logList: { background: '#FFFFFF', border: '1px solid #E3E6E8', borderRadius: 12, padding: 6 },
  logRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '11px 13px', borderBottom: '1px solid #F1F3F6' },
  logDot: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
  logMain: { flex: 1, minWidth: 0 },
  logTitle: { fontSize: 13.5, fontWeight: 600, color: '#0F1111' },
  logSub: { fontSize: 11.5, color: '#565959' },
  logTime: { fontSize: 11, color: '#8A93A3', whiteSpace: 'nowrap', fontWeight: 500 },
  logEmpty: { padding: 20, textAlign: 'center', color: '#8A93A3', fontSize: 13 },

  nodeViewWrap: { display: 'flex', flexDirection: 'column', gap: 0 },
  ahuBanner: { display: 'flex', alignItems: 'center', gap: 14, padding: '16px 20px', borderRadius: 12, marginBottom: 18 },

  diagramCard: { background: '#FFFFFF', border: '1px solid #E3E6E8', borderRadius: 12, padding: '20px 24px 26px' },
  diagramHeaderRow: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 18, flexWrap: 'wrap', gap: 8 },
  diagramTitle: { fontWeight: 600, fontSize: 15.5, color: '#0F1111' },
  diagramTag: { fontSize: 11, fontWeight: 700, color: '#8A93A3', letterSpacing: 0.4, textTransform: 'uppercase' },

  navBackRow: { display: 'flex', gap: 8, marginBottom: 12 },
  navBackBtn: {
    display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700, color: '#0F1111',
    background: '#FFFFFF', border: '1px solid #D5D9D9', borderRadius: 8, padding: '7px 12px', cursor: 'pointer',
  },

  ahuPhotoRow: { display: 'flex', justifyContent: 'center', width: '100%' },
  ahuPhotoOuter: { position: 'relative', width: '100%', maxWidth: 760, margin: '150px 0 150px' },
  ahuPhotoInner: { borderRadius: 12, overflow: 'hidden', background: '#FAFBFC', border: '1px solid #E3E6E8' },
  ahuPhotoImg: { display: 'block', width: '100%', height: 'auto' },

  pinDot: { width: 9, height: 9, borderRadius: '50%', border: '2px solid #fff', boxShadow: '0 0 0 1.5px rgba(15,17,17,0.22), 0 1px 4px rgba(15,17,17,0.28)', flexShrink: 0, zIndex: 2 },
  pinLine: { width: 1.5, height: 34, flexShrink: 0, opacity: 0.7 },
  pinCard: { background: '#FFFFFF', border: '1.5px solid', borderRadius: 8, padding: '8px 10px', width: 132, boxShadow: '0 4px 12px rgba(15,17,17,0.10)', marginBottom: 2, marginTop: 2 },
  pinCardHeader: { display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6, flexWrap: 'nowrap' },
  pinCardLabel: { fontWeight: 700, fontSize: 10.5, color: '#0F1111', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  pinStatusChip: { fontSize: 7.5, fontWeight: 700, padding: '2px 6px', borderRadius: 5, marginLeft: 'auto', whiteSpace: 'nowrap' },
  pinStatSingle: { marginBottom: 6 },
  pinStatGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 8px', marginBottom: 6 },
  pinStatCell: {},
  pinStatValue: { fontSize: 12, fontWeight: 700, color: '#0F1111', lineHeight: 1.2 },
  pinStatLabel: { fontSize: 7.5, color: '#8A93A3', fontWeight: 600, letterSpacing: 0.2, marginTop: 1 },
  pinReporting: { display: 'flex', alignItems: 'center', gap: 3, fontSize: 7.5, fontWeight: 600, paddingTop: 5, borderTop: '1px solid #F1F3F6' },

  maintGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 },
  maintCard: { background: '#F7F8FA', border: '1px solid #EFF1F4', borderRadius: 10, padding: '14px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' },
  maintCardTop: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 },
  maintCardLabel: { fontWeight: 700, fontSize: 13, color: '#0F1111' },
  maintDaysRemaining: { fontSize: 18, fontWeight: 700, color: '#0F1111', marginTop: 4 },
  maintDaysRemainingSub: { fontSize: 10, fontWeight: 600, color: '#8A93A3' },
  maintLastServiced: { fontSize: 10.5, color: '#8A93A3', marginTop: 4, marginBottom: 10 },
  maintNoRecord: { fontSize: 11.5, color: '#8A93A3', margin: '18px 0 12px' },
  maintLogBtn: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, color: '#0F1111', background: '#FFFFFF', border: '1px solid #D5D9D9', borderRadius: 8, padding: '6px 12px', cursor: 'pointer' },
  maintForm: { width: '100%', textAlign: 'left', marginTop: 4 },
  maintFormLabel: { fontSize: 10, fontWeight: 700, color: '#565959', display: 'block', marginBottom: 3, marginTop: 6 },
  maintFormInput: { width: '100%', border: '1.5px solid #D5D9D9', borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: "'Inter', sans-serif" },
  maintFormTextarea: { width: '100%', border: '1.5px solid #D5D9D9', borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: "'Inter', sans-serif", resize: 'vertical' },
  maintFormBtnRow: { display: 'flex', gap: 6, marginTop: 8 },
  maintFormCancel: { flex: 1, fontSize: 11.5, fontWeight: 600, color: '#565959', background: '#FFFFFF', border: '1px solid #D5D9D9', borderRadius: 6, padding: '6px 0', cursor: 'pointer' },
  maintFormSave: { flex: 1, fontSize: 11.5, fontWeight: 700, color: '#fff', background: ACCENT, border: 'none', borderRadius: 6, padding: '6px 0', cursor: 'pointer' },

  trendSectionHeaderRow: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6, marginBottom: 4 },
  trendSectionHint: { fontSize: 11, color: '#8A93A3', fontWeight: 500 },
  trendGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 20, marginTop: 14 },
  trendCard: { background: '#F7F8FA', border: '1px solid #EFF1F4', borderRadius: 10, padding: '14px 14px 10px', position: 'relative' },
  trendCardHeader: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 },
  trendDot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  trendCardTitle: { fontSize: 12.5, fontWeight: 700, color: '#0F1111' },
  trendCardUnit: { fontSize: 10.5, color: '#8A93A3' },
  trendEmpty: { fontSize: 11, color: '#8A93A3', padding: '20px 0', textAlign: 'center' },
  expandBtn: {
    marginLeft: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 22, height: 22, borderRadius: 6, border: '1px solid #D5D9D9', background: '#FFFFFF',
    color: '#565959', cursor: 'pointer', flexShrink: 0,
  },

  modalOverlay: {
    position: 'fixed', inset: 0, background: 'rgba(15,17,17,0.55)', display: 'flex',
    alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 24,
  },
  modalCard: {
    background: '#FFFFFF', borderRadius: 14, width: '100%', maxWidth: 880, maxHeight: '88vh',
    display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(15,17,17,0.35)',
    animation: 'nx-modal-in 0.15s ease',
  },
  modalHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '18px 22px', borderBottom: '1px solid #E3E6E8',
  },
  modalHeaderLeft: { display: 'flex', alignItems: 'center', gap: 8 },
  modalTitle: { fontSize: 16, fontWeight: 700, color: '#0F1111' },
  modalUnit: { fontSize: 12.5, color: '#8A93A3', fontWeight: 600 },
  modalCloseBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32,
    borderRadius: 8, border: '1px solid #D5D9D9', background: '#FFFFFF', color: '#0F1111', cursor: 'pointer',
  },
  modalBody: { padding: '20px 24px 28px', overflow: 'auto' },

  trendGridLegacy: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 },
};








