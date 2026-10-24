import { useEffect, useState } from "react";
import DashboardLayout from "../layouts/DashboardLayout";
import EmptyState from "../components/EmptyState";
import { apiRequest, API_URL } from "../api";

const initialFormState = {
  id: "",
  tagId: "",
  modelIdentity: "",
  stage: "Unassigned",
  daysInPen: "",
  weight: "",
  temp: "",
  behavior: "",
  healthIndicator: "",
  status: "Unreviewed",
};

function PigProfileImage({ pigId, modelIdentity, tagId, size = "small", imageRevision = 0 }) {
  const [imageUnavailable, setImageUnavailable] = useState(false);
  const imageUrl = pigId
    ? `${API_URL}/api/pigs/${encodeURIComponent(pigId)}/image?v=${imageRevision}`
    : null;

  useEffect(() => setImageUnavailable(false), [imageRevision, pigId]);

  return (
    <div className={`pig-profile-image ${size}`} aria-label={`Pig ${tagId || "unassigned"} profile image`}>
      {imageUrl && !imageUnavailable
        ? <img src={imageUrl} alt={`Dataset reference for pig ${tagId || "unassigned"}`} onError={() => setImageUnavailable(true)} />
        : <span>{tagId || "?"}</span>}
    </div>
  );
}

export default function PigRecords() {
  const [pigs, setPigs] = useState([]);
  const [observations, setObservations] = useState([]);
  const [temperatureReadings, setTemperatureReadings] = useState([]);
  const [identityDataset, setIdentityDataset] = useState({ loading: true, classes: [], image_count: 0, excluded_directories: [] });
  const [identityLoadError, setIdentityLoadError] = useState("");
  const [pigImageRevision, setPigImageRevision] = useState({});
  const [pigImageStatus, setPigImageStatus] = useState({});
  const [loadError, setLoadError] = useState("");
  const [formError, setFormError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [filter, setFilter] = useState("All");
  const [selectedPig, setSelectedPig] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editPig, setEditPig] = useState(null);
  const [formData, setFormData] = useState(initialFormState);

  useEffect(() => {
    let active = true;
    Promise.all([
      apiRequest("/api/pigs?limit=200"),
      apiRequest("/api/observations?limit=200"),
      apiRequest("/api/pig-temperatures?limit=500"),
    ])
      .then(([records, recordedObservations, recordedTemperatures]) => {
        if (!active) return;
        setPigs(records);
        setObservations(recordedObservations);
        setTemperatureReadings(recordedTemperatures);
      })
      .catch((error) => {
        if (active) setLoadError(error.message);
      });
    apiRequest("/api/ai-camera/identity-dataset")
      .then((dataset) => {
        if (active) setIdentityDataset({ loading: false, ...dataset });
      })
      .catch((error) => {
        if (active) {
          setIdentityDataset({ loading: false, classes: [], image_count: 0, excluded_directories: [] });
          setIdentityLoadError(error.message);
        }
      });
    const temperatureTimer = window.setInterval(() => {
      apiRequest("/api/pig-temperatures?limit=500")
        .then((recordedTemperatures) => {
          if (active) setTemperatureReadings(recordedTemperatures);
        })
        .catch(() => undefined);
    }, 10000);
    return () => {
      active = false;
      window.clearInterval(temperatureTimer);
    };
  }, []);

  const latestObservationByPigId = observations.reduce((accumulator, observation) => {
    const pigKey = observation.pigId;
    if (!pigKey) return accumulator;
    const previous = accumulator.get(pigKey);
    if (!previous || new Date(observation.createdAt) > new Date(previous.createdAt)) {
      accumulator.set(pigKey, observation);
    }
    return accumulator;
  }, new Map());

  const latestTemperatureByPigId = temperatureReadings.reduce((accumulator, reading) => {
    const previous = accumulator.get(reading.pigId);
    if (!previous || new Date(reading.createdAt) > new Date(previous.createdAt)) {
      accumulator.set(reading.pigId, reading);
    }
    return accumulator;
  }, new Map());

  const enrichedPigs = pigs.map((pig) => {
    const latestObservation = latestObservationByPigId.get(pig.tagId || pig.id) || latestObservationByPigId.get(pig.id);
    const latestTemperature = latestTemperatureByPigId.get(pig.id);
    return {
      ...pig,
      latestObservation,
      latestTemperature,
      lastObservedAt: latestObservation ? latestObservation.createdAt : null,
      displayBehavior: latestObservation?.behaviorIndicator || pig.behavior || "Unknown",
      displayWeight: latestObservation?.estimatedWeightKg ?? pig.weight,
      displayTemperature: latestTemperature?.temperatureC ?? pig.temp,
    };
  });

  const filteredPigs = enrichedPigs.filter((pig) => {
    const matchFilter = filter === "All" ? true : pig.status === filter;
    return matchFilter;
  });

  const openNewPigForm = () => {
    setSelectedPig(null);
    setEditPig(null);
    setFormData(initialFormState);
    setShowForm(true);
  };

  const updatePigPhoto = async (pigId, file) => {
    const formData = new FormData();
    formData.append("image", file);
    setPigImageStatus((current) => ({ ...current, [pigId]: "Uploading profile photo..." }));
    try {
      const response = await fetch(`${API_URL}/api/pigs/${encodeURIComponent(pigId)}/image`, {
        method: "POST",
        body: formData,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || "Profile image upload failed.");
      setPigImageRevision((current) => ({ ...current, [pigId]: Date.now() }));
      setPigImageStatus((current) => ({ ...current, [pigId]: "Profile photo updated." }));
    } catch (error) {
      setPigImageStatus((current) => ({ ...current, [pigId]: error.message }));
    }
  };

  const openEditPigForm = (pig) => {
    setSelectedPig(null);
    setEditPig(pig);
    setFormData({ ...initialFormState, ...pig, tagId: pig.tagId || "", modelIdentity: pig.modelIdentity || "" });
    setShowForm(true);
  };

  const handleFormChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSavePig = async () => {
    if (!formData.stage) return;

    const normalized = {
      ...formData,
      id: editPig?.id || (formData.modelIdentity.trim() ? `pig:${formData.modelIdentity.trim()}` : `pen:${formData.tagId}`),
      tagId: formData.tagId || null,
      modelIdentity: formData.modelIdentity.trim() || null,
      daysInPen: formData.daysInPen === "" ? null : Number(formData.daysInPen),
      weight: formData.weight === "" ? null : Number(formData.weight),
      temp: formData.temp === "" ? null : Number(formData.temp),
    };

    setIsSaving(true);
    setFormError("");
    try {
      const saved = await apiRequest(editPig ? `/api/pigs/${encodeURIComponent(editPig.id)}` : "/api/pigs", {
        method: editPig ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(normalized),
      });

      if (editPig) {
        setPigs((current) => current.map((pig) => (pig.id === editPig.id ? saved : pig)));
        if (selectedPig?.id === editPig.id) setSelectedPig(saved);
      } else {
        setPigs((current) => [saved, ...current]);
      }
      setShowForm(false);
    } catch (error) {
      setFormError(error.message);
    } finally {
      setIsSaving(false);
    }
  };

  const occupiedTags = new Set(
    pigs.filter((pig) => pig.id !== editPig?.id).map((pig) => pig.tagId).filter(Boolean),
  );

  const handleDeletePig = async (id) => {
    try {
      await apiRequest(`/api/pigs/${encodeURIComponent(id)}`, { method: "DELETE" });
      setPigs((current) => current.filter((pig) => pig.id !== id));
      setSelectedPig(null);
      setShowForm(false);
    } catch (error) {
      setFormError(error.message);
    }
  };

  return (
    <DashboardLayout>
      <section className="page-hero">
        <div>
          <div className="page-badge">FARM PIG REGISTRY</div>
          <h2>Enrolled Pig Profiles</h2>
          <p>All saved farm pigs are listed here. Camera recognition is available for identities in the AI dataset.</p>
        </div>
        <div className="chip-list">
          <span className="chip">{pigs.length} pig profiles</span>
        </div>
      </section>

      {identityLoadError && <div className="alert alert-warning" role="alert">Unable to load enrolled identities: {identityLoadError}</div>}
      <section className="panel-card mb-4">
        <div className="card-body">
          <h5 className="fw-bold mb-1">Per-pig temperature sensors</h5>
          <p className="text-muted mb-0">Configure a sensor gateway to POST each sample to <code>/api/pig-temperatures</code> with a pig <code>tagId</code> or <code>pigId</code> and <code>temperatureC</code>. The backend requires <code>X-Sensor-Token</code>; readings and timestamps refresh here automatically.</p>
        </div>
      </section>
      <section className="panel-card mb-4">
        <div className="card-body">
          {identityDataset.loading ? <p className="mb-0">Loading pig profiles...</p> : pigs.length === 0 ? <EmptyState title="No pig profiles available" message="Add a pig profile to include it in the enrolled herd." /> : (
            <>
              <div className="row g-3">
                {pigs.map((profile) => {
                  const aiIdentity = identityDataset.classes.find((identity) => identity.pig_id === profile.modelIdentity);
                  const profileLabel = profile.modelIdentity || profile.tagId || profile.id;
                  const imageInputId = `identity-image-${profile.id}`;
                  return (
                    <div className="col-sm-6 col-xl-3" key={profile.id}>
                      <div className="stat-card h-100 p-3">
                        <div className="d-flex align-items-center gap-3">
                          <PigProfileImage
                            pigId={profile.id}
                            modelIdentity={aiIdentity?.pig_id}
                            tagId={profile.tagId || profileLabel}
                            size="large"
                            imageRevision={pigImageRevision[profile.id] || 0}
                          />
                          <div>
                            <strong>{profileLabel}</strong>
                            <div className="small text-muted mt-1">
                              {aiIdentity
                                ? `${aiIdentity.images.toLocaleString()} training images`
                                : profile.modelIdentity
                                  ? "Not in the current AI recognition model"
                                  : "No AI identity assigned"}
                            </div>
                            <div className="small mt-1">Weight: {profile.weight == null ? "Not entered" : `${profile.weight} kg`}</div>
                            <div className="small mt-1">Temperature: {latestTemperatureByPigId.get(profile.id)?.temperatureC == null ? profile.temp == null ? "No reading" : `${profile.temp}°C · manual` : `${latestTemperatureByPigId.get(profile.id).temperatureC}°C · sensor`}</div>
                            <div className="small text-muted">Pen tag: {profile.tagId || "Not assigned"}</div>
                          </div>
                        </div>
                        <label className="btn btn-sm btn-outline-secondary mt-2" htmlFor={imageInputId}>Change photo</label>
                        <input
                          id={imageInputId}
                          className="visually-hidden"
                          type="file"
                          accept="image/*"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) void updatePigPhoto(profile.id, file);
                            event.target.value = "";
                          }}
                        />
                        {pigImageStatus[profile.id] && <div className="small text-muted mt-1">{pigImageStatus[profile.id]}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="small text-muted mt-3 mb-0">{identityDataset.image_count.toLocaleString()} images across {identityDataset.classes.length} AI identities. Excluded from recognition: {identityDataset.excluded_directories?.length ? identityDataset.excluded_directories.join(", ") : "no other folders"}.</p>
            </>
          )}
        </div>
      </section>

      <details className="mb-4">
        <summary className="fw-semibold">Show stored farm records</summary>
        <div className="mt-3">
          <div className="d-flex justify-content-end mb-3">
            <button type="button" className="btn btn-success" onClick={openNewPigForm}>+ Add Fattening Pig</button>
          </div>

      <div className="row g-3 mb-4">
        <div className="col-md-3">
          <div className="stat-card text-center">
            <h3 className="fw-bold mb-1">{pigs.length}</h3>
            <small className="text-muted">Records in this session</small>
          </div>
        </div>
        <div className="col-md-3">
          <div className="stat-card text-center">
            <h3 className="fw-bold mb-1 text-success">{pigs.filter((p) => p.status === "Healthy").length}</h3>
            <small className="text-muted">No Review Flag</small>
          </div>
        </div>
        <div className="col-md-3">
          <div className="stat-card text-center">
            <h3 className="fw-bold mb-1 text-warning">{pigs.filter((p) => p.status === "Monitor").length}</h3>
            <small className="text-muted">Observe</small>
          </div>
          </div>
        <div className="col-md-3">
          <div className="stat-card text-center">
            <h3 className="fw-bold mb-1 text-danger">{pigs.filter((p) => p.status === "Alert").length}</h3>
            <small className="text-muted">Referral Review</small>
          </div>
        </div>
      </div>

      <div className="panel-card mb-4">
        <div className="card-body d-flex flex-wrap gap-3 justify-content-between">
          <div />
          <select
            className="form-select"
            style={{ maxWidth: "220px" }}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option>All</option>
            <option>Healthy</option>
            <option>Monitor</option>
            <option>Alert</option>
          </select>
        </div>
      </div>

      {loadError && <div className="alert alert-warning" role="alert">Unable to load pig records: {loadError}</div>}

      <div className="panel-card">
        <div className="card-body">
          {filteredPigs.length === 0 ? <EmptyState title="No pig records" message="Add a profile to save it to the local farm database." /> : <div className="table-surface">
            <table className="table table-hover align-middle mb-0">
              <thead className="table-light">
                <tr>
                  <th>Profile</th>
                  <th>Pen Tag</th>
                  <th>AI Class</th>
                  <th>Identity Source</th>
                  <th>Growth Stage</th>
                  <th>Days in Pen</th>
                  <th>Weight</th>
                  <th>Temperature</th>
                  <th>Behavior</th>
                  <th>Observed Health Indicator</th>
                  <th>Interpretation</th>
                </tr>
              </thead>
              <tbody>
                {filteredPigs.map((pig) => (
                  <tr key={pig.id} style={{ cursor: "pointer" }} onClick={() => setSelectedPig(pig)}>
                    <td><PigProfileImage pigId={pig.id} modelIdentity={pig.modelIdentity} tagId={pig.tagId} /></td>
                    <td>{pig.tagId || <span className="text-muted">Unassigned</span>}</td>
                    <td>{pig.modelIdentity || <span className="text-muted">Not mapped</span>}</td>
                    <td>
                      {pig.latestObservation ? (
                        <div>
                          <div className="fw-semibold">Detected</div>
                          <small className="text-muted">{new Date(pig.lastObservedAt).toLocaleString()}</small>
                        </div>
                      ) : (
                        <span className="text-muted">Manual profile</span>
                      )}
                    </td>
                    <td>{pig.stage}</td>
                    <td>{pig.daysInPen ?? "-"}</td>
                    <td>{pig.displayWeight == null ? "-" : `${pig.displayWeight} kg`}</td>
                    <td>
                      {pig.displayTemperature == null ? <span className="text-muted">No reading</span> : (
                        <>
                          {pig.displayTemperature}°C
                          <small className="d-block text-muted">
                            {pig.latestTemperature
                              ? `${pig.latestTemperature.sensorId || "Sensor"} · ${new Date(pig.latestTemperature.createdAt).toLocaleString()}`
                              : "Manual entry"}
                          </small>
                        </>
                      )}
                    </td>
                    <td>{pig.displayBehavior || "Unknown"}</td>
                    <td>{pig.healthIndicator || pig.latestObservation?.behaviorIndicator || "No indicator recorded"}</td>
                    <td>
                      <span
                        className={`badge ${
                          pig.status === "Healthy"
                            ? "bg-success"
                            : pig.status === "Alert"
                            ? "bg-danger"
                            : "bg-warning text-dark"
                        }`}
                      >
                        {pig.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>}
        </div>
      </div>

        </div>
      </details>

      {showForm && (
        <div className="modal-backdrop" onClick={() => setShowForm(false)}>
          <div className="detail-modal" onClick={(e) => e.stopPropagation()}>
            <div className="d-flex justify-content-between align-items-center mb-4">
              <div>
                <h5 className="fw-bold mb-1">{editPig ? "Edit Fattening Pig" : "Add Fattening Pig"}</h5>
                <p className="text-muted mb-0">Assign one pen tag and optionally map the model's predicted class.</p>
              </div>
              <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setShowForm(false)}>
                Close
              </button>
            </div>

            <div className="row g-3">
              <div className="col-md-4">
                <label className="form-label">Pen tag</label>
                <select className="form-select" name="tagId" value={formData.tagId} onChange={handleFormChange} required>
                  <option value="">No pen tag assigned</option>
                  {Array.from({ length: 20 }, (_, index) => String(index + 1).padStart(2, "0")).map((tagId) => (
                    <option key={tagId} value={tagId} disabled={occupiedTags.has(tagId)}>{tagId}</option>
                  ))}
                </select>
              </div>
              <div className="col-md-4">
                <label className="form-label">AI model class</label>
                <input className="form-control" name="modelIdentity" value={formData.modelIdentity} onChange={handleFormChange} placeholder="Example: Pig_1" />
                <small className="text-muted">Use the exact stable class label. Do not map UNKNOWN-# labels; they change by box order.</small>
              </div>
              <div className="col-md-4">
                <label className="form-label">Stage</label>
                <select className="form-select" name="stage" value={formData.stage} onChange={handleFormChange} required>
                  <option>Unassigned</option>
                  <option>Grower</option>
                  <option>Finisher</option>
                </select>
              </div>
              <div className="col-md-4">
                <label className="form-label">Days in Pen</label>
                <input type="number" className="form-control" name="daysInPen" value={formData.daysInPen} onChange={handleFormChange} />
              </div>
              <div className="col-md-4">
                <label className="form-label">Weight (kg)</label>
                <input type="number" className="form-control" name="weight" value={formData.weight} onChange={handleFormChange} />
              </div>
              <div className="col-md-4">
                <label className="form-label">Temperature (°C)</label>
                <input type="number" className="form-control" name="temp" value={formData.temp} onChange={handleFormChange} />
              </div>
              <div className="col-md-4">
                <label className="form-label">Behavior</label>
                <input className="form-control" name="behavior" value={formData.behavior} onChange={handleFormChange} />
              </div>
              <div className="col-md-6">
                <label className="form-label">Observed Health Indicator</label>
                <input className="form-control" name="healthIndicator" value={formData.healthIndicator} onChange={handleFormChange} />
              </div>
              <div className="col-md-6">
                <label className="form-label">Status</label>
                <select className="form-select" name="status" value={formData.status} onChange={handleFormChange}>
                  <option>Unreviewed</option>
                  <option>Healthy</option>
                  <option>Monitor</option>
                  <option>Alert</option>
                </select>
              </div>
            </div>

            {formError && <div className="alert alert-danger mt-3 mb-0" role="alert">{formError}</div>}
            <div className="d-flex justify-content-end gap-2 mt-4">
              {editPig && (
                <button type="button" className="btn btn-outline-danger" onClick={() => handleDeletePig(editPig.id)}>
                  Delete Pig
                </button>
              )}
              <button type="button" className="btn btn-success" onClick={handleSavePig} disabled={isSaving || !formData.stage}>
                {isSaving ? "Saving..." : "Save Pig"}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedPig && (
        <div className="modal-backdrop" onClick={() => setSelectedPig(null)}>
          <div className="detail-modal" onClick={(e) => e.stopPropagation()}>
            <div className="d-flex justify-content-between align-items-start mb-4">
              <div>
                <div className="d-flex align-items-center gap-3">
                  <PigProfileImage pigId={selectedPig.id} modelIdentity={selectedPig.modelIdentity} tagId={selectedPig.tagId} size="large" />
                  <div>
                    <h5 className="fw-bold mb-1">Pen tag {selectedPig.tagId || "Unassigned"}</h5>
                    <p className="text-muted mb-0">AI class {selectedPig.modelIdentity || "not mapped"} • {selectedPig.stage} stage • {selectedPig.status}</p>
                  </div>
                </div>
              </div>
              <div className="d-flex gap-2 flex-wrap">
                <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setSelectedPig(null)}>
                  Close
                </button>
                <button type="button" className="btn btn-sm btn-primary" onClick={() => openEditPigForm(selectedPig)}>
                  Edit
                </button>
              </div>
            </div>

            <div className="row g-3 mb-4">
              <div className="col-md-4">
                <div className="stat-card p-3 text-center">
                  <div className="text-muted mb-2">Current Weight</div>
                  <div className="fs-2 fw-bold">{selectedPig.weight == null ? "-" : `${selectedPig.weight} kg`}</div>
                </div>
              </div>
              <div className="col-md-4">
                <div className="stat-card p-3 text-center">
                  <div className="text-muted mb-2">Temperature</div>
                  <div className="fs-2 fw-bold">{selectedPig.displayTemperature == null ? "-" : `${selectedPig.displayTemperature}°C`}</div>
                  <small className="text-muted">
                    {selectedPig.latestTemperature
                      ? `${selectedPig.latestTemperature.sensorId || "Sensor"} · ${new Date(selectedPig.latestTemperature.createdAt).toLocaleString()}`
                      : selectedPig.temp == null ? "Waiting for sensor" : "Manual entry"}
                  </small>
                </div>
              </div>
              <div className="col-md-4">
                <div className="stat-card p-3 text-center">
                  <div className="text-muted mb-2">Observed behavior</div>
                  <div className="fs-2 fw-bold">{selectedPig.behavior || "Unknown"}</div>
                </div>
              </div>
            </div>

            {temperatureReadings.some((reading) => reading.pigId === selectedPig.id) ? (
              <div className="table-surface">
                <table className="table table-hover align-middle mb-0">
                  <thead><tr><th>Temperature history</th><th>Sensor</th><th>Recorded</th></tr></thead>
                  <tbody>
                    {temperatureReadings.filter((reading) => reading.pigId === selectedPig.id).slice(0, 8).map((reading) => (
                      <tr key={reading.id}>
                        <td>{reading.temperatureC}°C</td>
                        <td>{reading.sensorId || reading.source}</td>
                        <td>{new Date(reading.createdAt).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <EmptyState title="No sensor history yet" message="Temperature readings from a connected pig sensor will appear here." />}
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}