import { useEffect, useState } from "react";
import DashboardLayout from "../layouts/DashboardLayout";
import EmptyState from "../components/EmptyState";
import { apiRequest } from "../api";

export default function Dashboard() {
  const [backendStatus, setBackendStatus] = useState("Checking backend");
  const [observations, setObservations] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [pigs, setPigs] = useState([]);
  const [identityDataset, setIdentityDataset] = useState({ classes: [], image_count: 0 });
  const [dataError, setDataError] = useState("");

  useEffect(() => {
    let active = true;

    apiRequest("/api/health")
      .then((health) => {
        if (active) setBackendStatus(health.integration_loaded ? "AI integration ready" : "AI integration unavailable");
      })
      .catch(() => {
        if (active) setBackendStatus("Backend unavailable");
      });

    Promise.all([
      apiRequest("/api/observations?limit=500"),
      apiRequest("/api/alerts?limit=500"),
      apiRequest("/api/pigs?limit=200"),
      apiRequest("/api/ai-camera/identity-dataset"),
    ])
      .then(([recentObservations, recentAlerts, registeredPigs, dataset]) => {
        if (!active) return;
        setObservations(recentObservations);
        setAlerts(recentAlerts);
        setPigs(registeredPigs);
        setIdentityDataset(dataset);
      })
      .catch((error) => {
        if (active) setDataError(error.message);
      });

    return () => {
      active = false;
    };
  }, []);

    const registeredIds = new Set([
      ...(identityDataset.classes || []).map((pig) => pig.pig_id),
      ...pigs.map((pig) => pig.modelIdentity),
    ].filter(Boolean));
    const pigProfileIds = new Set(pigs.flatMap((pig) => [pig.id, pig.tagId]).filter(Boolean));
  const linkedObservations = observations.filter((item) =>
    registeredIds.has(item.detectedId)
    || registeredIds.has(item.modelIdentity)
      || registeredIds.has(item.pigId)
      || pigProfileIds.has(item.pigId),
  );
  const linkedAlerts = alerts.filter((item) =>
    registeredIds.has(item.pigId)
      || pigProfileIds.has(item.pigId),
  );
  const uniqueIdentifiedPigs = new Set(linkedObservations.map((item) => item.detectedId || item.modelIdentity || item.pigId).filter(Boolean)).size;

  return (
    <DashboardLayout>
      <section className="page-hero">
        <div>
          <div className="page-badge">LIVE HERD MONITORING</div>
          <h2>Fattening Pig Monitoring Console</h2>
          <p>Recent detections and review alerts saved by the AI backend.</p>
        </div>
      </section>

      <div className="panel-card mb-4">
        <div className="card-body">
          <h5 className="fw-bold mb-2">AI backend</h5>
          <p className="text-muted mb-0" role="status">{backendStatus}</p>
        </div>
      </div>

      {dataError && <div className="alert alert-warning" role="alert">Unable to load farm records: {dataError}</div>}

      <div className="row g-3 mb-4">
        {[
            ["Enrolled pigs", pigs.length],
          ["Linked observations", linkedObservations.length],
          ["Registered pigs identified", uniqueIdentifiedPigs],
          ["Open linked alerts", linkedAlerts.filter((item) => item.status === "Pending").length],
        ].map(([label, value]) => (
          <div className="col-sm-6 col-xl-3" key={label}>
            <div className="stat-card text-center">
              <div className="fs-2 fw-bold">{value}</div>
              <small className="text-muted">{label}</small>
            </div>
          </div>
        ))}
      </div>

      <div className="panel-card mb-4">
        <div className="card-body">
          <h5 className="fw-bold mb-3">Recent camera observations</h5>
          {linkedObservations.length === 0 ? <EmptyState title="No observations linked to enrolled pigs" message="Observations appear here after the recognition model identifies Pig_1 through Pig_4." /> : (
            <div className="table-surface">
              <table className="table table-hover align-middle mb-0">
                <thead className="table-light"><tr><th>Recorded</th><th>Pen tag</th><th>AI class</th><th>Estimated weight</th><th>Identity confidence</th><th>Behavior signal</th></tr></thead>
                <tbody>{linkedObservations.slice(0, 10).map((item) => <tr key={item.id}><td>{new Date(item.createdAt).toLocaleString()}</td><td>{item.pigId || "Unassigned"}</td><td>{item.detectedId || "-"}</td><td>{item.estimatedWeightKg == null ? "-" : <>{item.estimatedWeightKg} kg <small className="text-muted">({item.weightSource === "registered_measurement" ? "registered" : "estimated"})</small></>}</td><td>{item.recognitionConfidence == null ? "-" : `${item.recognitionConfidence}%`}</td><td>{item.behaviorIndicator || "-"}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="panel-card">
        <div className="card-body">
          <h5 className="fw-bold mb-3">Health alerts</h5>
          {linkedAlerts.length === 0 ? <EmptyState title="No alerts linked to enrolled pigs" message="No linked health alerts have been recorded." /> : (
            <div className="table-surface">
              <table className="table table-hover align-middle mb-0">
                <thead className="table-light"><tr><th>Recorded</th><th>Title</th><th>Pig ID</th><th>Severity</th><th>Status</th></tr></thead>
                <tbody>{linkedAlerts.map((item) => <tr key={item.id}><td>{new Date(item.createdAt).toLocaleString()}</td><td>{item.title}</td><td>{item.pigId || "-"}</td><td>{item.severity}</td><td>{item.status}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}