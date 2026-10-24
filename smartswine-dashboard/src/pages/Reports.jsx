import { useEffect, useMemo, useState } from "react";
import DashboardLayout from "../layouts/DashboardLayout";
import EmptyState from "../components/EmptyState";
import { apiRequest } from "../api";

export default function Reports() {
  const [summary, setSummary] = useState({
    pigs: [],
    observations: [],
    alerts: [],
    feed: [],
  });
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;

    Promise.all([
      apiRequest("/api/pigs?limit=200").catch(() => []),
      apiRequest("/api/observations?limit=200").catch(() => []),
      apiRequest("/api/alerts?limit=200").catch(() => []),
      apiRequest("/api/feed-records?limit=200").catch(() => []),
    ])
      .then(([pigs, observations, alerts, feed]) => {
        if (!active) return;
        setSummary({ pigs, observations, alerts, feed });
        setError("");
      })
      .catch((requestError) => {
        if (active) setError(requestError.message);
      });

    return () => {
      active = false;
    };
  }, []);

  const metrics = useMemo(() => {
    const { pigs, observations, alerts, feed } = summary;
    const averageWeight = observations.reduce((sum, item) => sum + (Number(item.estimatedWeightKg) || 0), 0) / (observations.length || 1);
    const openAlerts = alerts.filter((alert) => alert.status !== "Resolved").length;
    const feedSpend = feed.reduce((sum, item) => sum + (Number(item.totalCost) || 0), 0);

    return {
      pigs: pigs.length,
      observations: observations.length,
      alerts: openAlerts,
      averageWeight: Number.isFinite(averageWeight) ? averageWeight : 0,
      feedSpend,
    };
  }, [summary]);

  const hasData = metrics.pigs > 0 || metrics.observations > 0 || metrics.alerts > 0 || metrics.feedSpend > 0;

  return (
    <DashboardLayout>
      <section className="page-hero">
        <div>
          <div className="page-badge">HERD PERFORMANCE</div>
          <h2>Herd Analytics</h2>
            <p>Live farm performance based on enrolled pig records, AI observations, health alerts, and feed data.</p>
        </div>
      </section>

      {error && <div className="alert alert-warning" role="alert">Unable to load analytics: {error}</div>}

      {!hasData ? (
        <div className="panel-card">
          <div className="card-body">
            <h5 className="fw-bold mb-1">Herd reports</h5>
            <EmptyState title="No reports generated" message="There are no stored monitoring records to summarize yet." />
          </div>
        </div>
      ) : (
        <>
          <div className="row g-3 mb-4">
            {[
              ["Pig profiles", metrics.pigs],
              ["AI observations", metrics.observations],
              ["Open alerts", metrics.alerts],
              ["Feed spend", `₱${metrics.feedSpend.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`],
            ].map(([label, value]) => (
              <div className="col-sm-6 col-xl-3" key={label}>
                <div className="stat-card text-center">
                  <div className="fs-2 fw-bold">{value}</div>
                  <small className="text-muted">{label}</small>
                </div>
              </div>
            ))}
          </div>

          <div className="row g-3">
            <div className="col-lg-4">
              <div className="panel-card h-100">
                <div className="card-body">
                  <h5 className="fw-bold mb-3">Average recorded weight</h5>
                  <div className="fs-3 fw-bold">{metrics.averageWeight.toFixed(1)} kg</div>
                  <small className="text-muted">Average across linked observations; registered scale references and model estimates are labeled separately.</small>
                </div>
              </div>
            </div>
            <div className="col-lg-4">
              <div className="panel-card h-100">
                <div className="card-body">
                  <h5 className="fw-bold mb-3">Health status</h5>
                  <div className="fs-3 fw-bold">{metrics.alerts}</div>
                  <small className="text-muted">Open review cases needing attention</small>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </DashboardLayout>
  );
}