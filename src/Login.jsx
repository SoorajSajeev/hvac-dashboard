import React, { useState } from 'react';
import { supabase } from './supabaseClient';
import { Zap, Gauge, Thermometer, Wind, Activity } from 'lucide-react';
import { REGIONS } from './locationConfig';
import { validateAccessCode } from './accessConfig';

export default function Login({ onLogin }) {
  const [mode, setMode] = useState('login'); // 'login' | 'signup' | 'forgot'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [role, setRole] = useState('');
  const [scopeValue, setScopeValue] = useState('');
  const [accessCode, setAccessCode] = useState('');
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);

    if (mode === 'login') {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      setLoading(false);
      if (error) setError(error.message);
      else onLogin(data.session);
      return;
    }

    if (!role) {
      setLoading(false);
      setError('Please select a role.');
      return;
    }
    if (role !== 'admin' && !scopeValue) {
      setLoading(false);
      setError(role === 'manager' ? 'Please select a region.' : 'Please select a unit.');
      return;
    }
    if (role !== 'admin' && !validateAccessCode(role, scopeValue, accessCode)) {
      setLoading(false);
      setError('Incorrect access code for the selected location.');
      return;
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          employee_id: employeeId,
          role,
          scope: role === 'admin' ? 'ALL' : scopeValue,
        },
      },
    });
    setLoading(false);
    if (error) {
      setError(error.message);
    } else if (data.session) {
      onLogin(data.session);
    } else {
      setMessage('Account created. Check your email to confirm before logging in.');
      setMode('login');
    }
  };

  const handleForgotPassword = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    });

    setLoading(false);
    if (error) {
      setError(error.message);
    } else {
      setMessage('Password reset link sent. Check your email.');
    }
  };

  return (
    <div style={styles.page}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; }
        body { margin: 0; }
        .nx-input { transition: border-color 0.15s ease, box-shadow 0.15s ease; }
        .nx-input:focus { outline: none; border-color: #E86A00 !important; box-shadow: 0 0 0 3px rgba(232,106,0,0.15); }
        .nx-btn:hover { background: #CC5D00; }
        .nx-role-btn { cursor: pointer; transition: border-color 0.15s ease, background 0.15s ease; }
        .nx-link { cursor: pointer; }
        .nx-link:hover { text-decoration: underline; }
        @media (max-width: 860px) { .nx-left-panel { display: none !important; } }
      `}</style>

      <div className="nx-left-panel" style={styles.leftPanel}>
        <div style={styles.leftTop}>
          <span style={styles.logoIcon}><Zap size={20} color="#E86A00" fill="#E86A00" /></span>
          <span style={styles.logoText}>Nexora</span>
        </div>

        <div style={styles.leftMid}>
          <div style={styles.leftEyebrow}>NEXORA</div>
          <div style={styles.leftTitle}>HVAC condition monitoring</div>
          <div style={styles.leftSub}>
            Motor, belt, and filter health tracked per unit. Automated
            fault detection and remaining-life estimates from live
            sensor data.
          </div>

          <div style={styles.statLabel}>SAMPLE UNIT READING</div>
          <div style={styles.statGrid}>
            <StatChip icon={Gauge} label="RPM" value="1,497" />
            <StatChip icon={Thermometer} label="TEMP" value="54.2°C" />
            <StatChip icon={Wind} label="PRESSURE" value="92 Pa" />
            <StatChip icon={Activity} label="VIBRATION" value="1.7 mm/s" />
          </div>
        </div>

        <div style={styles.leftFoot}>© 2026 Nexora. All rights reserved.</div>
      </div>

      <div style={styles.rightPanel}>
        <div style={styles.formWrap}>
          <h1 style={styles.heading}>
            {mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Create your account' : 'Reset your password'}
          </h1>
          <p style={styles.subheading}>
            {mode === 'login'
              ? 'Access your HVAC monitoring dashboard'
              : mode === 'signup'
              ? 'Register to start monitoring'
              : "Enter your email and we'll send you a reset link"}
          </p>

          {mode === 'forgot' ? (
            <form onSubmit={handleForgotPassword} style={styles.form}>
              <label style={styles.label}>Email</label>
              <input
                className="nx-input"
                style={styles.input}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
              />

              {error && <div style={styles.error}>{error}</div>}
              {message && <div style={styles.success}>{message}</div>}

              <button className="nx-btn" style={styles.button} type="submit" disabled={loading}>
                {loading ? 'Sending...' : 'Send reset link'}
              </button>

              <div style={styles.switchRow}>
                <span
                  className="nx-link"
                  style={styles.link}
                  onClick={() => { setMode('login'); setError(null); setMessage(null); }}
                >
                  ← Back to sign in
                </span>
              </div>
            </form>
          ) : (
            <form onSubmit={handleSubmit} style={styles.form}>
              <label style={styles.label}>Email</label>
              <input className="nx-input" style={styles.input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required />

              <label style={styles.label}>Password</label>
              <input className="nx-input" style={styles.input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter password" minLength={6} required />

              {mode === 'login' && (
                <div style={{ textAlign: 'right', marginTop: -10, marginBottom: 16 }}>
                  <span
                    className="nx-link"
                    style={{ fontSize: 12, color: '#565959', fontWeight: 600 }}
                    onClick={() => { setMode('forgot'); setError(null); setMessage(null); }}
                  >
                    Forgot password?
                  </span>
                </div>
              )}

              {mode === 'signup' && (
                <>
                  <label style={styles.label}>Employee ID</label>
                  <input className="nx-input" style={styles.input} type="text" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} placeholder="e.g. EMP-1024" required />

                  <label style={styles.label}>Register as</label>
                  <div style={styles.roleRow}>
                    {['manager', 'admin', 'engineer'].map((r) => (
                      <div
                        key={r}
                        className="nx-role-btn"
                        style={{ ...styles.roleBtn, ...(role === r ? styles.roleBtnActive : {}) }}
                        onClick={() => { setRole(r); setScopeValue(''); setAccessCode(''); }}
                      >
                        {r.charAt(0).toUpperCase() + r.slice(1)}
                      </div>
                    ))}
                  </div>

                  {role === 'manager' && (
                    <>
                      <label style={styles.label}>Region</label>
                      <select className="nx-input" style={styles.input} value={scopeValue} onChange={(e) => setScopeValue(e.target.value)} required>
                        <option value="" disabled>Select region</option>
                        {Object.keys(REGIONS).map((r) => (
                          <option key={r} value={r}>{REGIONS[r].name}</option>
                        ))}
                      </select>
                      <label style={styles.label}>Region Access Code</label>
                      <input className="nx-input" style={styles.input} type="password" value={accessCode} onChange={(e) => setAccessCode(e.target.value)} placeholder="3-digit code" required />
                    </>
                  )}

                  {role === 'engineer' && (
                    <>
                      <label style={styles.label}>Unit</label>
                      <select className="nx-input" style={styles.input} value={scopeValue} onChange={(e) => setScopeValue(e.target.value)} required>
                        <option value="" disabled>Select unit</option>
                        {Object.values(REGIONS).flatMap((r) => r.units).map((u) => (
                          <option key={u.buildingId} value={u.buildingId}>{u.name}</option>
                        ))}
                      </select>
                      <label style={styles.label}>Unit Access Code</label>
                      <input className="nx-input" style={styles.input} type="password" value={accessCode} onChange={(e) => setAccessCode(e.target.value)} placeholder="3-digit code" required />
                    </>
                  )}

                  {role === 'admin' && (
                    <div style={styles.adminNote}>Admins have access to all regions and units. No code required.</div>
                  )}
                </>
              )}

              {error && <div style={styles.error}>{error}</div>}
              {message && <div style={styles.success}>{message}</div>}

              <button className="nx-btn" style={styles.button} type="submit" disabled={loading}>
                {loading ? 'Please wait...' : mode === 'login' ? 'Log in' : 'Sign up'}
              </button>
            </form>
          )}

          {mode !== 'forgot' && (
            <div style={styles.switchRow}>
              {mode === 'login' ? (
                <>Don't have an account?{' '}
                  <span className="nx-link" style={styles.link} onClick={() => { setMode('signup'); setError(null); setMessage(null); }}>Sign up</span>
                </>
              ) : (
                <>Already have an account?{' '}
                  <span className="nx-link" style={styles.link} onClick={() => { setMode('login'); setError(null); setMessage(null); }}>Log in</span>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatChip({ icon: Icon, label, value }) {
  return (
    <div style={styles.chip}>
      <Icon size={14} color="#E86A00" strokeWidth={2.2} />
      <div>
        <div style={styles.chipLabel}>{label}</div>
        <div style={styles.chipValue}>{value}</div>
      </div>
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', display: 'flex', fontFamily: "'Inter', sans-serif", background: '#F1F3F6' },

  leftPanel: {
    width: '40%', minHeight: '100vh', background: '#131A2C', color: '#fff',
    display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
    padding: '40px 44px',
  },
  leftTop: { display: 'flex', alignItems: 'center', gap: 8 },
  logoIcon: { display: 'inline-flex' },
  logoText: { fontWeight: 800, fontSize: 18 },
  leftMid: { maxWidth: 380 },
  leftEyebrow: { fontSize: 11, letterSpacing: 1.5, opacity: 0.6, fontWeight: 700, marginBottom: 14 },
  leftTitle: { fontSize: 28, fontWeight: 700, lineHeight: 1.3, marginBottom: 16 },
  leftSub: { fontSize: 13.5, lineHeight: 1.6, opacity: 0.75, marginBottom: 28 },
  statLabel: { fontSize: 9.5, letterSpacing: 1, opacity: 0.45, fontWeight: 700, marginBottom: 10 },
  statGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
  chip: { display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '10px 12px' },
  chipLabel: { fontSize: 8.5, letterSpacing: 0.5, opacity: 0.6, fontWeight: 600 },
  chipValue: { fontSize: 13.5, fontWeight: 700 },
  leftFoot: { fontSize: 11.5, opacity: 0.45 },

  rightPanel: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px 24px' },
  formWrap: { width: '100%', maxWidth: 380 },
  heading: { fontSize: 22, fontWeight: 700, margin: '0 0 4px', color: '#0F1111' },
  subheading: { fontSize: 13, color: '#565959', margin: '0 0 24px' },
  form: { display: 'flex', flexDirection: 'column' },
  label: { fontSize: 12, fontWeight: 600, color: '#0F1111', marginBottom: 6 },
  input: { border: '1.5px solid #D5D9D9', background: '#FFFFFF', borderRadius: 8, padding: '11px 13px', fontSize: 14, marginBottom: 16, fontFamily: "'Inter', sans-serif", color: '#0F1111' },
  roleRow: { display: 'flex', gap: 8, marginBottom: 16 },
  roleBtn: { flex: 1, textAlign: 'center', padding: '9px 6px', borderRadius: 8, border: '1.5px solid #D5D9D9', background: '#FFFFFF', fontSize: 12.5, fontWeight: 600, color: '#565959' },
  roleBtnActive: { borderColor: '#E86A00', background: '#FFF3E5', color: '#E86A00' },
  adminNote: { background: '#F1F3F6', color: '#0F1111', padding: '10px 13px', borderRadius: 8, fontSize: 12.5, marginBottom: 16, border: '1px solid #E3E6E8' },
  error: { background: '#FDECEA', color: '#CC0C39', padding: '10px 13px', borderRadius: 8, fontSize: 13, marginBottom: 14, border: '1px solid #F5C6CE' },
  success: { background: '#E9F6EC', color: '#1E7E34', padding: '10px 13px', borderRadius: 8, fontSize: 13, marginBottom: 14, border: '1px solid #C3E6CB' },
  button: { background: '#E86A00', color: '#fff', border: 'none', borderRadius: 8, padding: '13px', fontSize: 14.5, fontWeight: 700, fontFamily: "'Inter', sans-serif", cursor: 'pointer' },
  switchRow: { textAlign: 'center', marginTop: 18, fontSize: 13, color: '#565959' },
  link: { color: '#E86A00', fontWeight: 600 },
};