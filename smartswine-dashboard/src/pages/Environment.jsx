import { useEffect, useState } from "react";
import DashboardLayout from "../layouts/DashboardLayout";
import EmptyState from "../components/EmptyState";
import { apiRequest } from "../api";

export default function Environment() {
    const [readings, setReadings] = useState([]);
    const [values, setValues] = useState({ ambientTemperature: "", humidity: "", bodyTemperature: "" });
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        let active = true;
        apiRequest("/api/environment")
            .then((storedReadings) => {
                if (active) setReadings(storedReadings);
            })
            .catch((requestError) => {
                if (active) setError(requestError.message);
            });
        return () => {
            active = false;
        };
    }, []);

    const latest = readings[0];

    const submitReading = async (event) => {
        event.preventDefault();
        if (Object.values(values).every((value) => value === "")) {
            setError("Enter at least one reading.");
            return;
        }

        const reading = Object.fromEntries(
            Object.entries(values).map(([key, value]) => [key, value === "" ? null : Number(value)])
        );
        setSaving(true);
        setError("");
        try {
            const saved = await apiRequest("/api/environment", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...reading, source: "manual" }),
            });
            setReadings((current) => [saved, ...current]);
            setValues({ ambientTemperature: "", humidity: "", bodyTemperature: "" });
        } catch (requestError) {
            setError(requestError.message);
        } finally {
            setSaving(false);
        }
    };

    const updateValue = (event) => {
        const { name, value } = event.target;
        setValues((current) => ({ ...current, [name]: value }));
    };

    return (
        <DashboardLayout>
            <section className="page-hero">
                <div>
                    <div className="page-badge">PEN ENVIRONMENT</div>
                    <h2>Pen Environment</h2>
                    <p>Record pen conditions or review readings received from a connected sensor.</p>
                </div>
            </section>

            {error && <div className="alert alert-warning" role="alert">{error}</div>}

            <div className="row g-3 mb-4">
                {[
                    ["Ambient Temperature", latest?.ambientTemperature, "°C"],
                    ["Humidity", latest?.humidity, "%"],
                    ["Pig Body Temperature", latest?.bodyTemperature, "°C"],
                ].map(([label, value, unit]) => (
                    <div className="col-lg-4" key={label}>
                        <div className="stat-card text-center">
                            <div className="text-muted mb-2">{label}</div>
                            <div className="fs-2 fw-bold">{value == null ? "-" : `${value}${unit}`}</div>
                            <small className="text-muted">{latest ? new Date(latest.createdAt).toLocaleString() : "No reading"}</small>
                        </div>
                    </div>
                ))}
            </div>

            <div className="panel-card mb-4">
                <div className="card-body">
                    <h5 className="fw-bold mb-3">Record environment reading</h5>
                    <form className="row g-3 align-items-end" onSubmit={submitReading}>
                        <div className="col-md-3">
                            <label className="form-label">Ambient temperature (°C)</label>
                            <input className="form-control" type="number" step="0.1" name="ambientTemperature" value={values.ambientTemperature} onChange={updateValue} />
                        </div>
                        <div className="col-md-3">
                            <label className="form-label">Humidity (%)</label>
                            <input className="form-control" type="number" min="0" max="100" step="0.1" name="humidity" value={values.humidity} onChange={updateValue} />
                        </div>
                        <div className="col-md-3">
                            <label className="form-label">Pig body temperature (°C)</label>
                            <input className="form-control" type="number" step="0.1" name="bodyTemperature" value={values.bodyTemperature} onChange={updateValue} />
                        </div>
                        <div className="col-md-3">
                            <button type="submit" className="btn btn-success w-100" disabled={saving}>{saving ? "Saving..." : "Save reading"}</button>
                        </div>
                    </form>
                    <p className="small text-muted mt-2 mb-0">Readings are saved in the local farm database.</p>
                </div>
            </div>

            <div className="panel-card">
                <div className="card-body">
                    <h5 className="fw-bold mb-3">Reading history</h5>
                    {readings.length === 0 ? <EmptyState title="No sensor readings" message="No temperature or humidity data has been recorded." /> : (
                        <div className="table-surface">
                            <table className="table table-hover align-middle mb-0">
                                <thead className="table-light"><tr><th>Recorded</th><th>Source</th><th>Ambient °C</th><th>Humidity %</th><th>Body °C</th></tr></thead>
                                <tbody>{readings.map((reading) => <tr key={reading.id}><td>{new Date(reading.createdAt).toLocaleString()}</td><td>{reading.source}</td><td>{reading.ambientTemperature ?? "-"}</td><td>{reading.humidity ?? "-"}</td><td>{reading.bodyTemperature ?? "-"}</td></tr>)}</tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>
        </DashboardLayout>
    );
}