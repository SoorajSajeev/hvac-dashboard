import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from './supabaseClient';
import Login from './Login';
import ResetPassword from './ResetPassword';
import ChatBot from './ChatBot';
import { REGIONS, getUnitInfo } from './locationConfig';
import { getAllowedBuildingIds, NODE_PLACEMENT } from './accessConfig';
import {
  Zap, Search, LogOut, Factory, CheckCircle2, AlertTriangle, AlertOctagon,
  Clock, ChevronRight, ChevronDown, ChevronUp, MapPin, Cpu, Wind, Filter as FilterIcon, Wifi, WifiOff, ShieldCheck, Plus, History, Wrench, PackageX,
} from 'lucide-react';

const REFRESH_INTERVAL_MS = 15000;
const STALE_THRESHOLD_MS = 30 * 60 * 1000;
const ACCENT = '#E86A00';

const AHU_IMAGE_SRC = '/ahu-schematic.png';
const INDIA_MAP_IMAGE_SRC = '/india-map.png';

const PIN_POSITIONS = {
  filter: { x: 81, y: 40, side: 'top', dist: 140 },
  motor: { x: 57, y: 48, side: 'top', dist: 110 },
  belt: { x: 66, y: 44, side: 'bottom', dist: 150 },
};

// Recommended service interval per component, in days — tune to your real maintenance schedule.
const SERVICE_INTERVAL_DAYS = { motor: 180, belt: 90, filter: 60 };

// Cities shown on the India overview map. Only cities present as keys in REGIONS
// (see locationConfig.js) are clickable/navigable — the rest show "Coming soon".
// x/y were read directly off /public/india-map.png with a percentage grid overlaid
// on the actual image, then verified by plotting test dots back onto the same PNG
// and visually confirming each one lands inside the correct state's outline.
const MAP_CITIES = [
  { key: 'Delhi', name: 'Delhi', x: 37.0, y: 28.7 },
  { key: 'Gujarat', name: 'Gujarat', x: 19.8, y: 47.1 },
  { key: 'Mumbai', name: 'Mumbai', x: 27.3, y: 59.3 },
  { key: 'Bhubaneswar', name: 'Bhubaneswar', x: 56.2, y: 56.5 },
  { key: 'Hyderabad', name: 'Hyderabad', x: 39.4, y: 66.1 },
  { key: 'Bengaluru', name: 'Bengaluru', x: 34.2, y: 78.9 },
  { key: 'Chennai', name: 'Chennai', x: 44.2, y: 79.3 },
  { key: 'Kerala', name: 'Kerala', x: 33.7, y: 89.7 },
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
  const [comingSoonCity, setComingSoonCity] = useState(null);

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

  function findRegionForBuilding(buildingId) {
    return Object.keys(REGIONS).find((r) => REGIONS[r].units.some((u) => u.buildingId === buildingId));
  }

  // Replacement: unit is in critical condition (anomaly flagged) — needs a new part/unit.
  // Repair: unit has a non-critical predicted fault — needs servicing but isn't failing yet.
  const replacementUnits = visibleUnits
    .map((u) => ({ ...u, latest: byBuilding[u.buildingId]?.[0] }))
    .filter((u) => classify(u.latest) === 'critical');
  const repairUnits = visibleUnits
    .map((u) => ({ ...u, latest: byBuilding[u.buildingId]?.[0] }))
    .filter((u) => classify(u.latest) === 'warning');
  const maintenanceAlertCount = replacementUnits.length + repairUnits.length;

  function handleCityClick(cityKey) {
    if (REGIONS[cityKey]) {
      setSelectedRegion(cityKey);
      setView('units');
    } else {
      setComingSoonCity(cityKey);
      setTimeout(() => setComingSoonCity(null), 2200);
    }
  }

  function goToUnit(buildingId) {
    const regionKey = findRegionForBuilding(buildingId);
    if (regionKey) setSelectedRegion(regionKey);
    setSelectedBuildingId(buildingId);
    setView('nodes');
  }


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
        .nx-map-city { cursor: pointer; transition: transform 0.15s ease; }
        .nx-map-city:hover { transform: scale(1.15); }
        @keyframes nx-pulse { 0%,100% { opacity: 0.5; transform: scale(1); } 50% { opacity: 0; transform: scale(2.2); } }
        .nx-map-pulse { animation: nx-pulse 1.8s ease-out infinite; }
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
          {role === 'admin' && (
            <button
              className="nx-alerts-btn"
              style={{ ...styles.alertsBtn, ...(view === 'maintenance' ? styles.alertsBtnActive : {}) }}
              onClick={() => setView('maintenance')}
            >
              <AlertTriangle size={13} />
              Needs attention
              {maintenanceAlertCount > 0 && <span style={styles.alertsBadge}>{maintenanceAlertCount}</span>}
            </button>
          )}
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
          {role === 'admin' && view === 'maintenance' && (
            <>
              <ChevronRight size={13} color="#8A93A3" />
              <span style={styles.crumbActive}>Needs attention</span>
            </>
          )}
        </div>

        {error && <div style={styles.errorBanner}>Couldn't reach Supabase: {error}</div>}

        {view === 'regions' && role === 'admin' && (
          <>
            <IndiaMap
              cities={MAP_CITIES}
              regionStatus={regionStatus}
              onCityClick={handleCityClick}
              comingSoonCity={comingSoonCity}
            />
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
          </>
        )}

        {view === 'maintenance' && role === 'admin' && (
          <MaintenanceAlerts
            replacementUnits={replacementUnits}
            repairUnits={repairUnits}
            onSelectUnit={goToUnit}
          />
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
            canLogMaintenance={role === 'engineer'}
            onLogMaintenance={async (component, date, notes) => {
              await supabase.from('maintenance_log').insert({
                building_id: String(selectedBuildingId),
                component,
                maintenance_date: date,
                notes,
                engineer_name: session.user.user_metadata?.full_name || session.user.email,
                designation: session.user.user_metadata?.designation || null,
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

/* ---------- India overview map ---------- */

function IndiaMap({ cities, regionStatus, onCityClick, comingSoonCity }) {
  return (
    <div style={styles.mapCard}>
      <div style={styles.mapHeaderRow}>
        <div style={styles.diagramTitle}>Plant locations — India</div>
        <div style={styles.diagramTag}>Tap a city to view units</div>
      </div>

      <div style={styles.mapOuter}>
        <img src={INDIA_MAP_IMAGE_SRC} alt="Map of India" style={styles.mapImg} />

        {cities.map((c) => (
          <CityMarker
            key={c.key}
            city={c}
            regionStatus={regionStatus}
            onClick={() => onCityClick(c.key)}
            showComingSoon={comingSoonCity === c.key}
          />
        ))}
      </div>

      <div style={styles.mapLegendRow}>
        <LegendDot color="#1E7E34" label="Healthy" />
        <LegendDot color="#946200" label="Attention" />
        <LegendDot color="#CC0C39" label="Critical" />
        <LegendDot color="#8A93A3" label="Coming soon" />
      </div>
    </div>
  );
}

function CityMarker({ city, regionStatus, onClick, showComingSoon }) {
  const isConfigured = !!REGIONS[city.key];
  const status = isConfigured ? regionStatus(city.key) : 'unknown';
  const meta = statusMeta[status];
  const dotColor = isConfigured ? meta.color : '#8A93A3';

  return (
    <div
      className="nx-map-city"
      style={{ position: 'absolute', left: `${city.x}%`, top: `${city.y}%`, transform: 'translate(-50%, -50%)' }}
      onClick={onClick}
      title={city.name}
    >
      <div style={{ position: 'relative', width: 16, height: 16 }}>
        {isConfigured && status !== 'healthy' && (
          <div className="nx-map-pulse" style={{ position: 'absolute', inset: -6, borderRadius: '50%', background: dotColor }} />
        )}
        <div style={{ width: 16, height: 16, borderRadius: '50%', background: dotColor, border: '2.5px solid #fff', boxShadow: '0 2px 6px rgba(15,17,17,0.35)' }} />
      </div>

      {showComingSoon && (
        <div style={styles.mapComingSoonBubble}>Coming soon</div>
      )}
    </div>
  );
}

function LegendDot({ color, label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
      <span style={{ fontSize: 11, color: '#565959', fontWeight: 600 }}>{label}</span>
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

/* ---------- Admin: Maintenance Alerts — counts + lists of units needing repair/replacement ---------- */

function MaintenanceAlerts({ replacementUnits, repairUnits, onSelectUnit }) {
  return (
    <section style={{ marginBottom: 36 }}>
      <div style={styles.alertsSummaryGrid}>
        <div style={{ ...styles.alertsSummaryCard, background: statusMeta.critical.bg, border: `1px solid ${statusMeta.critical.border}` }}>
          <div style={{ ...styles.alertsSummaryIcon, background: '#fff' }}>
            <PackageX size={20} color={statusMeta.critical.color} />
          </div>
          <div>
            <div style={{ ...styles.alertsSummaryNum, color: statusMeta.critical.color }}>{replacementUnits.length}</div>
            <div style={styles.alertsSummaryLabel}>Need replacement</div>
          </div>
        </div>
        <div style={{ ...styles.alertsSummaryCard, background: statusMeta.warning.bg, border: `1px solid ${statusMeta.warning.border}` }}>
          <div style={{ ...styles.alertsSummaryIcon, background: '#fff' }}>
            <Wrench size={20} color={statusMeta.warning.color} />
          </div>
          <div>
            <div style={{ ...styles.alertsSummaryNum, color: statusMeta.warning.color }}>{repairUnits.length}</div>
            <div style={styles.alertsSummaryLabel}>Need repair</div>
          </div>
        </div>
      </div>

      <AlertsList
        title="Units needing replacement"
        subtitle="Critical condition — flagged as an anomaly and at high risk of failure."
        units={replacementUnits}
        meta={statusMeta.critical}
        onSelectUnit={onSelectUnit}
      />
      <AlertsList
        title="Units needing repair"
        subtitle="A fault has been predicted but the unit isn't failing yet."
        units={repairUnits}
        meta={statusMeta.warning}
        onSelectUnit={onSelectUnit}
      />
    </section>
  );
}

function AlertsList({ title, subtitle, units, meta, onSelectUnit }) {
  return (
    <div style={styles.card}>
      <div style={styles.cardTitle}>{title}</div>
      <div style={{ fontSize: 12, color: '#565959', marginTop: 2, marginBottom: 14 }}>{subtitle}</div>
      {units.length === 0 ? (
        <div style={styles.logEmpty}>No units in this state right now.</div>
      ) : (
        <div style={styles.logList}>
          {units.map((u) => (
            <div key={u.buildingId} className="hover-card" style={styles.logRow} onClick={() => onSelectUnit(u.buildingId)}>
              <div style={{ ...styles.logDot, background: meta.color }} />
              <div style={styles.logMain}>
                <div style={styles.logTitle}>{u.name} · {u.latest?.predicted_fault || 'Unknown fault'}</div>
                <div style={styles.logSub}>
                  Est. {u.latest?.predicted_remaining_life_days != null ? `${Number(u.latest.predicted_remaining_life_days).toFixed(1)} days left` : 'life unknown'}
                </div>
              </div>
              <ChevronRight size={14} color="#8A93A3" />
            </div>
          ))}
        </div>
      )}
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
  const p0 = polarPoint(cx, cy, r, 180);
  const p1 = polarPoint(cx, cy, r, 0);
  const endAngle = 180 - clamped * 180;
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

/* ---------- Maintenance card: gauge + view-only or log form depending on role ---------- */

function MaintenanceCard({ componentKey, label, Icon, logs, canLog, onLog }) {
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
            {last.engineer_name && <> · by {last.engineer_name}{last.designation ? ` (${last.designation})` : ''}</>}
          </div>
        </>
      ) : (
        <div style={styles.maintNoRecord}>No maintenance logged yet</div>
      )}

      {canLog && (
        !open ? (
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
                {saving ? 'Submitting…' : 'Submit'}
              </button>
            </div>
          </form>
        )
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

/* ---------- Maintenance history report (view-only, all roles, collapsed by default) ---------- */

const COMPONENT_LABELS = { motor: 'Motor', belt: 'Belt', filter: 'Filter' };

function MaintenanceReport({ logs }) {
  const [open, setOpen] = useState(false);
  const sorted = [...logs].sort((a, b) => new Date(b.maintenance_date) - new Date(a.maintenance_date));

  return (
    <div style={styles.card}>
      <button style={styles.maintHistoryToggle} onClick={() => setOpen(!open)}>
        <div style={styles.maintHistoryToggleLeft}>
          <History size={16} color="#565959" />
          <span style={styles.cardTitle}>Maintenance history</span>
          <span style={styles.maintHistoryCount}>{sorted.length}</span>
        </div>
        {open ? <ChevronUp size={16} color="#8A93A3" /> : <ChevronDown size={16} color="#8A93A3" />}
      </button>

      {open && (
        sorted.length === 0 ? (
          <div style={styles.maintReportEmpty}>No maintenance has been logged for this unit yet.</div>
        ) : (
          <div style={styles.maintReportList}>
            {sorted.map((log) => (
              <div key={log.id} style={styles.maintReportRow}>
                <div style={styles.maintReportComponent}>{COMPONENT_LABELS[log.component] || log.component}</div>
                <div style={styles.maintReportMain}>
                  <div style={styles.maintReportDate}>{new Date(log.maintenance_date).toLocaleDateString()}</div>
                  {(log.engineer_name || log.designation) && (
                    <div style={styles.maintReportEngineer}>
                      {log.engineer_name}{log.designation ? ` — ${log.designation}` : ''}
                    </div>
                  )}
                  {log.notes && <div style={styles.maintReportNotes}>{log.notes}</div>}
                </div>
                <div style={styles.maintReportAgo}>{daysAgo(log.maintenance_date)}d ago</div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

function NodeView({ buildingId, history, maintenanceLogs, canLogMaintenance, onLogMaintenance, onBack, onHome }) {
  const latest = history[0];
  const nodes = getNodeStatuses(latest);
  const info = getUnitInfo(buildingId);
  const overallMeta = statusMeta[nodes.overall];
  const OverallIcon = overallMeta.Icon;
  const reporting = isReporting(latest);

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

      <div style={styles.card}>
        <div style={styles.cardTitle}>Maintenance</div>
        {!canLogMaintenance && (
          <div style={styles.maintViewOnlyNote}>Only the assigned engineer for this unit can log maintenance.</div>
        )}
        <div style={styles.maintGrid}>
          <MaintenanceCard componentKey="motor" label="Motor" Icon={Cpu} logs={maintenanceLogs} canLog={canLogMaintenance} onLog={onLogMaintenance} />
          <MaintenanceCard componentKey="belt" label="Belt" Icon={Wind} logs={maintenanceLogs} canLog={canLogMaintenance} onLog={onLogMaintenance} />
          <MaintenanceCard componentKey="filter" label="Filter" Icon={FilterIcon} logs={maintenanceLogs} canLog={canLogMaintenance} onLog={onLogMaintenance} />
        </div>
      </div>

      <MaintenanceReport logs={maintenanceLogs} />
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
  alertsBtn: {
    display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: '#FFFFFF',
    background: 'transparent', border: '1px solid #3A465F', borderRadius: 8, padding: '7px 12px', cursor: 'pointer',
  },
  alertsBtnActive: { background: 'rgba(232,106,0,0.18)', borderColor: ACCENT },
  alertsBadge: {
    background: '#CC0C39', color: '#fff', fontSize: 10.5, fontWeight: 800, borderRadius: 999,
    padding: '1px 6px', lineHeight: 1.4,
  },
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

  alertsSummaryGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginBottom: 8 },
  alertsSummaryCard: { display: 'flex', alignItems: 'center', gap: 14, borderRadius: 12, padding: '18px 20px' },
  alertsSummaryIcon: { width: 44, height: 44, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 1px 4px rgba(15,17,17,0.12)' },
  alertsSummaryNum: { fontSize: 26, fontWeight: 800, lineHeight: 1.1 },
  alertsSummaryLabel: { fontSize: 12.5, fontWeight: 700, color: '#0F1111', marginTop: 2 },

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

  mapCard: { background: '#FFFFFF', border: '1px solid #E3E6E8', borderRadius: 12, padding: '20px 24px 24px', marginBottom: 24 },
  mapHeaderRow: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 },
  mapOuter: { position: 'relative', width: '100%', maxWidth: 640, margin: '0 auto' },
  mapImg: { display: 'block', width: '100%', height: 'auto' },
  mapCityRow: { display: 'flex', alignItems: 'center', gap: 6 },
  mapCityLabel: { fontSize: 12, fontWeight: 700, color: '#0F1111', whiteSpace: 'nowrap' },
  mapComingSoonBubble: {
    position: 'absolute', top: -30, left: '50%', transform: 'translateX(-50%)',
    background: '#131A2C', color: '#fff', fontSize: 10, fontWeight: 700, padding: '4px 9px',
    borderRadius: 6, whiteSpace: 'nowrap', boxShadow: '0 4px 10px rgba(15,17,17,0.25)',
  },
  mapLegendRow: { display: 'flex', gap: 18, justifyContent: 'center', marginTop: 18, flexWrap: 'wrap' },

  maintViewOnlyNote: { fontSize: 11.5, color: '#8A93A3', marginBottom: 14, marginTop: -8 },
  maintGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 },
  maintCard: { background: '#F7F8FA', border: '1px solid #EFF1F4', borderRadius: 10, padding: '14px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' },
  maintCardTop: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 },
  maintCardLabel: { fontWeight: 700, fontSize: 13, color: '#0F1111' },
  maintDaysRemaining: { fontSize: 18, fontWeight: 700, color: '#0F1111', marginTop: 4 },
  maintDaysRemainingSub: { fontSize: 10, fontWeight: 600, color: '#8A93A3' },
  maintLastServiced: { fontSize: 10.5, color: '#8A93A3', marginTop: 4, marginBottom: 10, lineHeight: 1.4 },
  maintNoRecord: { fontSize: 11.5, color: '#8A93A3', margin: '18px 0 12px' },
  maintLogBtn: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, color: '#0F1111', background: '#FFFFFF', border: '1px solid #D5D9D9', borderRadius: 8, padding: '6px 12px', cursor: 'pointer' },
  maintForm: { width: '100%', textAlign: 'left', marginTop: 4 },
  maintFormLabel: { fontSize: 10, fontWeight: 700, color: '#565959', display: 'block', marginBottom: 3, marginTop: 6 },
  maintFormInput: { width: '100%', border: '1.5px solid #D5D9D9', borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: "'Inter', sans-serif" },
  maintFormTextarea: { width: '100%', border: '1.5px solid #D5D9D9', borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: "'Inter', sans-serif", resize: 'vertical' },
  maintFormBtnRow: { display: 'flex', gap: 6, marginTop: 8 },
  maintFormCancel: { flex: 1, fontSize: 11.5, fontWeight: 600, color: '#565959', background: '#FFFFFF', border: '1px solid #D5D9D9', borderRadius: 6, padding: '6px 0', cursor: 'pointer' },
  maintFormSave: { flex: 1, fontSize: 11.5, fontWeight: 700, color: '#fff', background: ACCENT, border: 'none', borderRadius: 6, padding: '6px 0', cursor: 'pointer' },

  maintHistoryToggle: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' },
  maintHistoryToggleLeft: { display: 'flex', alignItems: 'center', gap: 8 },
  maintHistoryCount: { fontSize: 11, fontWeight: 700, color: '#8A93A3', background: '#F1F3F6', borderRadius: 10, padding: '1px 8px' },
  maintReportEmpty: { fontSize: 12.5, color: '#8A93A3', padding: '14px 0 0' },
  maintReportList: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 14 },
  maintReportRow: { display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 4px', borderBottom: '1px solid #F1F3F6' },
  maintReportComponent: { fontSize: 11.5, fontWeight: 700, color: ACCENT, background: '#FFF3E5', borderRadius: 6, padding: '3px 8px', flexShrink: 0, minWidth: 52, textAlign: 'center' },
  maintReportMain: { flex: 1, minWidth: 0 },
  maintReportDate: { fontSize: 13, fontWeight: 600, color: '#0F1111' },
  maintReportEngineer: { fontSize: 11.5, color: ACCENT, fontWeight: 600, marginTop: 2 },
  maintReportNotes: { fontSize: 12, color: '#565959', marginTop: 2 },
  maintReportAgo: { fontSize: 11, color: '#8A93A3', whiteSpace: 'nowrap', fontWeight: 500 },
};    return () => listener.subscription.unsubscribe();
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
  const [comingSoonCity, setComingSoonCity] = useState(null);

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

  function findRegionForBuilding(buildingId) {
    return Object.keys(REGIONS).find((r) => REGIONS[r].units.some((u) => u.buildingId === buildingId));
  }

  // Replacement: unit is in critical condition (anomaly flagged) — needs a new part/unit.
  // Repair: unit has a non-critical predicted fault — needs servicing but isn't failing yet.
  const replacementUnits = visibleUnits
    .map((u) => ({ ...u, latest: byBuilding[u.buildingId]?.[0] }))
    .filter((u) => classify(u.latest) === 'critical');
  const repairUnits = visibleUnits
    .map((u) => ({ ...u, latest: byBuilding[u.buildingId]?.[0] }))
    .filter((u) => classify(u.latest) === 'warning');
  const maintenanceAlertCount = replacementUnits.length + repairUnits.length;

  function handleCityClick(cityKey) {
    if (REGIONS[cityKey]) {
      setSelectedRegion(cityKey);
      setView('units');
    } else {
      setComingSoonCity(cityKey);
      setTimeout(() => setComingSoonCity(null), 2200);
    }
  }

  function goToUnit(buildingId) {
    const regionKey = findRegionForBuilding(buildingId);
    if (regionKey) setSelectedRegion(regionKey);
    setSelectedBuildingId(buildingId);
    setView('nodes');
  }


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
        .nx-map-city { cursor: pointer; transition: transform 0.15s ease; }
        .nx-map-city:hover { transform: scale(1.15); }
        @keyframes nx-pulse { 0%,100% { opacity: 0.5; transform: scale(1); } 50% { opacity: 0; transform: scale(2.2); } }
        .nx-map-pulse { animation: nx-pulse 1.8s ease-out infinite; }
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
          {role === 'admin' && (
            <button
              className="nx-alerts-btn"
              style={{ ...styles.alertsBtn, ...(view === 'maintenance' ? styles.alertsBtnActive : {}) }}
              onClick={() => setView('maintenance')}
            >
              <AlertTriangle size={13} />
              Needs attention
              {maintenanceAlertCount > 0 && <span style={styles.alertsBadge}>{maintenanceAlertCount}</span>}
            </button>
          )}
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
          {role === 'admin' && view === 'maintenance' && (
            <>
              <ChevronRight size={13} color="#8A93A3" />
              <span style={styles.crumbActive}>Needs attention</span>
            </>
          )}
        </div>

        {error && <div style={styles.errorBanner}>Couldn't reach Supabase: {error}</div>}

        {view === 'regions' && role === 'admin' && (
          <>
            <IndiaMap
              cities={MAP_CITIES}
              regionStatus={regionStatus}
              onCityClick={handleCityClick}
              comingSoonCity={comingSoonCity}
            />
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
          </>
        )}

        {view === 'maintenance' && role === 'admin' && (
          <MaintenanceAlerts
            replacementUnits={replacementUnits}
            repairUnits={repairUnits}
            onSelectUnit={goToUnit}
          />
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
            canLogMaintenance={role === 'engineer'}
            onLogMaintenance={async (component, date, notes) => {
              await supabase.from('maintenance_log').insert({
                building_id: String(selectedBuildingId),
                component,
                maintenance_date: date,
                notes,
                engineer_name: session.user.user_metadata?.full_name || session.user.email,
                designation: session.user.user_metadata?.designation || null,
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

/* ---------- India overview map ---------- */

function IndiaMap({ cities, regionStatus, onCityClick, comingSoonCity }) {
  return (
    <div style={styles.mapCard}>
      <div style={styles.mapHeaderRow}>
        <div style={styles.diagramTitle}>Plant locations — India</div>
        <div style={styles.diagramTag}>Tap a city to view units</div>
      </div>

      <div style={styles.mapOuter}>
        <img src={INDIA_MAP_IMAGE_SRC} alt="Map of India" style={styles.mapImg} />

        {cities.map((c) => (
          <CityMarker
            key={c.key}
            city={c}
            regionStatus={regionStatus}
            onClick={() => onCityClick(c.key)}
            showComingSoon={comingSoonCity === c.key}
          />
        ))}
      </div>

      <div style={styles.mapLegendRow}>
        <LegendDot color="#1E7E34" label="Healthy" />
        <LegendDot color="#946200" label="Attention" />
        <LegendDot color="#CC0C39" label="Critical" />
        <LegendDot color="#8A93A3" label="Coming soon" />
      </div>
    </div>
  );
}

function CityMarker({ city, regionStatus, onClick, showComingSoon }) {
  const isConfigured = !!REGIONS[city.key];
  const status = isConfigured ? regionStatus(city.key) : 'unknown';
  const meta = statusMeta[status];
  const dotColor = isConfigured ? meta.color : '#8A93A3';

  return (
    <div
      className="nx-map-city"
      style={{ position: 'absolute', left: `${city.x}%`, top: `${city.y}%`, transform: 'translate(-50%, -50%)' }}
      onClick={onClick}
      title={city.name}
    >
      <div style={{ position: 'relative', width: 16, height: 16 }}>
        {isConfigured && status !== 'healthy' && (
          <div className="nx-map-pulse" style={{ position: 'absolute', inset: -6, borderRadius: '50%', background: dotColor }} />
        )}
        <div style={{ width: 16, height: 16, borderRadius: '50%', background: dotColor, border: '2.5px solid #fff', boxShadow: '0 2px 6px rgba(15,17,17,0.35)' }} />
      </div>

      {showComingSoon && (
        <div style={styles.mapComingSoonBubble}>Coming soon</div>
      )}
    </div>
  );
}

function LegendDot({ color, label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
      <span style={{ fontSize: 11, color: '#565959', fontWeight: 600 }}>{label}</span>
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

/* ---------- Admin: Maintenance Alerts — counts + lists of units needing repair/replacement ---------- */

function MaintenanceAlerts({ replacementUnits, repairUnits, onSelectUnit }) {
  return (
    <section style={{ marginBottom: 36 }}>
      <div style={styles.alertsSummaryGrid}>
        <div style={{ ...styles.alertsSummaryCard, background: statusMeta.critical.bg, border: `1px solid ${statusMeta.critical.border}` }}>
          <div style={{ ...styles.alertsSummaryIcon, background: '#fff' }}>
            <PackageX size={20} color={statusMeta.critical.color} />
          </div>
          <div>
            <div style={{ ...styles.alertsSummaryNum, color: statusMeta.critical.color }}>{replacementUnits.length}</div>
            <div style={styles.alertsSummaryLabel}>Need replacement</div>
          </div>
        </div>
        <div style={{ ...styles.alertsSummaryCard, background: statusMeta.warning.bg, border: `1px solid ${statusMeta.warning.border}` }}>
          <div style={{ ...styles.alertsSummaryIcon, background: '#fff' }}>
            <Wrench size={20} color={statusMeta.warning.color} />
          </div>
          <div>
            <div style={{ ...styles.alertsSummaryNum, color: statusMeta.warning.color }}>{repairUnits.length}</div>
            <div style={styles.alertsSummaryLabel}>Need repair</div>
          </div>
        </div>
      </div>

      <AlertsList
        title="Units needing replacement"
        subtitle="Critical condition — flagged as an anomaly and at high risk of failure."
        units={replacementUnits}
        meta={statusMeta.critical}
        onSelectUnit={onSelectUnit}
      />
      <AlertsList
        title="Units needing repair"
        subtitle="A fault has been predicted but the unit isn't failing yet."
        units={repairUnits}
        meta={statusMeta.warning}
        onSelectUnit={onSelectUnit}
      />
    </section>
  );
}

function AlertsList({ title, subtitle, units, meta, onSelectUnit }) {
  return (
    <div style={styles.card}>
      <div style={styles.cardTitle}>{title}</div>
      <div style={{ fontSize: 12, color: '#565959', marginTop: 2, marginBottom: 14 }}>{subtitle}</div>
      {units.length === 0 ? (
        <div style={styles.logEmpty}>No units in this state right now.</div>
      ) : (
        <div style={styles.logList}>
          {units.map((u) => (
            <div key={u.buildingId} className="hover-card" style={styles.logRow} onClick={() => onSelectUnit(u.buildingId)}>
              <div style={{ ...styles.logDot, background: meta.color }} />
              <div style={styles.logMain}>
                <div style={styles.logTitle}>{u.name} · {u.latest?.predicted_fault || 'Unknown fault'}</div>
                <div style={styles.logSub}>
                  Est. {u.latest?.predicted_remaining_life_days != null ? `${Number(u.latest.predicted_remaining_life_days).toFixed(1)} days left` : 'life unknown'}
                </div>
              </div>
              <ChevronRight size={14} color="#8A93A3" />
            </div>
          ))}
        </div>
      )}
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
  const p0 = polarPoint(cx, cy, r, 180);
  const p1 = polarPoint(cx, cy, r, 0);
  const endAngle = 180 - clamped * 180;
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

/* ---------- Maintenance card: gauge + view-only or log form depending on role ---------- */

function MaintenanceCard({ componentKey, label, Icon, logs, canLog, onLog }) {
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
            {last.engineer_name && <> · by {last.engineer_name}{last.designation ? ` (${last.designation})` : ''}</>}
          </div>
        </>
      ) : (
        <div style={styles.maintNoRecord}>No maintenance logged yet</div>
      )}

      {canLog && (
        !open ? (
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
                {saving ? 'Submitting…' : 'Submit'}
              </button>
            </div>
          </form>
        )
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

/* ---------- Maintenance history report (view-only, all roles, collapsed by default) ---------- */

const COMPONENT_LABELS = { motor: 'Motor', belt: 'Belt', filter: 'Filter' };

function MaintenanceReport({ logs }) {
  const [open, setOpen] = useState(false);
  const sorted = [...logs].sort((a, b) => new Date(b.maintenance_date) - new Date(a.maintenance_date));

  return (
    <div style={styles.card}>
      <button style={styles.maintHistoryToggle} onClick={() => setOpen(!open)}>
        <div style={styles.maintHistoryToggleLeft}>
          <History size={16} color="#565959" />
          <span style={styles.cardTitle}>Maintenance history</span>
          <span style={styles.maintHistoryCount}>{sorted.length}</span>
        </div>
        {open ? <ChevronUp size={16} color="#8A93A3" /> : <ChevronDown size={16} color="#8A93A3" />}
      </button>

      {open && (
        sorted.length === 0 ? (
          <div style={styles.maintReportEmpty}>No maintenance has been logged for this unit yet.</div>
        ) : (
          <div style={styles.maintReportList}>
            {sorted.map((log) => (
              <div key={log.id} style={styles.maintReportRow}>
                <div style={styles.maintReportComponent}>{COMPONENT_LABELS[log.component] || log.component}</div>
                <div style={styles.maintReportMain}>
                  <div style={styles.maintReportDate}>{new Date(log.maintenance_date).toLocaleDateString()}</div>
                  {(log.engineer_name || log.designation) && (
                    <div style={styles.maintReportEngineer}>
                      {log.engineer_name}{log.designation ? ` — ${log.designation}` : ''}
                    </div>
                  )}
                  {log.notes && <div style={styles.maintReportNotes}>{log.notes}</div>}
                </div>
                <div style={styles.maintReportAgo}>{daysAgo(log.maintenance_date)}d ago</div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

function NodeView({ buildingId, history, maintenanceLogs, canLogMaintenance, onLogMaintenance, onBack, onHome }) {
  const latest = history[0];
  const nodes = getNodeStatuses(latest);
  const info = getUnitInfo(buildingId);
  const overallMeta = statusMeta[nodes.overall];
  const OverallIcon = overallMeta.Icon;
  const reporting = isReporting(latest);

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

      <div style={styles.card}>
        <div style={styles.cardTitle}>Maintenance</div>
        {!canLogMaintenance && (
          <div style={styles.maintViewOnlyNote}>Only the assigned engineer for this unit can log maintenance.</div>
        )}
        <div style={styles.maintGrid}>
          <MaintenanceCard componentKey="motor" label="Motor" Icon={Cpu} logs={maintenanceLogs} canLog={canLogMaintenance} onLog={onLogMaintenance} />
          <MaintenanceCard componentKey="belt" label="Belt" Icon={Wind} logs={maintenanceLogs} canLog={canLogMaintenance} onLog={onLogMaintenance} />
          <MaintenanceCard componentKey="filter" label="Filter" Icon={FilterIcon} logs={maintenanceLogs} canLog={canLogMaintenance} onLog={onLogMaintenance} />
        </div>
      </div>

      <MaintenanceReport logs={maintenanceLogs} />
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
  alertsBtn: {
    display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: '#FFFFFF',
    background: 'transparent', border: '1px solid #3A465F', borderRadius: 8, padding: '7px 12px', cursor: 'pointer',
  },
  alertsBtnActive: { background: 'rgba(232,106,0,0.18)', borderColor: ACCENT },
  alertsBadge: {
    background: '#CC0C39', color: '#fff', fontSize: 10.5, fontWeight: 800, borderRadius: 999,
    padding: '1px 6px', lineHeight: 1.4,
  },
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

  alertsSummaryGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginBottom: 8 },
  alertsSummaryCard: { display: 'flex', alignItems: 'center', gap: 14, borderRadius: 12, padding: '18px 20px' },
  alertsSummaryIcon: { width: 44, height: 44, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 1px 4px rgba(15,17,17,0.12)' },
  alertsSummaryNum: { fontSize: 26, fontWeight: 800, lineHeight: 1.1 },
  alertsSummaryLabel: { fontSize: 12.5, fontWeight: 700, color: '#0F1111', marginTop: 2 },

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

  mapCard: { background: '#FFFFFF', border: '1px solid #E3E6E8', borderRadius: 12, padding: '20px 24px 24px', marginBottom: 24 },
  mapHeaderRow: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 },
  mapOuter: { position: 'relative', width: '100%', maxWidth: 640, margin: '0 auto' },
  mapImg: { display: 'block', width: '100%', height: 'auto' },
  mapCityRow: { display: 'flex', alignItems: 'center', gap: 6 },
  mapCityLabel: { fontSize: 12, fontWeight: 700, color: '#0F1111', whiteSpace: 'nowrap' },
  mapComingSoonBubble: {
    position: 'absolute', top: -30, left: '50%', transform: 'translateX(-50%)',
    background: '#131A2C', color: '#fff', fontSize: 10, fontWeight: 700, padding: '4px 9px',
    borderRadius: 6, whiteSpace: 'nowrap', boxShadow: '0 4px 10px rgba(15,17,17,0.25)',
  },
  mapLegendRow: { display: 'flex', gap: 18, justifyContent: 'center', marginTop: 18, flexWrap: 'wrap' },

  maintViewOnlyNote: { fontSize: 11.5, color: '#8A93A3', marginBottom: 14, marginTop: -8 },
  maintGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 },
  maintCard: { background: '#F7F8FA', border: '1px solid #EFF1F4', borderRadius: 10, padding: '14px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' },
  maintCardTop: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 },
  maintCardLabel: { fontWeight: 700, fontSize: 13, color: '#0F1111' },
  maintDaysRemaining: { fontSize: 18, fontWeight: 700, color: '#0F1111', marginTop: 4 },
  maintDaysRemainingSub: { fontSize: 10, fontWeight: 600, color: '#8A93A3' },
  maintLastServiced: { fontSize: 10.5, color: '#8A93A3', marginTop: 4, marginBottom: 10, lineHeight: 1.4 },
  maintNoRecord: { fontSize: 11.5, color: '#8A93A3', margin: '18px 0 12px' },
  maintLogBtn: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, color: '#0F1111', background: '#FFFFFF', border: '1px solid #D5D9D9', borderRadius: 8, padding: '6px 12px', cursor: 'pointer' },
  maintForm: { width: '100%', textAlign: 'left', marginTop: 4 },
  maintFormLabel: { fontSize: 10, fontWeight: 700, color: '#565959', display: 'block', marginBottom: 3, marginTop: 6 },
  maintFormInput: { width: '100%', border: '1.5px solid #D5D9D9', borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: "'Inter', sans-serif" },
  maintFormTextarea: { width: '100%', border: '1.5px solid #D5D9D9', borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: "'Inter', sans-serif", resize: 'vertical' },
  maintFormBtnRow: { display: 'flex', gap: 6, marginTop: 8 },
  maintFormCancel: { flex: 1, fontSize: 11.5, fontWeight: 600, color: '#565959', background: '#FFFFFF', border: '1px solid #D5D9D9', borderRadius: 6, padding: '6px 0', cursor: 'pointer' },
  maintFormSave: { flex: 1, fontSize: 11.5, fontWeight: 700, color: '#fff', background: ACCENT, border: 'none', borderRadius: 6, padding: '6px 0', cursor: 'pointer' },

  maintHistoryToggle: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' },
  maintHistoryToggleLeft: { display: 'flex', alignItems: 'center', gap: 8 },
  maintHistoryCount: { fontSize: 11, fontWeight: 700, color: '#8A93A3', background: '#F1F3F6', borderRadius: 10, padding: '1px 8px' },
  maintReportEmpty: { fontSize: 12.5, color: '#8A93A3', padding: '14px 0 0' },
  maintReportList: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 14 },
  maintReportRow: { display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 4px', borderBottom: '1px solid #F1F3F6' },
  maintReportComponent: { fontSize: 11.5, fontWeight: 700, color: ACCENT, background: '#FFF3E5', borderRadius: 6, padding: '3px 8px', flexShrink: 0, minWidth: 52, textAlign: 'center' },
  maintReportMain: { flex: 1, minWidth: 0 },
  maintReportDate: { fontSize: 13, fontWeight: 600, color: '#0F1111' },
  maintReportEngineer: { fontSize: 11.5, color: ACCENT, fontWeight: 600, marginTop: 2 },
  maintReportNotes: { fontSize: 12, color: '#565959', marginTop: 2 },
  maintReportAgo: { fontSize: 11, color: '#8A93A3', whiteSpace: 'nowrap', fontWeight: 500 },
};
