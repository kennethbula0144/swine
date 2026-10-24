import { useEffect, useState } from "react";
import DashboardLayout from "../layouts/DashboardLayout";
import { apiRequest } from "../api";

const AI_API_URL = import.meta.env.VITE_AI_API_URL || "http://127.0.0.1:8000";

export default function Settings() {
  const [datasetFile, setDatasetFile] = useState(null);
  const [calibrationMode, setCalibrationMode] = useState("weight");
  const [calibrationState, setCalibrationState] = useState({ status: "idle", message: "No dataset checked yet." });
  const [trainingState, setTrainingState] = useState({ status: "idle", message: "Training has not started." });
  const [calibrationFile, setCalibrationFile] = useState(null);
  const [weightCalibrationState, setWeightCalibrationState] = useState({ status: "idle", result: null, message: "Upload a separate measured-weight ZIP to calibrate." });
  const [modelStatus, setModelStatus] = useState({ loading: true, detector: false, identity: false, weight: false });
  const [identityDataset, setIdentityDataset] = useState({ loading: true, classes: [], image_count: 0, excluded_directories: [], missing_classes: [] });
  const [identityTraining, setIdentityTraining] = useState({ status: "idle", epoch: 0, epochs: 0, accuracy: 0, loss: 0, message: "Four-pig identity training has not started." });
  const [identityEpochs, setIdentityEpochs] = useState("10");
  const [behaviorDataset, setBehaviorDataset] = useState({ loading: true, classes: [], train_image_count: 0, test_image_count: 0, train_video_count: 0, test_video_count: 0 });
  const [behaviorTraining, setBehaviorTraining] = useState({ status: "idle", epoch: 0, epochs: 0, accuracy: null, loss: null, message: "OPB behavior training has not started." });
  const [behaviorEpochs, setBehaviorEpochs] = useState("5");
  const [estimateFile, setEstimateFile] = useState(null);
  const [debugDetections, setDebugDetections] = useState(false);
  const [measuredWeight, setMeasuredWeight] = useState("");
  const [estimateState, setEstimateState] = useState({ status: "idle", pigs: [], message: "Choose an image to preview the current model." });
  const [systemState, setSystemState] = useState({
    backend: "Checking",
    ai: "Checking",
    camera: "Checking",
  });

  useEffect(() => {
    let active = true;

    Promise.all([
      apiRequest("/api/health").catch(() => ({ integration_loaded: false })),
      apiRequest("/api/camera/status").catch(() => ({ configured: false })),
      fetch(`${AI_API_URL}/api/ai-camera/status`).then((response) => response.ok ? response.json() : Promise.reject(new Error("AI status unavailable"))).catch(() => null),
      fetch(`${AI_API_URL}/api/ai-camera/identity-dataset`).then((response) => response.ok ? response.json() : Promise.reject(new Error("Identity dataset unavailable"))).catch(() => null),
      fetch(`${AI_API_URL}/api/ai-camera/training/identity/status`).then((response) => response.ok ? response.json() : null).catch(() => null),
      fetch(`${AI_API_URL}/api/ai-camera/behavior-dataset`).then((response) => response.ok ? response.json() : null).catch(() => null),
      fetch(`${AI_API_URL}/api/ai-camera/training/behavior/status`).then((response) => response.ok ? response.json() : null).catch(() => null),
    ])
      .then(([health, camera, models, identityData, identityTrainingStatus, behaviorData, behaviorTrainingStatus]) => {
        if (!active) return;
        setModelStatus({
          loading: false,
          detector: Boolean(models?.detector_loaded),
          identity: Boolean(models?.recognition_model_loaded),
          weight: Boolean(models?.weight_model_loaded),
          behavior: Boolean(models?.behavior_model_loaded),
        });
        setSystemState({
          backend: health.integration_loaded ? "Connected" : "Unavailable",
          ai: health.integration_loaded ? "AI ready" : "AI offline",
          camera: camera.configured ? "Camera ready" : "Camera not configured",
        });
        setIdentityDataset({ loading: false, ...(identityData || { classes: [], image_count: 0, excluded_directories: [], missing_classes: [] }) });
        if (identityTrainingStatus) setIdentityTraining(identityTrainingStatus);
        setBehaviorDataset({ loading: false, ...(behaviorData || { classes: [], train_image_count: 0, test_image_count: 0, train_video_count: 0, test_video_count: 0 }) });
        if (behaviorTrainingStatus) setBehaviorTraining(behaviorTrainingStatus);
      })
      .catch(() => {
        if (active) {
          setModelStatus({ loading: false, detector: false, identity: false, weight: false, behavior: false });
          setSystemState({ backend: "Unavailable", ai: "Offline", camera: "Unavailable" });
          setIdentityDataset({ loading: false, classes: [], image_count: 0, excluded_directories: [], missing_classes: [] });
          setBehaviorDataset({ loading: false, classes: [], train_image_count: 0, test_image_count: 0, train_video_count: 0, test_video_count: 0 });
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (identityTraining.status !== "running") return undefined;
    let active = true;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`${AI_API_URL}/api/ai-camera/training/identity/status`);
        const result = await response.json();
        if (!response.ok) throw new Error(result.detail || "Could not read training progress.");
        if (!active) return;
        setIdentityTraining(result);
        if (result.status === "complete" || result.status === "error") {
          window.clearInterval(timer);
          if (result.status === "complete") {
            setModelStatus((current) => ({ ...current, identity: true }));
            const datasetResponse = await fetch(`${AI_API_URL}/api/ai-camera/identity-dataset`);
            if (datasetResponse.ok && active) setIdentityDataset({ loading: false, ...(await datasetResponse.json()) });
          }
        }
      } catch (error) {
        if (active) setIdentityTraining((current) => ({ ...current, status: "error", message: error.message }));
      }
    }, 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [identityTraining.status]);

  useEffect(() => {
    if (behaviorTraining.status !== "running") return undefined;
    let active = true;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`${AI_API_URL}/api/ai-camera/training/behavior/status`);
        const result = await response.json();
        if (!response.ok) throw new Error(result.detail || "Could not read behavior training progress.");
        if (!active) return;
        setBehaviorTraining(result);
        if (result.status === "complete" || result.status === "error") {
          window.clearInterval(timer);
          if (result.status === "complete") setModelStatus((current) => ({ ...current, behavior: true }));
        }
      } catch (error) {
        if (active) setBehaviorTraining((current) => ({ ...current, status: "error", message: error.message }));
      }
    }, 1500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [behaviorTraining.status]);

  const validateDataset = async () => {
    if (!datasetFile) {
      setCalibrationState({ status: "error", message: "Choose a ZIP dataset bundle first." });
      return;
    }

    setCalibrationState({ status: "loading", message: "Checking dataset structure..." });
    const formData = new FormData();
    formData.append("dataset", datasetFile);
    formData.append("calibration_mode", calibrationMode);

    try {
      const response = await fetch(`${AI_API_URL}/api/ai-camera/calibration/validate`, {
        method: "POST",
        body: formData,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || "Dataset validation failed.");
      setCalibrationState({
        status: result.status,
        message: result.calibration_mode === "weight"
          ? `${result.message} Found ${result.labeled_image_count} weight-labeled images across ${result.weight_group_count} weight groups.`
          : `${result.message} ${result.image_count} images, ${result.label_count} label files.`,
      });
    } catch (error) {
      setCalibrationState({ status: "error", message: `${error.message} Make sure FastAPI is running.` });
    }
  };

  const trainWeightModel = async () => {
    if (!datasetFile || calibrationMode !== "weight") return;
    if (!window.confirm("This will replace the active weight model with a model trained from this ZIP. Continue?")) return;

    setTrainingState({ status: "loading", message: "Training and activating the model..." });
    const formData = new FormData();
    formData.append("dataset", datasetFile);
    try {
      const response = await fetch(`${AI_API_URL}/api/ai-camera/training/weight`, { method: "POST", body: formData });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || "Weight model training failed.");
      setTrainingState({
        status: "ready",
        message: `${result.message} Trained with ${result.imageCount} images across ${result.weightGroupCount} measured-weight groups.`,
      });
      setModelStatus((current) => ({ ...current, weight: true }));
      setWeightCalibrationState({ status: "idle", result: null, message: "Upload a separate measured-weight ZIP to calibrate the new model." });
    } catch (error) {
      setTrainingState({ status: "error", message: `${error.message} Make sure FastAPI is running.` });
    }
  };

  const trainIdentityModel = async () => {
    if (identityDataset.loading || identityDataset.missing_classes?.length) return;
    if (!window.confirm("Train and activate recognition using only Pig_1, Pig_2, Pig_3, and Pig_4? The active identity model will be replaced.")) return;

    setIdentityTraining({ status: "starting", epoch: 0, epochs: Number(identityEpochs), accuracy: 0, loss: 0, message: "Starting four-pig identity training..." });
    const formData = new FormData();
    formData.append("epochs", identityEpochs);
    formData.append("batch_size", "32");
    try {
      const response = await fetch(`${AI_API_URL}/api/ai-camera/training/identity`, { method: "POST", body: formData });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || "Identity model training failed.");
      setIdentityTraining({ status: "running", epoch: 0, epochs: Number(identityEpochs), accuracy: 0, loss: 0, message: result.message });
    } catch (error) {
      setIdentityTraining({ status: "error", epoch: 0, epochs: 0, accuracy: 0, loss: 0, message: `${error.message} Make sure the HerdPulse FastAPI backend is running.` });
    }
  };

  const trainBehaviorModel = async () => {
    if (behaviorDataset.loading || behaviorDataset.classes.length < 2) return;
    if (!window.confirm("Train and activate pig behavior recognition using the available OPB still images? This adds a separate model and does not replace pig identity or weight models.")) return;

    setBehaviorTraining({ status: "starting", epoch: 0, epochs: Number(behaviorEpochs), accuracy: null, loss: null, message: "Starting OPB behavior training..." });
    const formData = new FormData();
    formData.append("epochs", behaviorEpochs);
    formData.append("batch_size", "32");
    try {
      const response = await fetch(`${AI_API_URL}/api/ai-camera/training/behavior`, { method: "POST", body: formData });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || "OPB behavior training failed.");
      setBehaviorTraining({ status: "running", epoch: 0, epochs: Number(behaviorEpochs), accuracy: null, loss: null, message: result.message });
    } catch (error) {
      setBehaviorTraining({ status: "error", epoch: 0, epochs: 0, accuracy: null, loss: null, message: `${error.message} Make sure the HerdPulse AI backend is running.` });
    }
  };

  const calibrateWeightModel = async () => {
    if (!calibrationFile) {
      setWeightCalibrationState({ status: "error", result: null, message: "Choose a separate calibration ZIP first." });
      return;
    }
    setWeightCalibrationState({ status: "loading", result: null, message: "Evaluating measured weights and fitting calibration..." });
    const formData = new FormData();
    formData.append("dataset", calibrationFile);
    try {
      const response = await fetch(`${AI_API_URL}/api/ai-camera/calibration/weight`, { method: "POST", body: formData });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || "Weight calibration failed.");
      setWeightCalibrationState({ status: "ready", result, message: result.message });
    } catch (error) {
      setWeightCalibrationState({ status: "error", result: null, message: `${error.message} Make sure a weight model is loaded and FastAPI is running.` });
    }
  };

  const estimateWeight = async () => {
    if (!estimateFile) {
      setEstimateState({ status: "error", pigs: [], message: "Choose an image first." });
      return;
    }

    setEstimateState({ status: "loading", pigs: [], message: "Running the current YOLO detector..." });
    const formData = new FormData();
    formData.append("image", estimateFile);
    formData.append("debug", String(debugDetections));

    try {
      const response = await fetch(`${AI_API_URL}/api/ai-camera/process-image`, { method: "POST", body: formData });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || "The AI backend could not estimate this image.");
      const pigs = result.pigs || [];
      setEstimateState({
        status: "ready",
        pigs,
        detections: result.detections || [],
        inferenceTimeMs: result.inference_time_ms,
        debugImage: result.debug_image,
        message: pigs.length ? `Detected ${pigs.length} pig${pigs.length === 1 ? "" : "s"} with the current YOLO detector.` : "No pigs were detected in this image.",
      });
    } catch (error) {
      setEstimateState({ status: "error", pigs: [], message: `${error.message} Confirm that the AI backend is running.` });
    }
  };

  const onePigEstimate = estimateState.pigs.length === 1 ? estimateState.pigs[0].estimated_weight_kg : null;
  const comparisonError = onePigEstimate != null && measuredWeight !== ""
    ? Math.abs(onePigEstimate - Number(measuredWeight))
    : null;

  return (
    <DashboardLayout>
      <section className="page-hero">
        <div>
          <div className="page-badge">MONITORING CONFIGURATION</div>
          <h2>System Settings</h2>
          <p>Validate dataset bundles and monitor whether the backend, AI bundle, and camera services are connected.</p>
        </div>
        <div className="chip-list">
          <span className="chip">Backend: {systemState.backend}</span>
          <span className="chip">AI: {systemState.ai}</span>
          <span className="chip">Camera: {systemState.camera}</span>
        </div>
      </section>

      <section className="panel-card mb-4">
        <div className="card-body">
          <div className="page-badge mb-2">MODEL READINESS</div>
          <h4 className="fw-bold mb-2">Current AI components</h4>
          <div className="row g-3">
            <div className="col-md-4"><div className="stat-card p-3"><strong>Weight estimation</strong><div className="mt-2">{modelStatus.loading ? "Checking..." : modelStatus.weight ? "Model loaded · experimental" : "Model not loaded"}</div></div></div>
            <div className="col-md-4"><div className="stat-card p-3"><strong>Pig identity / pattern</strong><div className="mt-2">{modelStatus.loading ? "Checking..." : modelStatus.identity ? "Recognition model loaded · target validation pending" : "Recognition model not loaded"}</div></div></div>
            <div className="col-md-4"><div className="stat-card p-3"><strong>Behavior recognition</strong><div className="mt-2">{modelStatus.loading ? "Checking..." : modelStatus.behavior ? "OPB model loaded · validation pending" : "OPB model not trained · movement heuristic active"}</div></div></div>
          </div>
          <p className="text-muted small mt-3 mb-0">{modelStatus.identity ? "The active identity model uses Pig_1 through Pig_4. Validate predictions against separate images before relying on recognition." : "The four-pig dataset is connected, but its recognition model is not trained yet. Train it below before testing identity predictions."}</p>
        </div>
      </section>

      <section className="panel-card mb-4">
        <div className="card-body">
          <div className="page-badge mb-2">PIG IDENTITY MODEL</div>
          <h4 className="fw-bold mb-2">Enrolled herd identities</h4>
          <p className="text-muted">Only Pig_1 through Pig_4 are included in this model. Legacy profile folders are excluded from training.</p>
          {identityDataset.loading ? <p>Loading enrolled identities...</p> : (
            <>
              <div className="table-responsive">
                <table className="table align-middle mb-2">
                  <thead><tr><th>Pig ID</th><th>Measured reference (kg)</th><th>Identity images</th></tr></thead>
                  <tbody>{identityDataset.classes.map((pig) => <tr key={pig.pig_id}><td>{pig.pig_id}</td><td>{Number(pig.weight_kg).toFixed(2)}</td><td>{pig.images.toLocaleString()}</td></tr>)}</tbody>
                </table>
              </div>
              <p className="small text-muted">{identityDataset.image_count.toLocaleString()} images across {identityDataset.identity_count || 0} identities. Excluded folders: {identityDataset.excluded_directories?.length ? identityDataset.excluded_directories.join(", ") : "none"}.</p>
              {identityDataset.weight_capture && <p className="small text-muted">Flat capture folder: {identityDataset.weight_capture.frame_count.toLocaleString()} frames at {identityDataset.weight_capture.camera_height_m} m camera height. These frames have no per-pig labels, so they are reserved for validation and are not used as weight targets.</p>}
              {identityDataset.missing_classes?.length > 0 && <div className="calibration-message error">Missing image folders: {identityDataset.missing_classes.join(", ")}.</div>}
            </>
          )}
          <div className="row g-3 align-items-end mt-1">
            <div className="col-sm-4 col-lg-2">
              <label className="form-label" htmlFor="identityEpochs">Training epochs</label>
              <input id="identityEpochs" type="number" min="1" max="100" className="form-control" value={identityEpochs} onChange={(event) => setIdentityEpochs(event.target.value)} />
            </div>
            <div className="col-sm-8 col-lg-4">
              <button type="button" className="btn btn-success w-100" onClick={trainIdentityModel} disabled={identityDataset.loading || identityDataset.missing_classes?.length > 0 || identityTraining.status === "starting" || identityTraining.status === "running"}>
                {identityTraining.status === "starting" || identityTraining.status === "running" ? `Training ${identityTraining.epoch}/${identityTraining.epochs}...` : "Train four-pig identity model"}
              </button>
            </div>
          </div>
          <div className={`calibration-message ${identityTraining.status === "complete" ? "ready" : identityTraining.status} mt-3`}>{identityTraining.message}</div>
          {identityTraining.epoch > 0 && <p className="small text-muted mb-0">Training-set accuracy: {identityTraining.accuracy.toFixed(1)}% · Loss: {identityTraining.loss.toFixed(3)}</p>}
        </div>
      </section>

      <section className="panel-card mb-4">
        <div className="card-body">
          <div className="page-badge mb-2">OPB BEHAVIOR MODEL</div>
          <h4 className="fw-bold mb-2">Pig behavior recognition</h4>
          <p className="text-muted">Train a separate classifier from the available still images in the 100K-OPB dataset. It does not change the four-pig identity or weight models.</p>
          {behaviorDataset.loading ? <p>Reading OPB labels and local media...</p> : (
            <>
              <p className="small text-muted mb-2">
                {behaviorDataset.train_image_count.toLocaleString()} training images · {behaviorDataset.test_image_count.toLocaleString()} held-out test images · {behaviorDataset.classes.length} behavior classes
              </p>
              <div className="d-flex flex-wrap gap-2 mb-3">
                {behaviorDataset.classes.map((item) => (
                  <span className="badge text-bg-light border" key={item.name}>{item.name} · {item.train_images.toLocaleString()}</span>
                ))}
              </div>
              <p className="small text-muted">{(behaviorDataset.train_video_count + behaviorDataset.test_video_count).toLocaleString()} video clips are present in the metadata but are not used by this still-image classifier. Video-based actions such as fighting need a temporal model for stronger recognition.</p>
            </>
          )}
          <div className="row g-3 align-items-end">
            <div className="col-sm-4 col-lg-2">
              <label className="form-label" htmlFor="behaviorEpochs">Training epochs</label>
              <input id="behaviorEpochs" type="number" min="1" max="100" className="form-control" value={behaviorEpochs} onChange={(event) => setBehaviorEpochs(event.target.value)} />
            </div>
            <div className="col-sm-8 col-lg-4">
              <button type="button" className="btn btn-success w-100" onClick={trainBehaviorModel} disabled={behaviorDataset.loading || behaviorDataset.classes.length < 2 || behaviorTraining.status === "starting" || behaviorTraining.status === "running"}>
                {behaviorTraining.status === "starting" || behaviorTraining.status === "running" ? `Training ${behaviorTraining.epoch}/${behaviorTraining.epochs}...` : "Train OPB behavior model"}
              </button>
            </div>
          </div>
          <div className={`calibration-message ${behaviorTraining.status === "complete" ? "ready" : behaviorTraining.status} mt-3`}>{behaviorTraining.message}</div>
          {typeof behaviorTraining.accuracy === "number" && <p className="small text-muted mb-0">Held-out OPB test accuracy: {behaviorTraining.accuracy.toFixed(1)}% · Training loss: {behaviorTraining.loss?.toFixed(3) ?? "unavailable"}</p>}
        </div>
      </section>

      <div className="panel-card calibration-panel mb-4">
        <div className="card-body">
          <div className="d-flex flex-wrap justify-content-between align-items-start gap-3 mb-3">
            <div>
              <div className="page-badge mb-2">WEIGHT MODEL WORKFLOW</div>
              <h4 className="fw-bold mb-1">Prepare, train, calibrate</h4>
              <p className="text-muted mb-0">Train with measured-weight image folders, calibrate against a separate labeled set, then preview estimates using the active model.</p>
            </div>
            <span className={`calibration-status ${calibrationState.status}`}>{calibrationState.status === "idle" ? "Waiting" : calibrationState.status}</span>
          </div>
          <div className="row g-3 align-items-end">
            <div className="col-lg-6">
                <label className="form-label">Dataset ZIP</label>
              <input type="file" accept=".zip,application/zip" className="form-control" onChange={(event) => setDatasetFile(event.target.files?.[0] || null)} />
              <div className="small text-muted mt-2">PNG images belong in folders named with measured weight in kg, such as 101.74_127. At least 5 images across 2 weight groups are required.</div>
            </div>
            <div className="col-sm-5 col-lg-3">
                <label className="form-label">Dataset type</label>
              <select className="form-select" value={calibrationMode} onChange={(event) => setCalibrationMode(event.target.value)}>
                <option value="weight">Weight estimation</option>
                <option value="detector">Pig detector</option>
              </select>
            </div>
            <div className="col-sm-7 col-lg-3">
              <button type="button" className="btn btn-success w-100" onClick={validateDataset} disabled={calibrationState.status === "loading"}>
                {calibrationState.status === "loading" ? "Checking..." : "Check dataset"}
              </button>
            </div>
          </div>
          <div className={`calibration-message ${calibrationState.status} mt-3`}>{calibrationState.message}</div>
          <div className="d-flex flex-wrap align-items-center gap-2 mt-3">
            <button type="button" className="btn btn-success" onClick={trainWeightModel} disabled={!datasetFile || calibrationMode !== "weight" || trainingState.status === "loading"}>
              {trainingState.status === "loading" ? "Training..." : "Train and activate model"}
            </button>
            <span className="small text-muted">Training replaces the active model and resets its previous calibration.</span>
          </div>
          <div className={`calibration-message ${trainingState.status} mt-3`}>{trainingState.message}</div>
          <div className="row g-3 align-items-end mt-2">
            <div className="col-lg-8">
              <label className="form-label">Separate calibration ZIP</label>
              <input type="file" accept=".zip,application/zip" className="form-control" onChange={(event) => setCalibrationFile(event.target.files?.[0] || null)} />
              <div className="small text-muted mt-2">Use measured-weight PNG folders in the same format. Prefer images not used for training; reusing training images makes the reported errors optimistic.</div>
            </div>
            <div className="col-lg-4">
              <button type="button" className="btn btn-outline-success w-100" onClick={calibrateWeightModel} disabled={!calibrationFile || !modelStatus.weight || weightCalibrationState.status === "loading"}>
                {weightCalibrationState.status === "loading" ? "Calibrating..." : "Calibrate active model"}
              </button>
            </div>
          </div>
          <div className={`calibration-message ${weightCalibrationState.status} mt-3`}>{weightCalibrationState.message}</div>
          {weightCalibrationState.result && <div className="table-responsive mt-3"><table className="table align-middle mb-0"><thead><tr><th>Metric</th><th>Before calibration</th><th>After calibration</th></tr></thead><tbody><tr><th>Mean absolute error</th><td>{weightCalibrationState.result.rawMetrics.maeKg.toFixed(2)} kg</td><td>{weightCalibrationState.result.calibratedMetrics.maeKg.toFixed(2)} kg</td></tr><tr><th>Root mean square error</th><td>{weightCalibrationState.result.rawMetrics.rmseKg.toFixed(2)} kg</td><td>{weightCalibrationState.result.calibratedMetrics.rmseKg.toFixed(2)} kg</td></tr><tr><th>Calibration samples</th><td colSpan="2">{weightCalibrationState.result.calibratedMetrics.sampleCount}</td></tr></tbody></table></div>}
        </div>
      </div>

      <div className="panel-card mb-4">
        <div className="card-body">
          <div className="page-badge mb-2">ESTIMATE PREVIEW</div>
          <h4 className="fw-bold mb-1">Try the current YOLO detector</h4>
          <p className="text-muted">Run the current YOLO detector on one image and inspect its original-image bounding boxes. This does not create a saved farm observation.</p>
          <div className="row g-3 align-items-end">
            <div className="col-lg-6">
              <label className="form-label">Pig image</label>
              <input type="file" accept="image/*" className="form-control" onChange={(event) => setEstimateFile(event.target.files?.[0] || null)} />
            </div>
            <div className="col-sm-6 col-lg-3">
              <label className="form-label">Measured weight (kg), optional</label>
              <input type="number" min="0" step="0.1" className="form-control" value={measuredWeight} onChange={(event) => setMeasuredWeight(event.target.value)} />
            </div>
            <div className="col-sm-6 col-lg-3">
              <button type="button" className="btn btn-success w-100" onClick={estimateWeight} disabled={estimateState.status === "loading" || !modelStatus.detector}>
                {estimateState.status === "loading" ? "Detecting..." : "Detect pigs"}
              </button>
            </div>
          </div>
          <div className="form-check mt-3">
            <input id="debugDetections" className="form-check-input" type="checkbox" checked={debugDetections} onChange={(event) => setDebugDetections(event.target.checked)} />
            <label className="form-check-label" htmlFor="debugDetections">Save and preview annotated detections</label>
          </div>
          {!modelStatus.loading && !modelStatus.detector && <div className="small text-muted mt-2">YOLO detection is unavailable because detector weights are not loaded.</div>}
          <div className={`calibration-message ${estimateState.status} mt-3`}>{estimateState.message}</div>
          {estimateState.inferenceTimeMs != null && <p className="small text-muted mt-2 mb-0">Inference: {estimateState.inferenceTimeMs.toFixed(2)} ms · {estimateState.detections?.length || 0} detections</p>}
          {estimateState.debugImage && <img className="img-fluid rounded mt-3" src={`${AI_API_URL}/api/ai-camera/debug-image/${encodeURIComponent(estimateState.debugImage)}`} alt="YOLO detections annotated with class, confidence, and bounding-box coordinates" />}
          {estimateState.pigs.length > 0 && <div className="table-responsive mt-3"><table className="table align-middle mb-0"><thead><tr><th>Class / identity</th><th>Detection confidence</th><th>Bounding box (original pixels)</th><th>Experimental weight estimate</th></tr></thead><tbody>{estimateState.pigs.map((pig, index) => <tr key={`${pig.pig_id}-${index}`}><td>{pig.detection?.class_name || pig.pig_id || `Detection ${index + 1}`}</td><td>{pig.box?.confidence == null ? "-" : `${pig.box.confidence}%`}</td><td>{pig.detection?.bbox ? ["x1", "y1", "x2", "y2"].map((coordinate) => Number(pig.detection.bbox[coordinate]).toFixed(1)).join(", ") : "-"}</td><td>{pig.estimated_weight_kg == null ? "Unavailable" : `${pig.estimated_weight_kg} kg`}</td></tr>)}</tbody></table></div>}
          {comparisonError != null && <div className="small mt-3">Absolute difference for the single detected pig: <strong>{comparisonError.toFixed(2)} kg</strong>. This is a one-image comparison, not a model accuracy score.</div>}
          {estimateState.pigs.length > 1 && measuredWeight !== "" && <div className="small text-muted mt-2">For a meaningful comparison, use an image with one pig or leave measured weight blank.</div>}
        </div>
      </div>

      <div className="panel-card">
        <div className="card-body">
          <h4 className="fw-bold mb-2">Connection status</h4>
          <p className="text-muted mb-0">Backend status is live. Missing items are shown here when AI model bundles, camera streams, or data sources are not connected.</p>
        </div>
      </div>
    </DashboardLayout>
  );
}