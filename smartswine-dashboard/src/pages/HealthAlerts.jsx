import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import DashboardLayout from "../layouts/DashboardLayout";
import EmptyState from "../components/EmptyState";
import { apiRequest } from "../api";

export default function HealthAlerts() {
  const location = useLocation();
  const [filter, setFilter] = useState("All");
  const [alerts, setAlerts] = useState([]);
  const [selectedAlert, setSelectedAlert] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    apiRequest("/api/alerts")
      .then((storedAlerts) => {
        if (active) setAlerts(storedAlerts);
      })
      .catch((requestError) => {
        if (active) setError(requestError.message);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const alertId = location.state?.alertId;
    if (!alertId) return;
    const target = alerts.find((alert) => alert.id === alertId);
    if (target) {
      setSelectedAlert(target);
      setFilter("All");
    }
  }, [location.state, alerts]);

  const filteredAlerts =
    filter === "All"
      ? alerts
      : alerts.filter((alert) => alert.severity === filter || alert.status === filter);

  const badgeColor = (severity) => {
    switch (severity) {
      case "Critical":
        return "danger";
      case "Warning":
        return "warning";
      case "Info":
        return "info";
      default:
        return "secondary";
    }
  };

  const updateAlert = async (alertId, changes) => {
    try {
      const saved = await apiRequest(`/api/alerts/${encodeURIComponent(alertId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      setAlerts((current) => current.map((item) => item.id === alertId ? saved : item));
      setSelectedAlert(saved);
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  return (
    <DashboardLayout>
      <section className="page-hero">
        <div>
          <div className="page-badge">VETERINARY REFERRAL SUPPORT</div>
          <h2>Health Indicators & Referral</h2>
          <p>Review behavior, visible condition, and temperature indicators that may require closer examination. The system supports referral decisions; it does not diagnose disease.</p>
        </div>
        <div className="chip-list">
          <span className="chip">{alerts.length} stored alerts</span>
        </div>
      </section>

      {error && <div className="alert alert-warning" role="alert">{error}</div>}

      <div className="d-flex flex-wrap gap-2 mb-4">
        <button className={`btn ${filter === "All" ? "btn-success" : "btn-outline-success"}`} onClick={() => setFilter("All")}>All</button>
        <button className={`btn ${filter === "Critical" ? "btn-danger" : "btn-outline-danger"}`} onClick={() => setFilter("Critical")}>Referral priority</button>
        <button className={`btn ${filter === "Warning" ? "btn-warning" : "btn-outline-warning"}`} onClick={() => setFilter("Warning")}>Observe</button>
        <button className={`btn ${filter === "Resolved" ? "btn-primary" : "btn-outline-primary"}`} onClick={() => setFilter("Resolved")}>Reviewed</button>
      </div>

      {filteredAlerts.length === 0 ? <EmptyState title="No health alerts" message="Alerts will appear here when monitoring events are connected." /> : <div className="row">
        {filteredAlerts.map((alert) => (
          <div className="col-lg-6 mb-4" key={alert.id}>
            <div className="panel-card h-100 alert-card" onClick={() => setSelectedAlert(alert)}>
              <div className="card-body">
                <div className="d-flex justify-content-between align-items-start gap-3 flex-wrap">
                  <div>
                    <div className="fw-semibold" style={{ fontSize: "1rem" }}>
                      Pig {alert.pigId || "Unassigned"}
                    </div>
                    <p className="mb-1">{alert.title}</p>
                    <small className="text-muted">Possible indicator: {alert.indicator || alert.title}</small>
                    <small className="text-muted d-block">{alert.createdAt ? new Date(alert.createdAt).toLocaleString() : alert.date || "No timestamp"}</small>
                  </div>

                  <div className="text-end">
                    <span className={`badge bg-${badgeColor(alert.severity)}`}>{alert.severity}</span>
                    <br />
                    <br />
                    <span className={`badge ${alert.referralStatus === "Referred" ? "bg-primary" : alert.status === "Pending" ? "bg-warning text-dark" : "bg-success"}`}>{alert.referralStatus || alert.status}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>}

      {selectedAlert && (
        <div className="modal-backdrop" onClick={() => setSelectedAlert(null)}>
          <div className="detail-modal" onClick={(e) => e.stopPropagation()}>
            <div className="d-flex justify-content-between align-items-start mb-4 gap-3 flex-wrap">
              <div>
                <h5 className="fw-bold mb-1">Pig {selectedAlert.pigId || "Unassigned"} alert</h5>
                <p className="mb-1">{selectedAlert.title}</p>
                <small className="text-muted">{selectedAlert.createdAt ? new Date(selectedAlert.createdAt).toLocaleString() : selectedAlert.date || "No timestamp"}</small>
              </div>
              <div className="d-flex gap-2 flex-wrap">
                <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setSelectedAlert(null)}>
                  Close
                </button>
                {selectedAlert.referralStatus !== "Referred" && selectedAlert.status !== "Resolved" && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => updateAlert(selectedAlert.id, { referralStatus: "Referred", status: "Referral sent" })}
                  >
                    Refer to veterinarian
                  </button>
                )}
                {selectedAlert.referralStatus === "Referred" && <span className="badge bg-primary align-self-center">Referral sent</span>}
                {selectedAlert.status !== "Resolved" && selectedAlert.referralStatus !== "Referred" && (
                  <button type="button" className="btn btn-sm btn-success" onClick={() => updateAlert(selectedAlert.id, { status: "Reviewed" })}>
                    Mark reviewed
                  </button>
                )}
              </div>
            </div>

            <div className="row g-3 mb-4">
              <div className="col-md-4">
                <div className="stat-card p-3 text-center">
                  <div className="text-muted mb-2">Severity</div>
                  <div className={`badge bg-${badgeColor(selectedAlert.severity)} px-3 py-2`}>{selectedAlert.severity}</div>
                </div>
              </div>
              <div className="col-md-4">
                <div className="stat-card p-3 text-center">
                  <div className="text-muted mb-2">Status</div>
                    <div className={`badge ${selectedAlert.referralStatus === "Referred" ? "bg-primary" : selectedAlert.status === "Pending" ? "bg-warning text-dark" : "bg-success"} px-3 py-2`}>
                    {selectedAlert.referralStatus || selectedAlert.status}
                  </div>
                </div>
              </div>
              <div className="col-md-4">
                <div className="stat-card p-3 text-center">
                  <div className="text-muted mb-2">Pig ID</div>
                  <div className="fs-4 fw-bold">{selectedAlert.pigId || "Unassigned"}</div>
                </div>
              </div>
            </div>

            <div className="referral-evidence-panel mb-4">
              <div className="referral-evidence-header">
                <div>
                  <div className="page-badge mb-2">POSSIBLE ABNORMALITY</div>
                  <h6 className="fw-bold mb-1">What the system detected</h6>
                </div>
                <span className="badge bg-warning text-dark">{selectedAlert.type || "Monitoring signal"}</span>
              </div>
              <p className="mb-2"><strong>Indicator:</strong> {selectedAlert.indicator || selectedAlert.title}</p>
              <p className="text-muted mb-2"><strong>Evidence:</strong> {selectedAlert.evidence || "A monitoring signal crossed a configured review condition."}</p>
              <p className="text-muted mb-0"><strong>Next step:</strong> {selectedAlert.nextAction || "Review the animal and consult a veterinarian when appropriate."}</p>
              <div className="referral-disclaimer mt-3">The system detects possible health abnormalities or indicators that may require further examination. The system supports veterinary referral; it does not replace a veterinarian.</div>
            </div>

            <EmptyState title="No trend history" message="No historical observations are available for this alert." />
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}