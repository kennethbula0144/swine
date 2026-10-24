import { useEffect, useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import {
  FaTachometerAlt,
  FaPiggyBank,
  FaBroadcastTower,
  FaChartBar,
  FaHeartbeat,
  FaCalculator,
} from "react-icons/fa";
import { apiRequest } from "../api";

const menuGroups = [
  {
    label: "Monitor",
    items: [
      { name: "Monitoring Console", path: "/", icon: <FaTachometerAlt /> },
      { name: "Live Pen View", path: "/live-pen", icon: <FaBroadcastTower /> },
      { name: "Pig Profiles", path: "/pig-records", icon: <FaPiggyBank /> },
      { name: "Health & Referral", path: "/health-alerts", icon: <FaHeartbeat /> },
    ],
  },
  {
    label: "Insights",
    items: [
      { name: "Herd Analytics", path: "/reports", icon: <FaChartBar /> },
      { name: "Feed Costs", path: "/feed-costs", icon: <FaCalculator /> },
    ],
  },
];

const matchesEnrolledIdentity = (record, identities, pigs) => {
  const identityIds = new Set(identities.map((identity) => identity.pig_id));
  const recordIdentity = record.modelIdentity || record.detectedId || record.pigId;
  if (identityIds.has(recordIdentity)) return true;
  return pigs.some((pig) =>
    identityIds.has(pig.modelIdentity)
    && [pig.id, pig.tagId].includes(recordIdentity),
  );
};

const featureStatus = (path, snapshot) => {
  switch (path) {
    case "/":
      return snapshot.aiReady ? "AI ready" : "Offline";
    case "/live-pen":
      return snapshot.cameraReady || snapshot.aiReady ? "Live" : "Offline";
    case "/pig-records":
      return snapshot.identities.length > 0 ? "Data" : "Empty";
    case "/health-alerts":
      return snapshot.alerts.some((item) => item.status !== "Resolved" && matchesEnrolledIdentity(item, snapshot.identities, snapshot.pigs)) ? "Alerts" : "No alerts";
    case "/reports":
      return snapshot.observations.some((item) => matchesEnrolledIdentity(item, snapshot.identities, snapshot.pigs)) ? "Ready" : "Waiting";
    case "/feed-costs":
      return snapshot.feed.length > 0 ? "Tracked" : "No entries";
    default:
      return "Idle";
  }
};

export default function Sidebar({ isOpen, onClose }) {
  const [snapshot, setSnapshot] = useState({
    aiReady: false,
    cameraReady: false,
    identities: [],
    trainingImages: 0,
    pigs: [],
    observations: [],
    alerts: [],
    feed: [],
  });

  useEffect(() => {
    let active = true;

    Promise.all([
      apiRequest("/api/health").catch(() => ({ integration_loaded: false })),
      apiRequest("/api/camera/status").catch(() => ({ configured: false })),
      apiRequest("/api/pigs?limit=100").catch(() => []),
      apiRequest("/api/observations?limit=100").catch(() => []),
      apiRequest("/api/alerts?limit=100").catch(() => []),
      apiRequest("/api/feed-records?limit=100").catch(() => []),
      apiRequest("/api/ai-camera/identity-dataset").catch(() => ({ classes: [], image_count: 0 })),
    ])
      .then(([health, camera, pigs, observations, alerts, feed, dataset]) => {
        if (!active) return;
        setSnapshot({
          aiReady: Boolean(health.integration_loaded),
          cameraReady: Boolean(camera.configured),
          identities: Array.isArray(dataset.classes) ? dataset.classes : [],
          trainingImages: Number(dataset.image_count) || 0,
          pigs: Array.isArray(pigs) ? pigs : [],
          observations: Array.isArray(observations) ? observations : [],
          alerts: Array.isArray(alerts) ? alerts : [],
          feed: Array.isArray(feed) ? feed : [],
        });
      })
      .catch(() => {
        if (active) {
          setSnapshot({
            aiReady: false,
            cameraReady: false,
            identities: [],
            trainingImages: 0,
            pigs: [],
            observations: [],
            alerts: [],
            feed: [],
          });
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const farmSummary = useMemo(() => {
    const identityIds = new Set(snapshot.identities.map((identity) => identity.pig_id));
    const linkedObservations = snapshot.observations.filter((item) => matchesEnrolledIdentity(item, snapshot.identities, snapshot.pigs));
    const activeAlerts = snapshot.alerts.filter((item) => item.status !== "Resolved" && matchesEnrolledIdentity(item, snapshot.identities, snapshot.pigs)).length;
    const enrolledPigCount = snapshot.pigs.length;
    const hasData = enrolledPigCount > 0 || identityIds.size > 0;

    if (!hasData) {
      return {
        title: "No enrolled pigs",
        description: "Add pig profiles to populate the herd summary.",
      };
    }

    return {
      title: `${enrolledPigCount} pigs enrolled • ${activeAlerts} linked alerts`,
      description: `${snapshot.trainingImages.toLocaleString()} training images • ${linkedObservations.length} linked observations`,
    };
  }, [snapshot]);

  return (
    <aside id="primary-navigation" className={`sidebar-panel ${isOpen ? "is-open" : ""}`}>
      <div className="sidebar-brand">
        <div className="brand-mark">SS</div>
        <div>
          <h4>Smart Swine</h4>
          <p>Fattening pig monitoring</p>
        </div>
      </div>

      <div className="sidebar-context">
        <div className="sidebar-context-kicker">Enrolled herd</div>
        <strong>{farmSummary.title}</strong>
        <p>{farmSummary.description}</p>
      </div>

      <nav className="sidebar-nav">
        {menuGroups.map((group) => (
          <div className="sidebar-group" key={group.label}>
            <div className="sidebar-group-label">{group.label}</div>
            {group.items.map((menu) => {
              const status = featureStatus(menu.path, snapshot);
              const statusClass =
                status === "AI ready" || status === "Live" || status === "Ready" || status === "Data" || status === "Sensors" || status === "Tracked" || status === "Alerts"
                  ? "text-success"
                  : status === "Offline" || status === "Empty" || status === "No alerts" || status === "No readings" || status === "Waiting" || status === "No entries"
                    ? "text-warning"
                    : "text-secondary";

              return (
                <NavLink
                  key={menu.name}
                  to={menu.path}
                  className={({ isActive }) =>
                    `sidebar-link ${isActive ? "active" : ""}`
                  }
                  onClick={onClose}
                >
                  {menu.icon}
                  <span>{menu.name}</span>
                  <span className={`small ms-auto ${statusClass}`}>{status}</span>
                </NavLink>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-footer-status"><span /> {snapshot.aiReady ? "AI backend ready" : "Awaiting data source"}</div>
        <div className="text-white-50 small">Indicators are for veterinary review.</div>
      </div>
    </aside>
  );
}