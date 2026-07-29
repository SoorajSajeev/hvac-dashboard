import React, { useState, useEffect, useCallback } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { supabase } from './supabaseClient';
import Login from './Login';
import ResetPassword from './ResetPassword';
import ChatBot from './ChatBot';
import { REGIONS, getUnitInfo } from './locationConfig';
import { getAllowedBuildingIds, NODE_PLACEMENT } from './accessConfig';
import {
  Zap, Search, LogOut, Factory, CheckCircle2, AlertTriangle, AlertOctagon,
  Clock, ChevronRight, MapPin, Cpu, Wind, Filter as FilterIcon, Wifi, WifiOff, ShieldCheck, ArrowRight,
} from 'lucide-react';

const REFRESH_INTERVAL_MS = 15000;
const STALE_THRESHOLD_MS = 30 * 60 * 1000;
const ACCENT = '#E86A00';

// Drop the AHU cutaway photo in your project (e.g. /public/ahu-cutaway.png) and point this at it.
// Drop the AHU schematic in your project's /public folder and point this at it.
const AHU_IMAGE_SRC = '/ahu-schematic.png';

// Pin anchor points as % of image width/height — tuned to the fully-labeled
// schematic (Return Fan / Damper / Pre Filter / coils / Motor / Belt / Supply
// Fan / Final Filter / VFD). Only 3 components carry live fault data today, so
// pins are mapped onto the closest matching labels: Final Filter, Belt, and
// Motor (Supply Fan). "dist" is the leader-line length, tuned per pin so each
// card clears the diagram (and its printed labels) instead of covering them.
const PIN_POSITIONS = {
  filter: { x: 81, y: 40, side: 'top', dist: 140 },    // Final Filter (green dashed box)
  motor: { x: 57, y: 48, side: 'top', dist: 110 },     // Motor (Supply Fan)
  belt: { x: 66, y: 44, side: 'bottom', dist: 150 },   // Belt
};

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

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchData]);

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
        input:focus { outline: none; border-color: ${ACCENT} !important; box-shadow: 0 0 0 3px rgba(232,106,0,0.14); }
        .nx-crumb { cursor: pointer; transition: color 0.15s ease; }
        .nx-crumb:hover { color: ${ACCENT}; }
        .nx-logout-btn:hover { background: #F1F3F6; }
        @keyframes nx-flow {
          0% { background-position: 0 0; }
          100% { background-position: 28px 0; }
        }
        .nx-airflow-duct {
          background-image: repeating-linear-gradient(90deg, rgba(138,147,163,0.55) 0 2px, transparent 2px 14px);
          animation: nx-flow 1.1s linear infinite;
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

/* ---------- AHU diagram: a single unit casing with compartments in-line ---------- */

function CompartmentPanel({ segment, reporting, isLast }) {
  const meta = statusMeta[segment.status];
  const Icon = segment.Icon;
  return (
    <>
      <div style={{ ...styles.compartment, ...(segment.stats.length > 1 ? styles.compartmentWide : null) }}>
        <div style={{ ...styles.compartmentHeader, background: meta.bg, borderBottom: `1px solid ${meta.border}` }}>
          <div style={{ ...styles.compartmentIconWrap, background: '#FFFFFF', border: `1.5px solid ${meta.border}` }}>
            <Icon size={18} color={meta.color} />
          </div>
          <div style={styles.compartmentHeaderText}>
            <div style={styles.compartmentLabel}>{segment.label}</div>
            <div style={{ ...styles.compartmentStatus, color: meta.color }}>{meta.label}</div>
          </div>
          <meta.Icon size={14} color={meta.color} style={{ marginLeft: 'auto' }} />
        </div>

        <div style={styles.compartmentBody}>
          {segment.stats.length > 1 ? (
            <div style={styles.gaugeGrid}>
              {segment.stats.map((s, idx) => (
                <div key={idx} style={styles.gaugeCell}>
                  <div style={styles.gaugeValueGrid}>{s.value}</div>
                  <div style={styles.gaugeLabel}>{s.label}</div>
                </div>
              ))}
            </div>
          ) : (
            <div style={styles.gaugeRow}>
              <div style={styles.gaugeValue}>{segment.stats[0].value}</div>
              <div style={styles.gaugeLabel}>{segment.stats[0].label}</div>
            </div>
          )}
          <div style={styles.compartmentPlacement}>{NODE_PLACEMENT[segment.key]}</div>
          <div style={{ ...styles.compartmentReporting, color: reporting ? '#1E7E34' : '#8A93A3' }}>
            {reporting ? <Wifi size={10} /> : <WifiOff size={10} />} {reporting ? 'Reporting' : 'No data'}
          </div>
        </div>

        {/* access-panel bolts for an equipment-casing feel */}
        <span style={{ ...styles.bolt, top: 7, left: 7 }} />
        <span style={{ ...styles.bolt, top: 7, right: 7 }} />
        <span style={{ ...styles.bolt, bottom: 7, left: 7 }} />
        <span style={{ ...styles.bolt, bottom: 7, right: 7 }} />
      </div>

      {!isLast && (
        <div style={styles.compartmentDivider}>
          <div className="nx-airflow-duct" style={styles.airflowDuct} />
          <ArrowRight size={13} color="#8A93A3" style={styles.airflowArrow} />
        </div>
      )}
    </>
  );
}

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

function NodeView({ buildingId, history, onBack, onHome }) {
  const latest = history[0];
  const nodes = getNodeStatuses(latest);
  const info = getUnitInfo(buildingId);
  const overallMeta = statusMeta[nodes.overall];
  const OverallIcon = overallMeta.Icon;
  const reporting = isReporting(latest);

  const chartData = [...history]
    .slice(0, 20)
    .reverse()
    .map((p) => ({
      time: new Date(p.scored_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      life: p.predicted_remaining_life_days,
    }));

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

      {chartData.length > 1 && (
        <div style={styles.card}>
          <div style={styles.cardTitle}>Remaining life trend</div>
          <div style={{ marginTop: 10 }}>
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={chartData} margin={{ top: 4, right: 4, left: -12, bottom: 0 }}>
                <XAxis dataKey="time" tick={{ fill: '#8A93A3', fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#8A93A3', fontSize: 10 }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{ background: '#131A2C', border: 'none', borderRadius: 8, fontSize: 11 }}
                  labelStyle={{ color: '#D1D5DB' }}
                  itemStyle={{ color: '#FFA968' }}
                />
                <Line type="monotone" dataKey="life" stroke={ACCENT} strokeWidth={2.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
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
  card: { background: '#FFFFFF', border: '1px solid #E3E6E8', borderRadius: 12, padding: 18 },
  cardTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 },
  cardTopLeft: { display: 'flex', alignItems: 'center', gap: 10 },
  cardEmoji: { width: 38, height: 38, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontWeight: 600, fontSize: 15.5, color: '#0F1111' },
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

  nodeViewWrap: { display: 'flex', flexDirection: 'column', gap: 18 },
  ahuBanner: { display: 'flex', alignItems: 'center', gap: 14, padding: '16px 20px', borderRadius: 12 },

  diagramCard: { background: '#FFFFFF', border: '1px solid #E3E6E8', borderRadius: 12, padding: '20px 24px 26px' },
  diagramHeaderRow: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 18, flexWrap: 'wrap', gap: 8 },
  diagramTitle: { fontWeight: 600, fontSize: 15.5, color: '#0F1111' },
  diagramTag: { fontSize: 11, fontWeight: 700, color: '#8A93A3', letterSpacing: 0.4, textTransform: 'uppercase' },

  navBackRow: { display: 'flex', gap: 8, marginBottom: 4 },
  navBackBtn: {
    display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700, color: '#0F1111',
    background: '#FFFFFF', border: '1px solid #D5D9D9', borderRadius: 8, padding: '7px 12px', cursor: 'pointer',
  },

  ahuPhotoRow: {
    display: 'flex',
    justifyContent: 'center',
    width: '100%',
  },
  ahuPhotoOuter: {
    position: 'relative',
    width: '100%',
    maxWidth: 760,
    margin: '150px 0 150px',
  },
  ahuPhotoInner: {
    borderRadius: 12,
    overflow: 'hidden',
    background: '#FAFBFC',
    border: '1px solid #E3E6E8',
  },
  ahuPhotoImg: { display: 'block', width: '100%', height: 'auto' },

  pinDot: {
    width: 9,
    height: 9,
    borderRadius: '50%',
    border: '2px solid #fff',
    boxShadow: '0 0 0 1.5px rgba(15,17,17,0.22), 0 1px 4px rgba(15,17,17,0.28)',
    flexShrink: 0,
    zIndex: 2,
  },
  pinLine: { width: 1.5, height: 34, flexShrink: 0, opacity: 0.7 },
  pinCard: {
    background: '#FFFFFF',
    border: '1.5px solid',
    borderRadius: 8,
    padding: '8px 10px',
    width: 132,
    boxShadow: '0 4px 12px rgba(15,17,17,0.10)',
    marginBottom: 2,
    marginTop: 2,
  },
  pinCardHeader: { display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6, flexWrap: 'nowrap' },
  pinCardLabel: { fontWeight: 700, fontSize: 10.5, color: '#0F1111', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  pinStatusChip: { fontSize: 7.5, fontWeight: 700, padding: '2px 6px', borderRadius: 5, marginLeft: 'auto', whiteSpace: 'nowrap' },
  pinStatSingle: { marginBottom: 6 },
  pinStatGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 8px', marginBottom: 6 },
  pinStatCell: {},
  pinStatValue: { fontSize: 12, fontWeight: 700, color: '#0F1111', lineHeight: 1.2 },
  pinStatLabel: { fontSize: 7.5, color: '#8A93A3', fontWeight: 600, letterSpacing: 0.2, marginTop: 1 },
  pinReporting: { display: 'flex', alignItems: 'center', gap: 3, fontSize: 7.5, fontWeight: 600, paddingTop: 5, borderTop: '1px solid #F1F3F6' },

  ahuUnit: { display: 'flex', alignItems: 'center', gap: 0, width: '100%' },

  ahuCasing: {
    position: 'relative',
    flex: 1,
    margin: '0 2px',
    background: 'linear-gradient(180deg, #F7F8FA 0%, #ECEFF3 100%)',
    border: '2px solid #C7CDD4',
    borderRadius: 14,
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.6), inset 0 -2px 6px rgba(15,17,17,0.04)',
    padding: '38px 20px 16px',
  },
  ahuCasingLabel: {
    position: 'absolute',
    top: 12,
    left: '50%',
    transform: 'translateX(-50%)',
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: 1.2,
    color: '#9AA3B0',
  },
  ahuInterior: { display: 'flex', alignItems: 'stretch' },

  bolt: {
    position: 'absolute',
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: '#B7BEC9',
    boxShadow: 'inset 0 1px 1px rgba(0,0,0,0.25)',
  },

  compartment: {
    position: 'relative',
    flex: 1,
    minWidth: 140,
    background: '#FFFFFF',
    border: '1.5px solid #E3E6E8',
    borderRadius: 10,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  compartmentHeader: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 11px' },
  compartmentIconWrap: { width: 30, height: 30, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  compartmentHeaderText: { display: 'flex', flexDirection: 'column' },
  compartmentLabel: { fontWeight: 700, fontSize: 12.5, color: '#0F1111' },
  compartmentStatus: { fontSize: 10, fontWeight: 700 },

  compartmentBody: { padding: '14px 12px 12px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', flex: 1 },
  gaugeRow: { marginBottom: 10 },
  gaugeValue: { fontSize: 18, fontWeight: 700, color: '#0F1111', lineHeight: 1.2 },
  gaugeLabel: { fontSize: 9.5, color: '#8A93A3', fontWeight: 600, letterSpacing: 0.3, marginTop: 2 },
  gaugeGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '10px 14px',
    width: '100%',
    marginBottom: 10,
  },
  gaugeCell: {
    background: '#F7F8FA',
    border: '1px solid #EFF1F4',
    borderRadius: 8,
    padding: '8px 6px',
  },
  gaugeValueGrid: { fontSize: 14, fontWeight: 700, color: '#0F1111', lineHeight: 1.2 },
  compartmentWide: { minWidth: 210, flex: 1.5 },
  compartmentPlacement: { fontSize: 10, color: '#8A93A3', lineHeight: 1.4, marginBottom: 10, minHeight: 28 },
  compartmentReporting: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 600, marginTop: 'auto' },

  compartmentDivider: { position: 'relative', width: 26, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  airflowDuct: { width: '100%', height: 6, borderRadius: 3, background: '#EFF1F4', border: '1px solid #D5D9D9' },
  airflowArrow: { position: 'absolute' },

  segmentPlacement: { fontSize: 10, color: '#8A93A3', lineHeight: 1.4, marginBottom: 10, minHeight: 28 },
};