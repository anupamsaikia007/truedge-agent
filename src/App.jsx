import { useState, useEffect, useRef, useCallback } from "react";
import { Analytics } from "@vercel/analytics/react";

// ─────────────────────────────────────────────────────────────────────────────
// NOTE: No API key needed here. It lives in .env and is read by server.cjs
// All requests go through the local proxy at /api/anthropic (port 3001)
// ─────────────────────────────────────────────────────────────────────────────

const C = {
  bg:        "#000000",
  bgPanel:   "#080808",
  bgCard:    "#0d0d0d",
  border:    "#1c1c1c",
  borderHi:  "#2e2e2e",
  orange:    "#e87722",
  teal:      "#2dd4bf",
  gold:      "#f0c93a",
  slate:     "#444444",
  muted:     "#666666",
  light:     "#999999",
  white:     "#ececec",
  green:     "#22d87a",
  red:       "#e05555",
  purple:    "#a78bfa",
};

const TAG_COLORS = {
  "REGULATION":   { bg: "#e05555",  text: "#fff"    },
  "MUTUAL FUND":  { bg: "#e87722",  text: "#fff"    },
  "INSURANCE":    { bg: "#a78bfa",  text: "#fff"    },
  "MARKET":       { bg: "#2dd4bf",  text: "#000"    },
  "STRATEGY":     { bg: "#f0c93a",  text: "#000"    },
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
- executiveSnapshot: 4-5 items, most critical first
- detailedIntelligence: 2-3 items
- advisoryEdge arrays: 2 items each
- modelPortfolioSignals.sectorOpportunities: 2 items
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
        max_tokens: 2000,
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
    if (res.status === 401) throw new Error("Invalid API key. Check VITE_ANTHROPIC_API_KEY in your .env file.");
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
const lsSet = (k, v)  => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn("localStorage write failed:", e); } };

// ── Atoms ─────────────────────────────────────────────────────────────────────
function Dot({ color, pulse, size = 7 }) {
  return (
    <span style={{ position: "relative", display: "inline-block", width: size, height: size, flexShrink: 0 }}>
      {pulse && <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: color, opacity: 0.4, animation: "ping 1.2s ease infinite" }} />}
      <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: color }} />
    </span>
  );
}

function TagPill({ tag }) {
  const c = TAG_COLORS[tag] || { bg: C.slate, text: "#fff" };
  return (
    <span style={{ background: c.bg, color: c.text, fontSize: 9, fontWeight: 700, letterSpacing: 1.4, padding: "2px 6px", borderRadius: 2, fontFamily: "monospace", textTransform: "uppercase", flexShrink: 0 }}>
      {tag}
    </span>
  );
}

function Card({ children, style = {} }) {
  return (
    <div style={{ background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 8, padding: "16px 18px", ...style }}>
      {children}
    </div>
  );
}

function SectionLabel({ children, accent = C.orange }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
      <div style={{ width: 2, height: 12, background: accent, borderRadius: 1, flexShrink: 0 }} />
      <span style={{ color: accent, fontSize: 10, fontFamily: "monospace", fontWeight: 600, letterSpacing: 2.5, textTransform: "uppercase" }}>{children}</span>
    </div>
  );
}

function ProxyStatus({ status }) {
  if (status === "ok")    return <span style={{ color: C.green, fontSize: 10, fontFamily: "monospace", letterSpacing: 0.5 }}>● Proxy OK</span>;
  if (status === "error") return <span style={{ color: C.red,   fontSize: 10, fontFamily: "monospace", letterSpacing: 0.5 }}>● Proxy DOWN</span>;
  return <span style={{ color: C.slate, fontSize: 10, fontFamily: "monospace" }}>● —</span>;
}

// ── Loading screen ────────────────────────────────────────────────────────────
function LoadingScreen() {
  const steps = [
    "Fetching SEBI circulars & AMFI data",
    "Scanning ET Wealth · Mint · Business Standard",
    "Analysing mutual fund performance signals",
    "Synthesising advisory intelligence",
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 32, padding: "80px 20px" }}>
      <div style={{ position: "relative", width: 56, height: 56 }}>
        <div style={{ position: "absolute", inset: 0, borderRadius: "50%", border: `1px solid ${C.border}` }} />
        <div style={{ position: "absolute", inset: 0, borderRadius: "50%", border: "1px solid transparent", borderTopColor: C.orange, animation: "spin 1s linear infinite" }} />
        <div style={{ position: "absolute", inset: 10, borderRadius: "50%", border: "1px solid transparent", borderTopColor: C.teal, animation: "spin 1.6s linear infinite reverse" }} />
      </div>
      <div style={{ textAlign: "center" }}>
        <div style={{ color: C.white, fontWeight: 600, fontSize: 14, marginBottom: 4, letterSpacing: 0.2 }}>Agent Running</div>
        <div style={{ color: C.muted, fontSize: 11, fontFamily: "monospace" }}>Scanning SEBI · AMFI · Market Feeds</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%", maxWidth: 360 }}>
        {steps.map((s, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, border: `1px solid ${C.border}`, borderRadius: 6, padding: "9px 13px", animation: `fadeIn 0.4s ease ${i * 0.3}s both` }}>
            <span style={{ color: C.teal, fontSize: 9, fontFamily: "monospace", flexShrink: 0 }}>▶</span>
            <span style={{ color: C.light, fontSize: 11, fontFamily: "monospace" }}>{s}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Tab views ─────────────────────────────────────────────────────────────────
function SnapshotView({ items }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {items.map((item, i) => (
        <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 14, background: C.bgCard, border: `1px solid ${C.border}`, borderLeft: `2px solid ${TAG_COLORS[item.tag]?.bg || C.orange}`, borderRadius: 6, padding: "12px 16px", animation: `fadeIn 0.25s ease ${i * 0.05}s both` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0, paddingTop: 1 }}>
            <span style={{ color: C.slate, fontSize: 10, fontFamily: "monospace", minWidth: 18 }}>{String(i + 1).padStart(2, "0")}</span>
            <TagPill tag={item.tag} />
          </div>
          <p style={{ margin: 0, color: C.light, fontSize: 13, lineHeight: 1.7 }}>{item.insight}</p>
        </div>
      ))}
    </div>
  );
}

function DetailedView({ items }) {
  const [open, setOpen] = useState(0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {items.map((item, i) => (
        <div key={i} style={{ background: C.bgCard, border: `1px solid ${open === i ? C.orange + "44" : C.border}`, borderRadius: 8, overflow: "hidden", animation: `fadeIn 0.25s ease ${i * 0.06}s both` }}>
          <button onClick={() => setOpen(open === i ? -1 : i)} style={{ width: "100%", background: "none", border: "none", cursor: "pointer", padding: "14px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
            <span style={{ color: C.white, fontWeight: 600, fontSize: 13, textAlign: "left", letterSpacing: 0.1 }}>{item.title}</span>
            <span style={{ color: C.slate, flexShrink: 0, fontSize: 11, transform: open === i ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>▾</span>
          </button>
          {open === i && (
            <div style={{ padding: "0 18px 16px", borderTop: `1px solid ${C.border}` }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, paddingTop: 16 }}>
                <div>
                  <div style={{ color: C.muted, fontSize: 9, fontFamily: "monospace", letterSpacing: 2, marginBottom: 8, textTransform: "uppercase" }}>Summary</div>
                  <p style={{ margin: 0, color: C.light, fontSize: 13, lineHeight: 1.7 }}>{item.summary}</p>
                </div>
                <div>
                  <div style={{ color: C.muted, fontSize: 9, fontFamily: "monospace", letterSpacing: 2, marginBottom: 8, textTransform: "uppercase" }}>Why It Matters</div>
                  <p style={{ margin: 0, color: C.light, fontSize: 13, lineHeight: 1.7 }}>{item.whyItMatters}</p>
                </div>
              </div>
              <div style={{ marginTop: 14, background: `${C.orange}0d`, border: `1px solid ${C.orange}30`, borderRadius: 6, padding: "11px 14px" }}>
                <div style={{ color: C.orange, fontSize: 9, fontFamily: "monospace", letterSpacing: 2, marginBottom: 6, textTransform: "uppercase" }}>Actionable Takeaway</div>
                <p style={{ margin: 0, color: C.light, fontSize: 13, lineHeight: 1.7 }}>{item.actionableTakeaway}</p>
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
    { key: "newInvestmentIdeas",   label: "New Investment Ideas",  color: C.gold   },
    { key: "portfolioPositioning", label: "Portfolio Positioning",  color: C.teal   },
    { key: "riskAlerts",           label: "Risk Alerts",           color: C.red    },
    { key: "clientOpportunities",  label: "Client Opportunities",  color: C.green  },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
      {secs.map(({ key, label, color }) => (
        <Card key={key}>
          <div style={{ marginBottom: 14 }}>
            <div style={{ color: color, fontSize: 10, fontFamily: "monospace", fontWeight: 600, letterSpacing: 2, textTransform: "uppercase" }}>{label}</div>
          </div>
          {(data[key] || []).map((item, i) => (
            <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", paddingBottom: i < (data[key].length - 1) ? 10 : 0, marginBottom: i < (data[key].length - 1) ? 10 : 0, borderBottom: i < (data[key].length - 1) ? `1px solid ${C.border}` : "none" }}>
              <span style={{ color: color, fontSize: 8, marginTop: 5, flexShrink: 0 }}>��</span>
              <span style={{ color: C.light, fontSize: 13, lineHeight: 1.65 }}>{item}</span>
            </div>
          ))}
        </Card>
      ))}
    </div>
  );
}

function PortfolioView({ data }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Card><SectionLabel accent={C.gold}>Asset Allocation Trend</SectionLabel><p style={{ margin: 0, color: C.light, fontSize: 13, lineHeight: 1.7 }}>{data.assetAllocationTrend}</p></Card>
        <Card><SectionLabel accent={C.teal}>Debt vs Equity Positioning</SectionLabel><p style={{ margin: 0, color: C.light, fontSize: 13, lineHeight: 1.7 }}>{data.debtVsEquityPositioning}</p></Card>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Card>
          <SectionLabel accent={C.orange}>Sector Opportunities</SectionLabel>
          {(data.sectorOpportunities || []).map((s, i) => (
            <div key={i} style={{ display: "flex", gap: 10, marginBottom: 8 }}>
              <span style={{ color: C.orange, fontSize: 9, marginTop: 4, flexShrink: 0 }}>▸</span>
              <span style={{ color: C.light, fontSize: 13, lineHeight: 1.65 }}>{s}</span>
            </div>
          ))}
        </Card>
        <Card><SectionLabel accent={C.green}>SIP / STP Strategy</SectionLabel><p style={{ margin: 0, color: C.light, fontSize: 13, lineHeight: 1.7 }}>{data.sipSTPStrategy}</p></Card>
      </div>
    </div>
  );
}

function InsuranceView({ data }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
      {[
        { key: "termInsuranceTrends",    label: "Term Insurance Trends",    color: C.teal   },
        { key: "healthInsuranceChanges", label: "Health Insurance Changes", color: C.green  },
        { key: "claimDevelopments",      label: "Claim Developments",       color: C.gold   },
      ].map(({ key, label, color }) => (
        <Card key={key}>
          <div style={{ color: color, fontSize: 10, fontFamily: "monospace", fontWeight: 600, letterSpacing: 2, textTransform: "uppercase", marginBottom: 12 }}>{label}</div>
          <p style={{ margin: 0, color: C.light, fontSize: 13, lineHeight: 1.7 }}>{data[key]}</p>
        </Card>
      ))}
      <Card>
        <div style={{ color: C.purple, fontSize: 10, fontFamily: "monospace", fontWeight: 600, letterSpacing: 2, textTransform: "uppercase", marginBottom: 12 }}>Product Innovations</div>
        {(data.productInnovations || []).map((p, i) => (
          <div key={i} style={{ display: "flex", gap: 10, marginBottom: 8 }}>
            <span style={{ color: C.purple, fontSize: 8, marginTop: 5, flexShrink: 0 }}>◆</span>
            <span style={{ color: C.light, fontSize: 13, lineHeight: 1.65 }}>{p}</span>
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

  const timerRef    = useRef(null);
  const scheduleRef = useRef(schedule);
  useEffect(() => { scheduleRef.current = schedule; }, [schedule]);

  useEffect(() => {
    if (briefs.length) setActiveBriefId(briefs[0].id);
    fetch("/api/anthropic", { method: "OPTIONS" })
      .then(() => setProxyStatus("ok"))
      .catch(() => setProxyStatus("error"));
  }, []);

  useEffect(() => { lsSet(LS_SCHEDULE, schedule); }, [schedule]);

  useEffect(() => {
    clearInterval(timerRef.current);
    if (!schedule.isActive) return;
    timerRef.current = setInterval(() => {
      const { frequency, lastRun, isActive } = scheduleRef.current;
      if (!isActive) return;
      const interval = frequency === "daily" ? 86_400_000 : 604_800_000;
      if (Date.now() - (lastRun || 0) >= interval) handleRun(frequency);
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
    { id: "snapshot",  label: "Snapshot",         count: activeBrief?.data?.executiveSnapshot?.length    },
    { id: "detailed",  label: "Intelligence",      count: activeBrief?.data?.detailedIntelligence?.length },
    { id: "advisory",  label: "Advisory Edge"                                                              },
    { id: "portfolio", label: "Portfolio Signals"                                                          },
    { id: "insurance", label: "Insurance Intel"                                                            },
  ];

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.white, fontFamily: "'Inter', system-ui, -apple-system, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; }
        @keyframes spin   { to { transform: rotate(360deg); } }
        @keyframes ping   { 75%, 100% { transform: scale(2.2); opacity: 0; } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
        button { font-family: inherit; }
        button:focus { outline: none; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #222; border-radius: 2px; }
      `}</style>

      {/* Header */}
      <header style={{
        background: C.bg,
        borderBottom: `1px solid ${C.border}`,
        padding: "0 24px",
        height: 56,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        position: "sticky",
        top: 0,
        zIndex: 100,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 28, height: 28, borderRadius: 6, background: C.orange, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 13, color: "#fff", letterSpacing: -0.5, flexShrink: 0 }}>T</div>
          <div>
            <div style={{ color: C.white, fontWeight: 600, fontSize: 13, letterSpacing: -0.2 }}>TruEdge Financial Services</div>
            <div style={{ color: C.slate, fontSize: 9, letterSpacing: 2.5, textTransform: "uppercase", fontFamily: "monospace" }}>Intelligence Agent · ARN-344270</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <ProxyStatus status={proxyStatus} />
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <Dot color={isRunning ? C.orange : schedule.isActive ? C.green : C.slate} pulse={isRunning || schedule.isActive} />
            <span style={{ color: C.muted, fontSize: 10, fontFamily: "monospace", letterSpacing: 1 }}>{isRunning ? "RUNNING" : schedule.isActive ? "SCHEDULED" : "IDLE"}</span>
          </div>
          {nextRunText() && <span style={{ color: C.slate, fontSize: 10, fontFamily: "monospace" }}>{nextRunText()}</span>}
        </div>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", minHeight: "calc(100vh - 56px)" }}>

        {/* Sidebar */}
        <aside style={{
          background: C.bgPanel,
          borderRight: `1px solid ${C.border}`,
          display: "flex",
          flexDirection: "column",
          position: "sticky",
          top: 56,
          height: "calc(100vh - 56px)",
          overflowY: "auto",
        }}>

          {/* Run controls */}
          <div style={{ padding: "16px 14px", borderBottom: `1px solid ${C.border}` }}>
            <div style={{ color: C.slate, fontSize: 9, fontFamily: "monospace", letterSpacing: 2, marginBottom: 10, textTransform: "uppercase" }}>Brief Type</div>
            <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
              {["daily", "weekly"].map(t => (
                <button key={t} onClick={() => setBriefType(t)} style={{
                  flex: 1,
                  background: briefType === t ? `${C.orange}18` : "transparent",
                  border: `1px solid ${briefType === t ? C.orange + "66" : C.border}`,
                  color: briefType === t ? C.orange : C.muted,
                  borderRadius: 5,
                  padding: "6px 0",
                  fontSize: 11,
                  cursor: "pointer",
                  fontWeight: briefType === t ? 600 : 400,
                  textTransform: "capitalize",
                  letterSpacing: 0.3,
                  transition: "all 0.15s",
                }}>{t}</button>
              ))}
            </div>
            <button onClick={() => handleRun()} disabled={isRunning} style={{
              width: "100%",
              padding: "9px",
              background: isRunning ? "transparent" : C.orange,
              border: `1px solid ${isRunning ? C.border : C.orange}`,
              borderRadius: 6,
              color: isRunning ? C.muted : "#fff",
              fontWeight: 600,
              fontSize: 12,
              cursor: isRunning ? "not-allowed" : "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 7,
              letterSpacing: 0.3,
              transition: "all 0.15s",
            }}>
              {isRunning
                ? <><span style={{ animation: "spin 0.9s linear infinite", display: "inline-block", fontSize: 13 }}>⟳</span> Running…</>
                : "▶  Run Now"
              }
            </button>
          </div>

          {/* Scheduler */}
          <div style={{ padding: "14px", borderBottom: `1px solid ${C.border}` }}>
            <div style={{ color: C.slate, fontSize: 9, fontFamily: "monospace", letterSpacing: 2, marginBottom: 10, textTransform: "uppercase" }}>Auto-Scheduler</div>
            <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
              {["daily", "weekly"].map(f => (
                <button key={f} onClick={() => setFreq(f)} style={{
                  flex: 1,
                  background: schedule.frequency === f ? `${C.teal}15` : "transparent",
                  border: `1px solid ${schedule.frequency === f ? C.teal + "55" : C.border}`,
                  color: schedule.frequency === f ? C.teal : C.muted,
                  borderRadius: 5,
                  padding: "5px 0",
                  fontSize: 11,
                  cursor: "pointer",
                  textTransform: "capitalize",
                  transition: "all 0.15s",
                }}>{f}</button>
              ))}
            </div>
            <button onClick={toggleSchedule} style={{
              width: "100%",
              padding: "7px",
              background: schedule.isActive ? `${C.green}12` : "transparent",
              border: `1px solid ${schedule.isActive ? C.green + "44" : C.border}`,
              color: schedule.isActive ? C.green : C.muted,
              borderRadius: 5,
              fontSize: 11,
              cursor: "pointer",
              fontWeight: 500,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 7,
              transition: "all 0.15s",
            }}>
              <Dot color={schedule.isActive ? C.green : C.slate} size={6} pulse={schedule.isActive} />
              {schedule.isActive ? "Scheduler Active" : "Enable Scheduler"}
            </button>
            {schedule.lastRun && (
              <div style={{ color: C.slate, fontSize: 9, fontFamily: "monospace", marginTop: 8, textAlign: "center" }}>
                Last: {new Date(schedule.lastRun).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
              </div>
            )}
          </div>

          {/* History */}
          <div style={{ padding: "12px 14px", flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <div style={{ color: C.slate, fontSize: 9, fontFamily: "monospace", letterSpacing: 2, marginBottom: 10, textTransform: "uppercase" }}>Memory · {briefs.length} Saved</div>
            <div style={{ flex: 1, overflowY: "auto" }}>
              {!briefs.length && (
                <div style={{ textAlign: "center", padding: "24px 0", color: C.slate, fontSize: 11 }}>
                  No briefs yet
                </div>
              )}
              {briefs.map(b => {
                const isActive = b.id === (activeBriefId || briefs[0]?.id);
                const d = new Date(b.timestamp);
                return (
                  <div key={b.id} onClick={() => setActiveBriefId(b.id)} style={{
                    padding: "9px 10px",
                    borderRadius: 6,
                    cursor: "pointer",
                    background: isActive ? `${C.orange}12` : "transparent",
                    border: `1px solid ${isActive ? C.orange + "44" : "transparent"}`,
                    marginBottom: 3,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    transition: "all 0.12s",
                  }}>
                    <div>
                      <div style={{ color: isActive ? C.orange : C.light, fontSize: 11, fontWeight: 500 }}>{b.type === "daily" ? "Daily Brief" : "Weekly Deep Dive"}</div>
                      <div style={{ color: C.slate, fontSize: 9, marginTop: 2, fontFamily: "monospace" }}>{d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })} {d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</div>
                    </div>
                    <button onClick={e => { e.stopPropagation(); deleteBrief(b.id); }} style={{ background: "none", border: "none", color: C.slate, cursor: "pointer", fontSize: 11, padding: "2px 5px", opacity: 0.6 }}>✕</button>
                  </div>
                );
              })}
            </div>
          </div>

          {briefs.length > 0 && (
            <div style={{ padding: "10px 14px", borderTop: `1px solid ${C.border}` }}>
              <button onClick={() => { setBriefs([]); lsSet(LS_BRIEFS, []); setActiveBriefId(null); }} style={{ width: "100%", background: "none", border: `1px solid ${C.border}`, color: C.muted, borderRadius: 5, padding: "6px", fontSize: 10, cursor: "pointer", fontFamily: "monospace", letterSpacing: 0.5 }}>Clear All</button>
            </div>
          )}
        </aside>

        {/* Main content */}
        <main style={{
          overflowY: "auto",
          padding: "24px 28px",
          backgroundImage: `linear-gradient(${C.border} 1px, transparent 1px), linear-gradient(90deg, ${C.border} 1px, transparent 1px)`,
          backgroundSize: "40px 40px",
          backgroundPosition: "-1px -1px",
        }}>

          {/* Proxy down warning */}
          {proxyStatus === "error" && !isRunning && (
            <div style={{ background: C.bgCard, border: `1px solid ${C.red}44`, borderRadius: 8, padding: "14px 18px", marginBottom: 16 }}>
              <div style={{ color: C.red, fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Proxy Server Not Running</div>
              <div style={{ color: C.light, fontSize: 12, marginBottom: 10 }}>The local proxy on port 3001 is not reachable. The agent cannot make API calls without it.</div>
              <code style={{ display: "block", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 5, padding: "9px 13px", fontFamily: "monospace", fontSize: 12, color: C.green }}>npm run dev</code>
            </div>
          )}

          {/* Running */}
          {isRunning && <LoadingScreen />}

          {/* Error */}
          {error && !isRunning && (
            <div style={{ background: C.bgCard, border: `1px solid ${C.red}44`, borderRadius: 8, padding: "14px 18px", marginBottom: 16 }}>
              <div style={{ color: C.red, fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Agent Error</div>
              <div style={{ color: C.light, fontSize: 13, marginBottom: 10 }}>{error}</div>
              <div style={{ color: C.muted, fontSize: 11, lineHeight: 1.8, fontFamily: "monospace" }}>
                · Check <span style={{ color: C.orange }}>.env</span> has a valid <span style={{ color: C.orange }}>VITE_ANTHROPIC_API_KEY</span><br />
                · Ensure proxy is running: <span style={{ color: C.green }}>npm run dev</span><br />
                · Web search requires a paid Anthropic plan
              </div>
            </div>
          )}

          {/* Empty state */}
          {!isRunning && !activeBrief && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "65vh", gap: 28, textAlign: "center" }}>
              <div style={{ width: 60, height: 60, borderRadius: 12, background: C.bgCard, border: `1px solid ${C.borderHi}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26 }}>
                <span style={{ filter: "grayscale(0.2)" }}>🧠</span>
              </div>
              <div>
                <h2 style={{ fontSize: 22, fontWeight: 600, margin: "0 0 8px", color: C.white, letterSpacing: -0.5 }}>Intelligence Agent Ready</h2>
                <p style={{ color: C.muted, margin: 0, fontSize: 13, maxWidth: 380, lineHeight: 1.7 }}>Your autonomous Chief Investment Intelligence Officer for Indian wealth advisory. Click <span style={{ color: C.orange, fontWeight: 500 }}>Run Now</span> to scan SEBI, AMFI, insurance portals & live market feeds.</p>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, maxWidth: 420 }}>
                {[
                  { label: "Live Web Search",    desc: "SEBI · AMFI · Credible Media" },
                  { label: "Persistent Memory",  desc: "Stores 30 past briefs locally" },
                  { label: "Auto-Scheduler",     desc: "Daily or Weekly cadence"       },
                ].map(f => (
                  <div key={f.label} style={{ background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 8, padding: "16px 12px", textAlign: "center" }}>
                    <div style={{ color: C.white, fontWeight: 600, fontSize: 12, marginBottom: 4 }}>{f.label}</div>
                    <div style={{ color: C.muted, fontSize: 11, lineHeight: 1.5 }}>{f.desc}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Dashboard */}
          {!isRunning && activeBrief && (
            <div>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 22 }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 5 }}>
                    <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, letterSpacing: -0.3 }}>
                      {activeBrief.type === "daily" ? "Daily Intelligence Brief" : "Weekly Deep Dive"}
                    </h2>
                    <span style={{ background: `${C.orange}18`, color: C.orange, fontSize: 9, fontWeight: 600, letterSpacing: 1.5, padding: "2px 7px", borderRadius: 3, fontFamily: "monospace" }}>LIVE DATA</span>
                  </div>
                  <div style={{ color: C.slate, fontSize: 10, fontFamily: "monospace" }}>
                    {new Date(activeBrief.timestamp).toLocaleString("en-IN", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </div>
                </div>
              </div>

              {/* Tabs */}
              <div style={{ display: "flex", gap: 1, marginBottom: 22, borderBottom: `1px solid ${C.border}`, overflowX: "auto" }}>
                {TABS.map(t => (
                  <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
                    background: "none",
                    border: "none",
                    borderBottom: activeTab === t.id ? `2px solid ${C.orange}` : "2px solid transparent",
                    color: activeTab === t.id ? C.white : C.muted,
                    padding: "8px 14px",
                    cursor: "pointer",
                    fontWeight: activeTab === t.id ? 600 : 400,
                    fontSize: 12,
                    whiteSpace: "nowrap",
                    transition: "all 0.15s",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    marginBottom: -1,
                    letterSpacing: 0.1,
                  }}>
                    {t.label}
                    {t.count != null && (
                      <span style={{ background: C.border, color: C.muted, fontSize: 9, fontWeight: 600, borderRadius: 3, padding: "1px 5px", fontFamily: "monospace" }}>{t.count}</span>
                    )}
                  </button>
                ))}
              </div>

              {activeTab === "snapshot"  && <><SectionLabel>Executive Snapshot · Top Signals</SectionLabel><SnapshotView  items={activeBrief.data.executiveSnapshot    || []} /></>}
              {activeTab === "detailed"  && <><SectionLabel accent={C.gold}>Detailed Intelligence</SectionLabel><DetailedView  items={activeBrief.data.detailedIntelligence || []} /></>}
              {activeTab === "advisory"  && <><SectionLabel accent={C.green}>Advisory Edge · Actionable Intelligence</SectionLabel><AdvisoryView  data={activeBrief.data.advisoryEdge         || {}} /></>}
              {activeTab === "portfolio" && <><SectionLabel accent={C.gold}>Model Portfolio Signals</SectionLabel><PortfolioView data={activeBrief.data.modelPortfolioSignals  || {}} /></>}
              {activeTab === "insurance" && <><SectionLabel accent={C.teal}>Insurance Intelligence</SectionLabel><InsuranceView data={activeBrief.data.insuranceIntelligence  || {}} /></>}

              <div style={{ marginTop: 40, paddingTop: 16, borderTop: `1px solid ${C.border}`, color: C.slate, fontSize: 9, lineHeight: 2, textAlign: "center", fontFamily: "monospace", letterSpacing: 0.5 }}>
                TruEdge Financial Services · AMFI Registered Mutual Funds Distributor · ARN No - 344270<br />
                Investment in securities is subject to market risks. This brief is for advisor use only and does not constitute investment advice.
              </div>
            </div>
          )}
        </main>
      </div>
      <Analytics />
    </div>
  );
}
