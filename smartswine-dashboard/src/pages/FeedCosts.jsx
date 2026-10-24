import { useEffect, useMemo, useState } from "react";
import { FaCalculator, FaCoins, FaWeightHanging } from "react-icons/fa";
import DashboardLayout from "../layouts/DashboardLayout";
import { apiRequest } from "../api";

const today = new Date().toISOString().slice(0, 10);

const emptyForm = {
  date: today,
  pigs: "",
  feedPerPig: "",
  costPerKg: "",
};

const periodDays = {
  daily: 1,
  weekly: 7,
  monthly: 30,
  yearly: 365,
};

const formatMoney = (value) =>
  `₱${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const dateDifference = (fromDate, toDate) => {
  const from = new Date(`${fromDate}T00:00:00`);
  const to = new Date(`${toDate}T00:00:00`);
  return Math.floor((to - from) / 86400000);
};

export default function FeedCosts() {
  const [formData, setFormData] = useState(emptyForm);
  const [records, setRecords] = useState([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [selectedDate, setSelectedDate] = useState(today);

  useEffect(() => {
    let active = true;
    apiRequest("/api/feed-records")
      .then((savedRecords) => {
        if (active) setRecords(savedRecords);
      })
      .catch((requestError) => {
        if (active) setError(requestError.message);
      });
    return () => {
      active = false;
    };
  }, []);

  const currentDaily = useMemo(() => {
    const pigs = Number(formData.pigs) || 0;
    const feedPerPig = Number(formData.feedPerPig) || 0;
    const costPerKg = Number(formData.costPerKg) || 0;
    const totalKg = pigs * feedPerPig;

    return { totalKg, totalCost: totalKg * costPerKg };
  }, [formData]);

  const summaries = useMemo(() => {
    return Object.entries(periodDays).map(([key, days]) => {
      const matchingRecords = records.filter((record) => {
        const difference = dateDifference(record.date, selectedDate);
        return difference >= 0 && difference < days;
      });

      const feedKg = matchingRecords.reduce((total, record) => total + record.totalKg, 0);
      const cost = matchingRecords.reduce((total, record) => total + record.totalCost, 0);

      return { key, feedKg, cost };
    });
  }, [records, selectedDate]);

  const handleChange = (event) => {
    const { name, value } = event.target;
    setFormData((current) => ({ ...current, [name]: value }));
  };

  const addRecord = async (event) => {
    event.preventDefault();
    if (!formData.date || Number(formData.pigs) <= 0 || Number(formData.feedPerPig) <= 0 || Number(formData.costPerKg) <= 0) return;

    setSaving(true);
    setError("");
    try {
      const saved = await apiRequest("/api/feed-records", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: formData.date,
          pigs: Number(formData.pigs),
          feedPerPig: Number(formData.feedPerPig),
          costPerKg: Number(formData.costPerKg),
        }),
      });
      setRecords((current) => [saved, ...current]);
      setSelectedDate(formData.date);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  };

  const summaryLabels = {
    daily: "Selected day",
    weekly: "Last 7 days",
    monthly: "Last 30 days",
    yearly: "Last 365 days",
  };

  return (
    <DashboardLayout>
      <section className="page-hero">
        <div>
          <div className="page-badge">FEED MANAGEMENT</div>
          <h2>Feed Cost Calculator</h2>
          <p>Record daily feed use and automatically track herd consumption and feed spending across useful time periods.</p>
        </div>
        <div className="chip-list">
          <span className="chip">{records.length} stored entries</span>
          <span className="chip">Per-pig calculation</span>
          <span className="chip">PHP currency</span>
        </div>
      </section>

      {error && <div className="alert alert-warning" role="alert">{error}</div>}

      <div className="feed-calculator-grid">
        <div className="panel-card">
          <div className="card-body">
            <div className="feed-panel-heading">
              <div>
                <h5 className="fw-bold mb-1">Add daily feed record</h5>
                <p className="text-muted mb-0">Enter values from your feeding log. Entries are kept only for this session.</p>
              </div>
              <FaCalculator className="feed-panel-icon" />
            </div>

            <form onSubmit={addRecord} className="row g-3 mt-1">
              <div className="col-sm-6">
                <label className="form-label">Record date</label>
                <input type="date" name="date" className="form-control" value={formData.date} onChange={handleChange} />
              </div>
              <div className="col-sm-6">
                <label className="form-label">Number of pigs</label>
                <input type="number" min="1" step="1" name="pigs" className="form-control" value={formData.pigs} onChange={handleChange} />
              </div>
              <div className="col-sm-6">
                <label className="form-label">Feed per pig / day (kg)</label>
                <input type="number" min="0.01" step="0.01" name="feedPerPig" className="form-control" value={formData.feedPerPig} onChange={handleChange} />
              </div>
              <div className="col-sm-6">
                <label className="form-label">Feed cost per kg (₱)</label>
                <input type="number" min="0.01" step="0.01" name="costPerKg" className="form-control" value={formData.costPerKg} onChange={handleChange} />
              </div>
              <div className="col-12">
                <div className="feed-calculation-preview">
                  <span>Daily total</span>
                  <strong>{currentDaily.totalKg.toFixed(2)} kg / {formatMoney(currentDaily.totalCost)}</strong>
                </div>
              </div>
              <div className="col-12 d-flex justify-content-end">
                <button type="submit" className="btn btn-success" disabled={saving}>{saving ? "Saving..." : "Save daily record"}</button>
              </div>
            </form>
          </div>
        </div>

        <div className="panel-card feed-how-card">
          <div className="card-body">
            <div className="page-badge mb-3">CALCULATION</div>
            <h5 className="fw-bold mb-3">How totals are calculated</h5>
            <div className="feed-formula"><span>Feed consumed</span><b>pigs × kg per pig</b></div>
            <div className="feed-formula"><span>Feed cost</span><b>total kg × price per kg</b></div>
            <p className="text-muted small mt-3 mb-0">Choose a date below to review saved records for the day, the last 7 days, the last 30 days, or the last 365 days.</p>
          </div>
        </div>
      </div>

      <div className="panel-card mt-4">
        <div className="card-body">
          <div className="d-flex flex-wrap justify-content-between align-items-center gap-3 mb-3">
            <div>
              <h5 className="fw-bold mb-1">Consumption and spending summary</h5>
              <p className="text-muted mb-0">Totals are based on saved daily feed records.</p>
            </div>
            <div>
              <label className="form-label small mb-1">Summary date</label>
              <input type="date" className="form-control" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} />
            </div>
          </div>
          <div className="feed-summary-grid">
            {summaries.map((summary) => (
              <div className={`feed-summary-card feed-summary-${summary.key}`} key={summary.key}>
                <div className="feed-summary-icon">{summary.key === "daily" ? <FaWeightHanging /> : <FaCoins />}</div>
                <span>{summaryLabels[summary.key]}</span>
                <strong>{summary.feedKg.toFixed(2)} kg</strong>
                <b>{formatMoney(summary.cost)}</b>
              </div>
            ))}
          </div>
        </div>
      </div>

    </DashboardLayout>
  );
}
