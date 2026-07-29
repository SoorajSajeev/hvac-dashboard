import React from 'react';

export default function AnimatedChiller({ size = 260 }) {
  const bladeCount = 6;
  const blades = Array.from({ length: bladeCount });

  return (
    <div style={{ width: size, height: size, position: 'relative' }}>
      <style>{`
        @keyframes spinFan { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes pulseGlow { 0%,100% { opacity: 0.3; } 50% { opacity: 0.65; } }
        @keyframes flowLine {
          0% { stroke-dashoffset: 40; opacity: 0; }
          15% { opacity: 1; }
          85% { opacity: 1; }
          100% { stroke-dashoffset: 0; opacity: 0; }
        }
        @keyframes floatUnit { 0%,100% { transform: translateY(0px); } 50% { transform: translateY(-5px); } }
        @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
        .nx-fan-group { animation: spinFan 2.2s linear infinite; transform-origin: 130px 105px; }
        .nx-glow { animation: pulseGlow 2.4s ease-in-out infinite; }
        .nx-unit { animation: floatUnit 4s ease-in-out infinite; }
        .nx-flow { stroke-dasharray: 8 6; animation: flowLine 2s linear infinite; }
        .nx-flow2 { stroke-dasharray: 8 6; animation: flowLine 2s linear infinite; animation-delay: 0.6s; }
        .nx-flow3 { stroke-dasharray: 8 6; animation: flowLine 2s linear infinite; animation-delay: 1.2s; }
        .nx-led { animation: blink 1.6s ease-in-out infinite; }
      `}</style>
      <svg viewBox="0 0 260 260" width="100%" height="100%">
        <defs>
          <radialGradient id="glowGrad" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#FF5A1F" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#FF5A1F" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="unitGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#FFFFFF" />
            <stop offset="100%" stopColor="#FFF1E8" />
          </linearGradient>
          <radialGradient id="fanHubGrad" cx="35%" cy="35%" r="70%">
            <stop offset="0%" stopColor="#4B5563" />
            <stop offset="100%" stopColor="#1F2937" />
          </radialGradient>
          <linearGradient id="bladeGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#FF8A50" />
            <stop offset="100%" stopColor="#E64A0F" />
          </linearGradient>
        </defs>

        <circle className="nx-glow" cx="130" cy="130" r="110" fill="url(#glowGrad)" />

        <g className="nx-unit">
          {/* unit housing */}
          <rect x="35" y="55" width="190" height="145" rx="20" fill="url(#unitGrad)" stroke="#FFD7BE" strokeWidth="2" />

          {/* fan outer grille ring */}
          <circle cx="130" cy="105" r="46" fill="#F3F4F6" stroke="#D1D5DB" strokeWidth="2" />
          <circle cx="130" cy="105" r="46" fill="none" stroke="#9CA3AF" strokeWidth="1" strokeDasharray="2 4" />

          {/* radial grille bars (static, behind spinning blades) */}
          {Array.from({ length: 10 }).map((_, i) => {
            const angle = (i * 360) / 10;
            const rad = (angle * Math.PI) / 180;
            const x2 = 130 + 44 * Math.cos(rad);
            const y2 = 105 + 44 * Math.sin(rad);
            return <line key={i} x1="130" y1="105" x2={x2} y2={y2} stroke="#E5E7EB" strokeWidth="1.5" />;
          })}

          {/* spinning fan blades */}
          <g className="nx-fan-group">
            {blades.map((_, i) => {
              const angle = (i * 360) / bladeCount;
              return (
                <path
                  key={i}
                  d="M130 105 C 138 92, 156 90, 160 76 C 163 88, 156 100, 138 108 Z"
                  fill="url(#bladeGrad)"
                  stroke="#C4380A"
                  strokeWidth="0.5"
                  transform={`rotate(${angle} 130 105)`}
                  opacity="0.92"
                />
              );
            })}
            <circle cx="130" cy="105" r="11" fill="url(#fanHubGrad)" stroke="#111827" strokeWidth="1" />
            <circle cx="130" cy="105" r="3" fill="#6B7280" />
          </g>

          {/* control panel strip */}
          <rect x="52" y="164" width="156" height="22" rx="8" fill="#1F2937" />
          <circle className="nx-led" cx="66" cy="175" r="3.5" fill="#4FD1C5" />
          <circle cx="78" cy="175" r="3.5" fill="#FF9F1C" opacity="0.5" />
          <rect x="94" y="171" width="100" height="8" rx="4" fill="#374151" />
          <rect x="98" y="173" width="60" height="4" rx="2" fill="#4FD1C5" opacity="0.7" />

          {/* status light */}
          <circle cx="205" cy="70" r="6" fill="#2BB673" className="nx-glow" />
        </g>

        {/* airflow lines */}
        <path className="nx-flow" d="M130 200 L130 236" stroke="#4FD1C5" strokeWidth="3" fill="none" strokeLinecap="round" />
        <path className="nx-flow2" d="M100 198 L88 232" stroke="#4FD1C5" strokeWidth="3" fill="none" strokeLinecap="round" />
        <path className="nx-flow3" d="M160 198 L172 232" stroke="#4FD1C5" strokeWidth="3" fill="none" strokeLinecap="round" />
      </svg>
    </div>
  );
}