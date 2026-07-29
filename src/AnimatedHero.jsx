import React from 'react';
import { Gauge, Thermometer, Wind, Activity } from 'lucide-react';

export default function AnimatedHero({ size = 260, accent = '#FF7A00' }) {
  const readouts = [
    { icon: Gauge, label: 'RPM', value: '1,497' },
    { icon: Thermometer, label: 'TEMP', value: '54.2°C' },
    { icon: Wind, label: 'PRESSURE', value: '92 Pa' },
    { icon: Activity, label: 'VIBRATION', value: '1.7 mm/s' },
  ];

  return (
    <div style={{ width: size, height: size, position: 'relative' }}>
      <svg viewBox="0 0 260 260" width="100%" height="100%">
        <defs>
          <linearGradient id="panelGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#1B2438" />
            <stop offset="100%" stopColor="#131A2C" />
          </linearGradient>
        </defs>
        <rect x="8" y="8" width="244" height="244" rx="16" fill="url(#panelGrad)" />
        <rect x="8" y="8" width="244" height="244" rx="16" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
        <circle cx="130" cy="130" r="76" fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="1" />
        <circle cx="130" cy="130" r="76" fill="none" stroke={accent} strokeWidth="3" strokeDasharray="24 380" strokeLinecap="round" transform="rotate(-90 130 130)" />
        <circle cx="130" cy="130" r="42" fill={accent} opacity="0.14" />
        <circle cx="130" cy="130" r="18" fill={accent} />
        <circle cx="130" cy="130" r="6" fill="#FFF3E5" />
        <circle cx="32" cy="32" r="3.5" fill="#2E9E4F" />
        <circle cx="228" cy="32" r="3.5" fill="#B8BEC8" />
      </svg>

      <div style={styles.grid}>
        {readouts.map((r) => {
          const Icon = r.icon;
          return (
            <div key={r.label} style={styles.chip}>
              <Icon size={13} color={accent} strokeWidth={2.2} />
              <div>
                <div style={styles.chipLabel}>{r.label}</div>
                <div style={styles.chipValue}>{r.value}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const styles = {
  grid: { marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7 },
  chip: { display: 'flex', alignItems: 'center', gap: 7, background: '#FFFFFF', border: '1px solid #E3E6E8', borderRadius: 8, padding: '7px 9px' },
  chipLabel: { fontFamily: "'Inter', sans-serif", fontSize: 8.5, letterSpacing: 0.5, color: '#565959', fontWeight: 600 },
  chipValue: { fontFamily: "'Inter', sans-serif", fontSize: 13, color: '#0F1111', fontWeight: 700 },
};