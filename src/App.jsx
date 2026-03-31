import { useState, useEffect, useRef, useCallback } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// NOTE: No API key needed here. It lives in .env and is read by server.cjs
// All requests go through the local proxy at /api/anthropic (port 3001)
// ─────────────────────────────────────────────────────────────────────────────

const C = {
  navy:       "#0a1628",
  navyMid:    "#0f2040",
  navyLight:  "#1a3358",
  navyBorder: "#1e3d66",
  orange:     "#e87722",
  orangeAlt:  "#f0973a",
  teal:       "#2dd4bf",
  gold:       "#f4c842",
  slate:      "#7a9abf",
  light:      "#c8daf0",
  white:      "#f0f6ff",
  green:      "#22d87a",
  red:        "#f06060",
  purple:     "#a78bfa",
};

const TAG_COLORS = {
  "REGULATION":   { bg: "#f06060", text: "#fff"    },
  "MUTUAL FUND":  { bg: "#e87722", text: "#fff"    },
  "INSURANCE":    { bg: "#a78bfa", text: "#fff"    },
  "MARKET":       { bg: "#2dd4bf", text: "#0a1628" },
  "STRATEGY":     { bg: "#f4c842", text: "#0a1628" },
};

const SYSTEM_PROMPT = `You are the Chief Investment Intelligence Officer for TruEdge Financial Services, an AMFI-registered Indian wealth advisory firm (ARN-344270).

Your role: Scan the web for the latest Indian personal finance, mutual fund, SEBI/AMFI/IRDAI regulation, insurance, and market intelligence. Return ONLY valid JSON — no markdown, no preamble, no code fences.

Return this EXACT JSON structure:
{
  "executiveSnapshot": [
    { "tag": "REGULATION", "insight": "string" }
  ],
  "detailedIntelligence": [
    {
      "title": "string",
      "summary": "string",
      "whyItMatters": "string",
      "actionableTakeaway": "string"
    }
  ],
  "advisoryEdge": {
    "newInvestmentIdeas": ["string"],
    "portfolioPositioning": ["string"],
    "riskAlerts": ["string"],
    "clientOpportunities": ["string"]
  },
  "modelPortfolioSignals": {
    "assetAllocationTrend": "string",
    "debtVsEquityPositioning": "string",
    "sectorOpportunities": ["string"],
    "sipSTPStrategy": "string"
  },
  "insuranceIntelligence": {
    "termInsuranceTrends": "string",
    "healthInsuranceChanges": "string",
    "productInnovations": ["string"],
    "claimDevelopments": "string"
  }
}

Rules:
- tag must be one of: REGULATION, MUTUAL FUND, INSURANCE, MARKET, STRATEGY
- Use only credible sources: SEBI, AMFI, IRDAI, ET Wealth, Mint, Business Standard, Value Research, Morningstar India
- executiveSnapshot: 6-8 items, most critical first
- detailedIntelligence: 4-5 items
- advisoryEdge arrays: 2-3 items each
- modelPortfolioSignals.sectorOpportunities: 2-3 items
- Write like Goldman Sachs Private Wealth — concise, sharp, high signal-to-noise
- Focus ONLY on India-relevant personal finance and wealth management
- Return ONLY the raw JSON object, absolutely nothing else`;

// ── API call via local proxy (avoids CORS) ────────────────────────────────────
async function runAgentCall(briefType = "daily") {
  const today = new Date().toLocaleDateString("en-IN", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 120_000);

  let res;
  try {
    res = await fetch("/api/anthropic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model:      "claude-sonnet-4-20250514",
        max_tokens: 4000,
        system:     SYSTEM_PROMPT,
        tools:      [{ type: "web_search_20250305", name: "web_search" }],
        messages:   [{
          role:    "user",
          content: `Generate a ${briefType} intelligence brief for ${today}. Search for the latest: SEBI circulars, AMFI data, mutual fund performance, insurance regulation, RBI notifications, Indian market outlook. Validate all signals. Return ONLY valid JSON matching the schema — no preamble, no markdown.`,
        }],
      }),
    });
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Request timed out after 2 minutes. Please try again.");
    throw new Error(
      "Cannot reach the proxy server. Make sure you started both processes with npm run dev (or node server.cjs is running on port 3001)."
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j?.error?.message || msg; } catch {}
    if (res.status === 401) throw new Error("Invalid API key. Check ANTHROPIC_API_KEY in your .env file.");
    if (res.status === 403) throw new Error("API key doesn't have permission. Web search requires a paid Anthropic plan.");
    throw new Error(msg);
  }

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);

  const raw = (data.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n");

  const clean = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  const start = clean.indexOf("{");
  const end   = clean.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Agent returned no valid JSON. Please try again.");
  const parsed = JSON.parse(clean.slice(start, end + 1));

  const required = [
    ["executiveSnapshot",    Array.isArray],
    ["detailedIntelligence", Array.isArray],
    ["advisoryEdge",         v => v && typeof v === "object" && !Array.isArray(v)],
    ["modelPortfolioSignals",v => v && typeof v === "object" && !Array.isArray(v)],
    ["insuranceIntelligence",v => v && typeof v === "object" && !Array.isArray(v)],
  ];
  for (const [key, check] of required) {
    if (!check(parsed[key])) throw new Error(`Agent response missing or malformed field: "${key}". Please try again.`);
  }
  return parsed;
}

// ── Storage ───────────────────────────────────────────────────────────────────
const LS_BRIEFS   = "truedge-briefs-v1";
const LS_SCHEDULE = "truedge-schedule-v1";
const lsGet = (k, fb) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } };
const lsSet = (k, v)  => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

// ── Atoms ─────────────────────────────────────────────────────────────────────
function Dot({ color, pulse, size = 8 }) {
  return (
    <span style={{ position: "relative", display: "inline-block", width: size, height: size, flexShrink: 0 }}>
      {pulse && <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: color, opacity: 0.5, animation: "ping 1.2s ease infinite" }} />}
      <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: color }} />
    </span>
  );
}

function TagPill({ tag }) {
  const c = TAG_COLORS[tag] || { bg: C.slate, text: "#fff" };
  return (
    <span style={{ background: c.bg, color: c.text, fontSize: 9, fontWeight: 800, letterSpacing: 1.2, padding: "2px 7px", borderRadius: 3, fontFamily: "monospace", textTransform: "uppercase", flexShrink: 0 }}>
      {tag}
    </span>
  );
}

function Card({ children, style = {} }) {
  return <div style={{ background: C.navyMid, border: `1px solid ${C.navyBorder}`, borderRadius: 10, padding: "16px 18px", ...style }}>{children}</div>;
}

function SL({ children, accent = C.orange }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
      <div style={{ width: 2, height: 14, background: accent, borderRadius: 1 }} />
      <span style={{ color: accent, fontSize: 10, fontFamily: "monospace", fontWeight: 700, letterSpacing: 2, textTransform: "uppercase" }}>{children}</span>
    </div>
  );
}

// ── Proxy status checker ──────────────────────────────────────────────────────
function ProxyStatus({ status }) {
  if (status === "ok")      return <span style={{ color: C.green,  fontSize: 10, fontFamily: "monospace" }}>● Proxy OK</span>;
  if (status === "error")   return <span style={{ color: C.red,    fontSize: 10, fontFamily: "monospace" }}>● Proxy DOWN</span>;
  return <span style={{ color: C.slate, fontSize: 10, fontFamily: "monospace" }}>● Checking…</span>;
}

// ── Loading screen ────────────────────────────────────────────────────────────
function LoadingScreen() {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 24, padding: "60px 20px" }}>
      <div style={{ position: "relative", width: 72, height: 72 }}>
        <div style={{ position: "absolute", inset: 0, borderRadius: "50%", border: `2px solid ${C.navyBorder}` }} />
        <div style={{ position: "absolute", inset: 0, borderRadius: "50%", border: "2px solid transparent", borderTopColor: C.orange, animation: "spin 0.9s linear infinite" }} />
        <div style={{ position: "absolute", inset: 10, borderRadius: "50%", border: "1px solid transparent", borderTopColor: C.teal, animation: "spin 1.5s linear infinite reverse" }} />
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>🔍</div>
      </div>
      <div style={{ textAlign: "center" }}>
        <div style={{ color: C.white, fontWeight: 700, fontSize: 15, marginBottom: 6 }}>Agent Running</div>
        <div style={{ color: C.slate, fontSize: 12, fontFamily: "monospace" }}>Scanning SEBI · AMFI · Market Feeds…</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%", maxWidth: 380 }}>
        {["Fetching SEBI circulars & AMFI data", "Scanning ET Wealth · Mint · Business Standard", "Analysing mutual fund performance signals", "Synthesising advisory intelligence"].map((s, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, background: `${C.navyLight}60`, borderRadius: 6, padding: "8px 12px", animation: `fadeIn 0.4s ease ${i * 0.35}s both` }}>
            <span style={{ color: C.teal, fontSize: 10, fontFamily: "monospace" }}>▶</span>
            <span style={{ color: C.slate, fontSize: 11, fontFamily: "monospace" }}>{s}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Tab views ─────────────────────────────────────────────────────────────────
function SnapshotView({ items }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map((item, i) => (
        <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 12, background: `${C.navyLight}40`, border: `1px solid ${C.navyBorder}`, borderLeft: `3px solid ${TAG_COLORS[item.tag]?.bg || C.orange}`, borderRadius: 8, padding: "12px 16px", animation: `fadeIn 0.3s ease ${i * 0.06}s both` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, paddingTop: 1 }}>
            <span style={{ color: C.slate, fontSize: 10, fontFamily: "monospace", minWidth: 20 }}>{String(i + 1).padStart(2, "0")}</span>
            <TagPill tag={item.tag} />
          </div>
          <p style={{ margin: 0, color: C.light, fontSize: 13, lineHeight: 1.65 }}>{item.insight}</p>
        </div>
      ))}
    </div>
  );
}

function DetailedView({ items }) {
  const [open, setOpen] = useState(0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {items.map((item, i) => (
        <div key={i} style={{ background: C.navyMid, border: `1px solid ${open === i ? C.orange + "55" : C.navyBorder}`, borderRadius: 10, overflow: "hidden", animation: `fadeIn 0.3s ease ${i * 0.07}s both` }}>
          <button onClick={() => setOpen(open === i ? -1 : i)} style={{ width: "100%", background: "none", border: "none", cursor: "pointer", padding: "14px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <span style={{ color: C.white, fontWeight: 700, fontSize: 14, textAlign: "left" }}>{item.title}</span>
            <span style={{ color: C.slate, flexShrink: 0, transform: open === i ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>▾</span>
          </button>
          {open === i && (
            <div style={{ padding: "0 18px 16px", borderTop: `1px solid ${C.navyBorder}` }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, paddingTop: 14 }}>
                <div>
                  <div style={{ color: C.slate, fontSize: 9, fontFamily: "monospace", letterSpacing: 1.5, marginBottom: 6, textTransform: "uppercase" }}>Summary</div>
                  <p style={{ margin: 0, color: C.light, fontSize: 13, lineHeight: 1.65 }}>{item.summary}</p>
                </div>
                <div>
                  <div style={{ color: C.slate, fontSize: 9, fontFamily: "monospace", letterSpacing: 1.5, marginBottom: 6, textTransform: "uppercase" }}>Why It Matters</div>
                  <p style={{ margin: 0, color: C.light, fontSize: 13, lineHeight: 1.65 }}>{item.whyItMatters}</p>
                </div>
              </div>
              <div style={{ marginTop: 12, background: `${C.orange}15`, border: `1px solid ${C.orange}40`, borderRadius: 7, padding: "10px 14px" }}>
                <div style={{ color: C.orange, fontSize: 9, fontFamily: "monospace", letterSpacing: 1.5, marginBottom: 4, textTransform: "uppercase" }}>⚡ Actionable Takeaway</div>
                <p style={{ margin: 0, color: C.light, fontSize: 13, lineHeight: 1.6 }}>{item.actionableTakeaway}</p>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function AdvisoryView({ data }) {
  const secs = [
    { key: "newInvestmentIdeas",   label: "New Investment Ideas",  icon: "💡", color: C.gold  },
    { key: "portfolioPositioning", label: "Portfolio Positioning",  icon: "📊", color: C.teal  },
    { key: "riskAlerts",           label: "Risk Alerts",           icon: "⚠️", color: C.red   },
    { key: "clientOpportunities",  label: "Client Opportunities",  icon: "🎯", color: C.green },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
      {secs.map(({ key, label, icon, color }) => (
        <Card key={key}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <span style={{ fontSize: 16 }}>{icon}</span>
            <span style={{ color, fontWeight: 700, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</span>
          </div>
          {(data[key] || []).map((item, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", background: `${color}10`, borderRadius: 6, padding: "8px 10px", marginBottom: i < (data[key].length - 1) ? 6 : 0 }}>
              <span style={{ color, fontSize: 10, marginTop: 3, flexShrink: 0 }}>◆</span>
              <span style={{ color: C.light, fontSize: 13, lineHeight: 1.55 }}>{item}</span>
            </div>
          ))}
        </Card>
      ))}
    </div>
  );
}

function PortfolioView({ data }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <Card><SL accent={C.gold}>Asset Allocation Trend</SL><p style={{ margin: 0, color: C.light, fontSize: 13, lineHeight: 1.65 }}>{data.assetAllocationTrend}</p></Card>
        <Card><SL accent={C.teal}>Debt vs Equity Positioning</SL><p style={{ margin: 0, color: C.light, fontSize: 13, lineHeight: 1.65 }}>{data.debtVsEquityPositioning}</p></Card>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <Card>
          <SL accent={C.orange}>Sector Opportunities</SL>
          {(data.sectorOpportunities || []).map((s, i) => (
            <div key={i} style={{ display: "flex", gap: 8, marginBottom: 7 }}>
              <span style={{ color: C.orange, fontSize: 10, marginTop: 4, flexShrink: 0 }}>►</span>
              <span style={{ color: C.light, fontSize: 13, lineHeight: 1.55 }}>{s}</span>
            </div>
          ))}
        </Card>
        <Card><SL accent={C.green}>SIP / STP Strategy</SL><p style={{ margin: 0, color: C.light, fontSize: 13, lineHeight: 1.65 }}>{data.sipSTPStrategy}</p></Card>
      </div>
    </div>
  );
}

function InsuranceView({ data }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
      {[
        { key: "termInsuranceTrends",    label: "Term Insurance Trends",    icon: "🛡️", color: C.teal  },
        { key: "healthInsuranceChanges", label: "Health Insurance Changes", icon: "🏥", color: C.green },
        { key: "claimDevelopments",      label: "Claim Developments",       icon: "📋", color: C.gold  },
      ].map(({ key, label, icon, color }) => (
        <Card key={key}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
            <span>{icon}</span>
            <span style={{ color, fontWeight: 700, fontSize: 12, textTransform: "uppercase" }}>{label}</span>
          </div>
          <p style={{ margin: 0, color: C.light, fontSize: 13, lineHeight: 1.65 }}>{data[key]}</p>
        </Card>
      ))}
      <Card>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
          <span>🚀</span>
          <span style={{ color: C.purple, fontWeight: 700, fontSize: 12, textTransform: "uppercase" }}>Product Innovations</span>
        </div>
        {(data.productInnovations || []).map((p, i) => (
          <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
            <span style={{ color: C.purple, fontSize: 10, marginTop: 4, flexShrink: 0 }}>◆</span>
            <span style={{ color: C.light, fontSize: 13, lineHeight: 1.55 }}>{p}</span>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [briefs,        setBriefs]        = useState(() => lsGet(LS_BRIEFS, []));
  const [activeBriefId, setActiveBriefId] = useState(null);
  const [isRunning,     setIsRunning]     = useState(false);
  const [error,         setError]         = useState(null);
  const [briefType,     setBriefType]     = useState("daily");
  const [activeTab,     setActiveTab]     = useState("snapshot");
  const [schedule,      setSchedule]      = useState(() => lsGet(LS_SCHEDULE, { frequency: "daily", isActive: false, lastRun: null }));
  const [proxyStatus,   setProxyStatus]   = useState("checking");

  const timerRef = useRef(null);

  // Restore active brief + check proxy on mount
  useEffect(() => {
    if (briefs.length) setActiveBriefId(briefs[0].id);
    // Quick proxy health check
    fetch("/api/anthropic", { method: "OPTIONS" })
      .then(() => setProxyStatus("ok"))
      .catch(() => setProxyStatus("error"));
  }, []);

  useEffect(() => { lsSet(LS_SCHEDULE, schedule); }, [schedule]);

  // Scheduler tick
  useEffect(() => {
    clearInterval(timerRef.current);
    if (!schedule.isActive) return;
    timerRef.current = setInterval(() => {
      const interval = schedule.frequency === "daily" ? 86_400_000 : 604_800_000;
      if (Date.now() - (schedule.lastRun || 0) >= interval) handleRun(schedule.frequency);
    }, 60_000);
    return () => clearInterval(timerRef.current);
  }, [schedule.isActive, schedule.frequency, schedule.lastRun]);

  const handleRun = useCallback(async (type) => {
    const bType = type || briefType;
    if (isRunning) return;
    setIsRunning(true); setError(null);
    try {
      const data = await runAgentCall(bType);
      const brief = { id: `brief-${Date.now()}`, timestamp: new Date().toISOString(), type: bType, data };
      const updated = [brief, ...briefs].slice(0, 30);
      setBriefs(updated); lsSet(LS_BRIEFS, updated);
      setActiveBriefId(brief.id); setActiveTab("snapshot");
      setSchedule(s => ({ ...s, lastRun: Date.now() }));
    } catch (e) {
      setError(e.message || "Agent failed. Please try again.");
    } finally { setIsRunning(false); }
  }, [isRunning, briefs, briefType]);

  const toggleSchedule = () => setSchedule(s => ({ ...s, isActive: !s.isActive }));
  const setFreq = (f) => setSchedule(s => ({ ...s, frequency: f }));
  const deleteBrief = (id) => {
    const u = briefs.filter(b => b.id !== id);
    setBriefs(u); lsSet(LS_BRIEFS, u);
    if (activeBriefId === id) setActiveBriefId(u[0]?.id || null);
  };

  const activeBrief = briefs.find(b => b.id === activeBriefId) || briefs[0];

  const nextRunText = () => {
    if (!schedule.isActive || !schedule.lastRun) return null;
    const diff = (schedule.lastRun + (schedule.frequency === "daily" ? 86_400_000 : 604_800_000)) - Date.now();
    if (diff <= 0) return "Due now";
    const h = Math.floor(diff / 3_600_000), m = Math.floor((diff % 3_600_000) / 60_000);
    return `Next in ${h}h ${m}m`;
  };

  const TABS = [
    { id: "snapshot",  label: "🔴 Snapshot",        count: activeBrief?.data?.executiveSnapshot?.length    },
    { id: "detailed",  label: "🟡 Intelligence",     count: activeBrief?.data?.detailedIntelligence?.length },
    { id: "advisory",  label: "🟢 Advisory Edge"                                                            },
    { id: "portfolio", label: "⚡ Portfolio Signals"                                                         },
    { id: "insurance", label: "📊 Insurance Intel"                                                          },
  ];

  return (
    <div style={{ background: C.navy, minHeight: "100vh", color: C.white, fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <style>{`
        @keyframes spin   { to { transform: rotate(360deg); } }
        @keyframes ping   { 75%, 100% { transform: scale(2.2); opacity: 0; } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
        button { font-family: inherit; }
        button:focus { outline: none; }
      `}</style>

      {/* Header */}
      <header style={{ background: `linear-gradient(90deg, ${C.navy}, ${C.navyMid})`, borderBottom: `1px solid ${C.navyBorder}`, padding: "13px 22px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: "50%", background: `linear-gradient(135deg, ${C.orange}, ${C.orangeAlt})`, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900, fontSize: 16 }}>T</div>
          <div>
            <div style={{ color: C.white, fontWeight: 700, fontSize: 14 }}>TruEdge Financial Services</div>
            <div style={{ color: C.slate, fontSize: 9, letterSpacing: 2, textTransform: "uppercase", fontFamily: "monospace" }}>Intelligence Agent · ARN-344270</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <ProxyStatus status={proxyStatus} />
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <Dot color={isRunning ? C.orange : schedule.isActive ? C.green : C.slate} pulse={isRunning || schedule.isActive} />
            <span style={{ color: C.slate, fontSize: 10, fontFamily: "monospace" }}>{isRunning ? "RUNNING" : schedule.isActive ? "SCHEDULED" : "IDLE"}</span>
          </div>
          {nextRunText() && <span style={{ color: C.slate, fontSize: 10, fontFamily: "monospace" }}>{nextRunText()}</span>}
        </div>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", minHeight: "calc(100vh - 63px)" }}>

        {/* Sidebar */}
        <aside style={{ background: C.navyMid, borderRight: `1px solid ${C.navyBorder}`, display: "flex", flexDirection: "column", position: "sticky", top: 63, height: "calc(100vh - 63px)", overflowY: "auto" }}>

          {/* Run controls */}
          <div style={{ padding: "14px 12px", borderBottom: `1px solid ${C.navyBorder}` }}>
            <div style={{ color: C.slate, fontSize: 9, fontFamily: "monospace", letterSpacing: 1.5, marginBottom: 8, textTransform: "uppercase" }}>Brief Type</div>
            <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
              {["daily", "weekly"].map(t => (
                <button key={t} onClick={() => setBriefType(t)} style={{ flex: 1, background: briefType === t ? `${C.orange}25` : "transparent", border: `1px solid ${briefType === t ? C.orange : C.navyBorder}`, color: briefType === t ? C.orange : C.slate, borderRadius: 6, padding: "5px 0", fontSize: 11, cursor: "pointer", fontWeight: briefType === t ? 700 : 400, textTransform: "capitalize" }}>{t}</button>
              ))}
            </div>
            <button onClick={() => handleRun()} disabled={isRunning} style={{ width: "100%", padding: "10px", background: isRunning ? `${C.slate}30` : `linear-gradient(90deg, ${C.orange}, ${C.orangeAlt})`, border: "none", borderRadius: 7, color: C.white, fontWeight: 700, fontSize: 13, cursor: isRunning ? "not-allowed" : "pointer", opacity: isRunning ? 0.6 : 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              {isRunning ? <><span style={{ animation: "spin 0.8s linear infinite", display: "inline-block" }}>⟳</span> Running…</> : "▶  Run Now"}
            </button>
          </div>

          {/* Scheduler */}
          <div style={{ padding: "12px", borderBottom: `1px solid ${C.navyBorder}` }}>
            <div style={{ color: C.slate, fontSize: 9, fontFamily: "monospace", letterSpacing: 1.5, marginBottom: 8, textTransform: "uppercase" }}>Auto-Scheduler</div>
            <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
              {["daily", "weekly"].map(f => (
                <button key={f} onClick={() => setFreq(f)} style={{ flex: 1, background: schedule.frequency === f ? `${C.teal}20` : "transparent", border: `1px solid ${schedule.frequency === f ? C.teal : C.navyBorder}`, color: schedule.frequency === f ? C.teal : C.slate, borderRadius: 6, padding: "5px 0", fontSize: 11, cursor: "pointer", textTransform: "capitalize" }}>{f}</button>
              ))}
            </div>
            <button onClick={toggleSchedule} style={{ width: "100%", padding: "7px", background: schedule.isActive ? `${C.green}15` : "transparent", border: `1px solid ${schedule.isActive ? C.green : C.navyBorder}`, color: schedule.isActive ? C.green : C.slate, borderRadius: 7, fontSize: 11, cursor: "pointer", fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 7 }}>
              <Dot color={schedule.isActive ? C.green : C.slate} size={6} pulse={schedule.isActive} />
              {schedule.isActive ? "Scheduler Active" : "Enable Scheduler"}
            </button>
            {schedule.lastRun && (
              <div style={{ color: C.slate, fontSize: 9, fontFamily: "monospace", marginTop: 6, textAlign: "center" }}>
                Last: {new Date(schedule.lastRun).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
              </div>
            )}
          </div>

          {/* History */}
          <div style={{ padding: "10px 12px", flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <div style={{ color: C.slate, fontSize: 9, fontFamily: "monospace", letterSpacing: 1.5, marginBottom: 8, textTransform: "uppercase" }}>Memory · {briefs.length} Saved</div>
            <div style={{ flex: 1, overflowY: "auto" }}>
              {!briefs.length && (
                <div style={{ textAlign: "center", padding: "20px 0" }}>
                  <div style={{ fontSize: 20, marginBottom: 6 }}>📂</div>
                  <div style={{ color: C.slate, fontSize: 11 }}>No briefs yet</div>
                </div>
              )}
              {briefs.map(b => {
                const isActive = b.id === (activeBriefId || briefs[0]?.id);
                const d = new Date(b.timestamp);
                return (
                  <div key={b.id} onClick={() => setActiveBriefId(b.id)} style={{ padding: "9px 10px", borderRadius: 7, cursor: "pointer", background: isActive ? `${C.orange}18` : "transparent", border: `1px solid ${isActive ? C.orange + "50" : "transparent"}`, marginBottom: 3, display: "flex", justifyContent: "space-between", alignItems: "center", transition: "all 0.15s" }}>
                    <div>
                      <div style={{ color: isActive ? C.orange : C.light, fontSize: 11, fontWeight: 600 }}>{b.type === "daily" ? "Daily Brief" : "Weekly Deep Dive"}</div>
                      <div style={{ color: C.slate, fontSize: 9, marginTop: 2, fontFamily: "monospace" }}>{d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })} {d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</div>
                    </div>
                    <button onClick={e => { e.stopPropagation(); deleteBrief(b.id); }} style={{ background: "none", border: "none", color: C.slate, cursor: "pointer", fontSize: 11, padding: "2px 4px" }}>✕</button>
                  </div>
                );
              })}
            </div>
          </div>

          {briefs.length > 0 && (
            <div style={{ padding: "10px 12px", borderTop: `1px solid ${C.navyBorder}` }}>
              <button onClick={() => { setBriefs([]); lsSet(LS_BRIEFS, []); setActiveBriefId(null); }} style={{ width: "100%", background: "none", border: `1px solid ${C.navyBorder}`, color: C.slate, borderRadius: 6, padding: "6px", fontSize: 10, cursor: "pointer", fontFamily: "monospace" }}>Clear All Memory</button>
            </div>
          )}
        </aside>

        {/* Main */}
        <main style={{ overflowY: "auto", padding: "20px 24px" }}>

          {/* Proxy down warning */}
          {proxyStatus === "error" && !isRunning && (
            <div style={{ background: `${C.red}15`, border: `1px solid ${C.red}40`, borderRadius: 10, padding: "14px 18px", marginBottom: 16 }}>
              <div style={{ color: C.red, fontWeight: 700, marginBottom: 6 }}>⚠ Proxy Server Not Running</div>
              <div style={{ color: C.light, fontSize: 13, marginBottom: 8 }}>The local proxy on port 3001 is not reachable. The agent cannot make API calls without it.</div>
              <div style={{ background: C.navy, borderRadius: 7, padding: "10px 14px", fontFamily: "monospace", fontSize: 12, color: C.green }}>
                Stop everything, then run: <strong>npm run dev</strong>
              </div>
              <div style={{ color: C.slate, fontSize: 11, marginTop: 8 }}>
                This starts both the Vite dev server <em>and</em> the proxy together.
              </div>
            </div>
          )}

          {/* Running */}
          {isRunning && <LoadingScreen />}

          {/* Error */}
          {error && !isRunning && (
            <div style={{ background: `${C.red}18`, border: `1px solid ${C.red}40`, borderRadius: 10, padding: "14px 18px", marginBottom: 16 }}>
              <div style={{ color: C.red, fontWeight: 700, marginBottom: 4 }}>⚠ Agent Error</div>
              <div style={{ color: C.light, fontSize: 13, marginBottom: 6 }}>{error}</div>
              <div style={{ color: C.slate, fontSize: 11, lineHeight: 1.6 }}>
                Common fixes:<br />
                · Check <code style={{ color: C.orange }}>.env</code> has a valid <code style={{ color: C.orange }}>VITE_ANTHROPIC_API_KEY</code><br />
                · Ensure proxy is running: <code style={{ color: C.green }}>npm run dev</code><br />
                · Web search requires a <strong>paid</strong> Anthropic plan
              </div>
            </div>
          )}

          {/* Empty state */}
          {!isRunning && !activeBrief && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "65vh", gap: 22, textAlign: "center" }}>
              <div style={{ width: 76, height: 76, borderRadius: "50%", background: `linear-gradient(135deg, ${C.orange}25, ${C.teal}18)`, border: `1px solid ${C.navyBorder}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 30 }}>🧠</div>
              <div>
                <h2 style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: 26, fontWeight: 700, margin: "0 0 8px", color: C.white }}>Intelligence Agent Ready</h2>
                <p style={{ color: C.slate, margin: 0, fontSize: 13, maxWidth: 420, lineHeight: 1.65 }}>Your autonomous Chief Investment Intelligence Officer for Indian wealth advisory. Click <strong style={{ color: C.orange }}>Run Now</strong> to scan SEBI, AMFI, insurance portals & live market feeds.</p>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, maxWidth: 460 }}>
                {[{ icon: "🌐", label: "Live Web Search", desc: "SEBI · AMFI · Credible Media" }, { icon: "🗃️", label: "Persistent Memory", desc: "Stores 30 past briefs locally" }, { icon: "⏰", label: "Auto-Scheduler", desc: "Daily or Weekly cadence" }].map(f => (
                  <div key={f.label} style={{ background: C.navyMid, border: `1px solid ${C.navyBorder}`, borderRadius: 10, padding: "14px 10px", textAlign: "center" }}>
                    <div style={{ fontSize: 20, marginBottom: 6 }}>{f.icon}</div>
                    <div style={{ color: C.white, fontWeight: 700, fontSize: 12 }}>{f.label}</div>
                    <div style={{ color: C.slate, fontSize: 11, marginTop: 3 }}>{f.desc}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Dashboard */}
          {!isRunning && activeBrief && (
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, fontFamily: "'Playfair Display', Georgia, serif" }}>
                      {activeBrief.type === "daily" ? "Daily Intelligence Brief" : "Weekly Deep Dive"}
                    </h2>
                    <span style={{ background: `${C.orange}20`, color: C.orange, fontSize: 9, fontWeight: 800, letterSpacing: 1.5, padding: "2px 8px", borderRadius: 4, fontFamily: "monospace" }}>LIVE DATA</span>
                  </div>
                  <div style={{ color: C.slate, fontSize: 10, marginTop: 4, fontFamily: "monospace" }}>
                    {new Date(activeBrief.timestamp).toLocaleString("en-IN", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", gap: 2, marginBottom: 20, borderBottom: `1px solid ${C.navyBorder}`, overflowX: "auto" }}>
                {TABS.map(t => (
                  <button key={t.id} onClick={() => setActiveTab(t.id)} style={{ background: activeTab === t.id ? `${C.orange}15` : "none", border: "none", borderBottom: activeTab === t.id ? `2px solid ${C.orange}` : "2px solid transparent", color: activeTab === t.id ? C.orange : C.slate, padding: "10px 13px", cursor: "pointer", fontWeight: 600, fontSize: 12, whiteSpace: "nowrap", transition: "all 0.15s", display: "flex", alignItems: "center", gap: 5 }}>
                    {t.label}
                    {t.count != null && <span style={{ background: `${C.orange}25`, color: C.orange, fontSize: 9, fontWeight: 800, borderRadius: 3, padding: "1px 5px" }}>{t.count}</span>}
                  </button>
                ))}
              </div>

              {activeTab === "snapshot"  && <><SL>Executive Snapshot · Top Signals</SL><SnapshotView  items={activeBrief.data.executiveSnapshot    || []} /></>}
              {activeTab === "detailed"  && <><SL accent={C.gold}>Detailed Intelligence · Click to Expand</SL><DetailedView  items={activeBrief.data.detailedIntelligence || []} /></>}
              {activeTab === "advisory"  && <><SL accent={C.green}>Advisory Edge · Actionable Intelligence</SL><AdvisoryView  data={activeBrief.data.advisoryEdge         || {}} /></>}
              {activeTab === "portfolio" && <><SL accent={C.gold}>Model Portfolio Signals</SL><PortfolioView data={activeBrief.data.modelPortfolioSignals  || {}} /></>}
              {activeTab === "insurance" && <><SL accent={C.teal}>Insurance Intelligence</SL><InsuranceView data={activeBrief.data.insuranceIntelligence  || {}} /></>}

              <div style={{ marginTop: 28, paddingTop: 14, borderTop: `1px solid ${C.navyBorder}`, color: C.slate, fontSize: 9, lineHeight: 1.8, textAlign: "center", fontFamily: "monospace" }}>
                TruEdge Financial Services · AMFI Registered Mutual Funds Distributor · ARN No - 344270<br />
                Investment in securities is subject to market risks. This brief is for advisor use only and does not constitute investment advice.
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
