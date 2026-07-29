import React, { useState } from 'react';
import { supabase } from './supabaseClient';
import { Zap } from 'lucide-react';

export default function ResetPassword({ onDone }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);

    const { error } = await supabase.auth.updateUser({ password });

    setLoading(false);
    if (error) {
      setError(error.message);
    } else {
      setMessage('Password updated! Redirecting...');
      setTimeout(onDone, 1500);
    }
  };

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.logoRow}>
          <Zap size={20} color="#E86A00" fill="#E86A00" />
          <span style={styles.logoText}>Nexora</span>
        </div>
        <h1 style={styles.heading}>Set a new password</h1>
        <form onSubmit={handleSubmit} style={styles.form}>
          <label style={styles.label}>New password</label>
          <input
            style={styles.input}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter new password"
            minLength={6}
            required
          />
          {error && <div style={styles.error}>{error}</div>}
          {message && <div style={styles.success}>{message}</div>}
          <button style={styles.button} type="submit" disabled={loading}>
            {loading ? 'Updating...' : 'Update password'}
          </button>
        </form>
      </div>
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F1F3F6', fontFamily: "'Inter', sans-serif" },
  card: { background: '#fff', borderRadius: 12, border: '1px solid #E3E6E8', padding: '36px 32px', width: '100%', maxWidth: 380 },
  logoRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 24 },
  logoText: { fontWeight: 800, fontSize: 18, color: '#0F1111' },
  heading: { fontSize: 20, fontWeight: 700, margin: '0 0 20px', color: '#0F1111' },
  form: { display: 'flex', flexDirection: 'column' },
  label: { fontSize: 12, fontWeight: 600, color: '#0F1111', marginBottom: 6 },
  input: { border: '1.5px solid #D5D9D9', borderRadius: 8, padding: '11px 13px', fontSize: 14, marginBottom: 16 },
  error: { background: '#FDECEA', color: '#CC0C39', padding: '10px 13px', borderRadius: 8, fontSize: 13, marginBottom: 14 },
  success: { background: '#E9F6EC', color: '#1E7E34', padding: '10px 13px', borderRadius: 8, fontSize: 13, marginBottom: 14 },
  button: { background: '#E86A00', color: '#fff', border: 'none', borderRadius: 8, padding: '13px', fontSize: 14.5, fontWeight: 700, cursor: 'pointer' },
};