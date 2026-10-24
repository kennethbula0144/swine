import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FaBars, FaBell, FaTimes, FaUserCircle } from "react-icons/fa";
import { apiRequest } from "../api";

export default function Navbar({ sidebarOpen, onMenuToggle }) {
  const [open, setOpen] = useState(false);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [alerts, setAlerts] = useState([]);
  const navigate = useNavigate();
  const menuRef = useRef(null);
  const notifRef = useRef(null);

  useEffect(() => {
    let active = true;
    apiRequest("/api/alerts?limit=5")
      .then((storedAlerts) => {
        if (active) setAlerts(storedAlerts);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!open && !notificationOpen) return;
    const handleClickOutside = (event) => {
      if (menuRef.current && menuRef.current.contains(event.target)) return;
      if (notifRef.current && notifRef.current.contains(event.target)) return;
      setOpen(false);
      setNotificationOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open, notificationOpen]);

  const handleProfileAction = (path) => {
    setOpen(false);
    navigate(path);
  };

  return (
    <header className="topbar">
      <button
        type="button"
        className="menu-toggle"
        aria-label="Toggle navigation"
        aria-expanded={sidebarOpen}
        aria-controls="primary-navigation"
        onClick={onMenuToggle}
      >
        {sidebarOpen ? <FaTimes /> : <FaBars />}
      </button>

      <div className="topbar-left d-flex align-items-center gap-3">
        <div className="topbar-logo">
          <div className="topbar-logo-mark">SS</div>
          <div>
            <h4>Smart Swine</h4>
            <p>Fattening Pig Monitoring</p>
          </div>
        </div>
      </div>

      <div className="d-flex gap-3 align-items-center">
        <div className="notification-wrapper" ref={notifRef}>
          <button
            type="button"
            className="topbar-icon-btn"
            aria-label="Notifications"
            aria-expanded={notificationOpen}
            onClick={() => setNotificationOpen((current) => !current)}
          >
            <FaBell />
          </button>
          {notificationOpen && (
            <div className="notification-menu">
              <div className="notification-header d-flex justify-content-between align-items-center">
                <strong>Notifications</strong>
                <button type="button" className="btn btn-link p-0" onClick={() => { setNotificationOpen(false); navigate("/health-alerts"); }}>
                  View all
                </button>
              </div>
              <div className="notification-list">
                {alerts.length === 0 && <div className="notification-item text-muted">No alerts recorded.</div>}
                {alerts.map((alert) => (
                  <button
                    key={alert.id}
                    type="button"
                    className="notification-item"
                    onClick={() => {
                      setNotificationOpen(false);
                      navigate("/health-alerts", { state: { alertId: alert.id } });
                    }}
                  >
                    <div className="d-flex justify-content-between align-items-center mb-1">
                      <span className="fw-semibold">Pig {alert.pig}</span>
                      <span className={`badge bg-${alert.severity === "Critical" ? "danger" : alert.severity === "Warning" ? "warning text-dark" : "info"}`}>{alert.severity}</span>
                    </div>
                    <div className="small text-muted mb-1">{alert.title}</div>
                      <div className="small text-muted">{new Date(alert.createdAt).toLocaleString()}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="profile-wrapper" ref={menuRef}>
          <button
            type="button"
            className="user-pill"
            onClick={() => setOpen((current) => !current)}
            aria-expanded={open}
            aria-label="User menu"
          >
            <FaUserCircle size={28} className="text-muted" />
            <span className="visually-hidden">Account menu</span>
          </button>

          {open && (
            <div className="profile-menu">
              <button type="button" onClick={() => handleProfileAction("/settings")}>Settings</button>
              <button type="button" onClick={() => handleProfileAction("/pig-records")}>My Pigs</button>
              <button type="button" onClick={() => setOpen(false)}>Close</button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}