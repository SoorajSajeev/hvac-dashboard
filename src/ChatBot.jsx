import React, { useState, useRef, useEffect } from 'react';
import { REGIONS } from './locationConfig';

const SUPABASE_URL = "https://xmnpvguxhnnumwimhsvo.supabase.co";
const SUPABASE_KEY = "sb_publishable_uxRRYKxXbIkYCQD2ftblzA_sJ9n8knY";

const fixSuggestions = {
  BELT: 'Inspect belt tension and alignment. Tighten or replace if worn.',
  FILTER: 'Clean or replace the air filter to restore airflow.',
  BEARING: 'Schedule bearing lubrication or replacement soon.',
  MOTOR: 'Check motor load and wiring. Reduce load if overloaded.',
  ROTOR: 'Inspect rotor for obstruction or imbalance.',
  SHAFT: 'Check shaft alignment and couplings.',
  COOLING: 'Inspect cooling circuit for blockages or refrigerant issues.',
  DEFAULT: 'Schedule a maintenance inspection for this unit.',
};

function getSuggestion(fault) {
  if (!fault) return fixSuggestions.DEFAULT;
  const key = Object.keys(fixSuggestions).find((k) => fault.toUpperCase().includes(k));
  return fixSuggestions[key] || fixSuggestions.DEFAULT;
}

export default function ChatBot({ role, scope }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [stage, setStage] = useState('askName');
  const [userName, setUserName] = useState('');
  const [pendingRegion, setPendingRegion] = useState(null);
  const bottomRef = useRef(null);

  useEffect(() => {
    if (open && messages.length === 0) {
      addBotMessage("Hello. What's your name?");
    }
  }, [open]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function addBotMessage(text, tone = 'neutral') {
    setMessages((prev) => [...prev, { from: 'bot', text, tone }]);
  }
  function addUserMessage(text) {
    setMessages((prev) => [...prev, { from: 'user', text }]);
  }

  function regionListText() {
    return Object.keys(REGIONS).map((r) => REGIONS[r].name).join(', ');
  }

  function findRegionByQuery(query) {
    const q = query.trim().toLowerCase();
    return Object.keys(REGIONS).find((r) => REGIONS[r].name.toLowerCase().includes(q) || r.toLowerCase() === q);
  }

  function findUnitInRegion(regionKey, query) {
    const q = query.trim().toLowerCase();
    return REGIONS[regionKey].units.find(
      (u) => u.buildingId.toLowerCase() === q || u.name.toLowerCase().includes(q)
    );
  }

  async function checkUnitStatus(unit) {
    addBotMessage(`Checking ${unit.name}...`);
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/predictions?building_id=eq.${unit.buildingId}&select=*&order=scored_at.desc&limit=1`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const data = await res.json();

      if (!data || data.length === 0) {
        addBotMessage(`No readings are available yet for ${unit.name}.`);
      } else {
        const latest = data[0];
        const hasIssue = latest.is_anomaly || (latest.predicted_fault && latest.predicted_fault !== 'HEALTHY');

        if (hasIssue) {
          addBotMessage(`${unit.name} needs attention. Predicted issue: ${latest.predicted_fault}.`, 'warning');
          addBotMessage(`Suggested fix: ${getSuggestion(latest.predicted_fault)}`);
        } else {
          addBotMessage(`${unit.name} is operating normally. No issues detected.`, 'good');
        }
      }
    } catch (e) {
      addBotMessage("I couldn't reach the data source just now. Please try again shortly.");
    }
    addBotMessage(`Thank you for checking in, ${userName}.`);
    setStage('done');
  }

  // After name is captured, route based on role
  function startRoleFlow() {
    if (role === 'engineer') {
      // Engineer is locked to their own registered unit — no question needed
      const unit = Object.values(REGIONS).flatMap((r) => r.units).find((u) => u.buildingId === scope);
      if (unit) {
        setStage('checking');
        checkUnitStatus(unit);
      } else {
        addBotMessage("I couldn't find your registered unit. Please contact your admin.");
      }
    } else if (role === 'manager') {
      // Manager is locked to their region — go straight to unit list
      const units = REGIONS[scope]?.units || [];
      addBotMessage(`Which unit in ${REGIONS[scope]?.name} would you like to check? (${units.map((u) => u.name).join(', ')})`);
      setPendingRegion(scope);
      setStage('askUnit');
    } else {
      // Admin picks a region first
      addBotMessage(`Which region would you like to check? (${regionListText()})`);
      setStage('askRegion');
    }
  }

  function handleSend() {
    const text = input.trim();
    if (!text) return;
    addUserMessage(text);
    setInput('');

    if (stage === 'askName') {
      setUserName(text);
      addBotMessage(`Thanks, ${text}.`);
      startRoleFlow();
    } else if (stage === 'askRegion') {
      const regionKey = findRegionByQuery(text);
      if (!regionKey) {
        addBotMessage(`I couldn't find that region. Try one of: ${regionListText()}.`);
      } else {
        const units = REGIONS[regionKey].units;
        addBotMessage(`Which unit in ${REGIONS[regionKey].name} would you like to check? (${units.map((u) => u.name).join(', ')})`);
        setPendingRegion(regionKey);
        setStage('askUnit');
      }
    } else if (stage === 'askUnit') {
      const unit = findUnitInRegion(pendingRegion, text);
      if (!unit) {
        addBotMessage("I couldn't find that unit. Please enter the unit name exactly as listed.");
      } else {
        setStage('checking');
        checkUnitStatus(unit);
      }
    } else if (stage === 'done') {
      if (role === 'engineer') {
        addBotMessage("You can ask about your unit anytime.");
      } else if (role === 'manager') {
        const units = REGIONS[scope]?.units || [];
        addBotMessage(`Would you like to check another unit? (${units.map((u) => u.name).join(', ')})`);
        setPendingRegion(scope);
        setStage('askUnit');
      } else {
        addBotMessage(`Would you like to check another region? (${regionListText()})`);
        setStage('askRegion');
      }
    }
  }

  return (
    <>
      <button style={styles.bubble} onClick={() => setOpen(!open)}>
        {open ? '\u2715' : '\u2699'}
      </button>

      {open && (
        <div style={styles.window}>
          <div style={styles.header}>
            <div>
              <div style={styles.headerTitle}>Nexora Assistant</div>
              <div style={styles.headerSub}>Ask about any unit</div>
            </div>
          </div>

          <div style={styles.body}>
            {messages.map((m, i) => (
              <div key={i} style={{ ...styles.bubbleRow, justifyContent: m.from === 'bot' ? 'flex-start' : 'flex-end' }}>
                <div style={m.from === 'bot' ? botMsgStyle(m.tone) : styles.userMsg}>{m.text}</div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          <div style={styles.inputRow}>
            <input
              style={styles.input}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              placeholder="Type here..."
            />
            <button style={styles.sendBtn} onClick={handleSend}>Send</button>
          </div>
        </div>
      )}
    </>
  );
}

function botMsgStyle(tone) {
  if (tone === 'good') return { ...styles.botMsg, background: '#E9F6EC', color: '#1E7E34', border: '1px solid #C3E6CB' };
  if (tone === 'warning') return { ...styles.botMsg, background: '#FFF3D6', color: '#946200', border: '1px solid #F5DE9A' };
  return styles.botMsg;
}

const styles = {
  bubble: {
    position: 'fixed', bottom: 24, right: 24, width: 56, height: 56, borderRadius: '50%',
    background: '#131A2C', color: '#fff', border: 'none', fontSize: 20, cursor: 'pointer',
    boxShadow: '0 8px 24px rgba(19,26,44,0.35)', zIndex: 100,
  },
  window: {
    position: 'fixed', bottom: 92, right: 24, width: 320, maxHeight: 460,
    background: '#fff', borderRadius: 16, boxShadow: '0 16px 48px rgba(0,0,0,0.18)',
    display: 'flex', flexDirection: 'column', overflow: 'hidden', zIndex: 100,
    fontFamily: "'Inter', sans-serif", border: '1px solid #E3E6E8',
  },
  header: { display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', background: '#131A2C', color: '#fff' },
  headerTitle: { fontWeight: 700, fontSize: 14 },
  headerSub: { fontSize: 11, opacity: 0.75 },
  body: { flex: 1, padding: 14, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320 },
  bubbleRow: { display: 'flex' },
  botMsg: { background: '#F1F3F6', color: '#0F1111', padding: '9px 13px', borderRadius: '10px 10px 10px 2px', fontSize: 13, maxWidth: '85%', lineHeight: 1.4 },
  userMsg: { background: '#E86A00', color: '#fff', padding: '9px 13px', borderRadius: '10px 10px 2px 10px', fontSize: 13, maxWidth: '85%', lineHeight: 1.4 },
  inputRow: { display: 'flex', gap: 8, padding: 12, borderTop: '1px solid #F1F3F6' },
  input: { flex: 1, border: '1.5px solid #E3E6E8', borderRadius: 10, padding: '9px 12px', fontSize: 13, fontFamily: "'Inter', sans-serif" },
  sendBtn: { background: '#E86A00', color: '#fff', border: 'none', borderRadius: 10, padding: '0 14px', cursor: 'pointer', fontSize: 12.5, fontWeight: 600 },
};