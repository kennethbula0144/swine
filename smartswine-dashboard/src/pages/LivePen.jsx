import { useEffect, useRef, useState } from "react";
import { FaCameraRetro, FaRobot, FaUpload } from "react-icons/fa";
import DashboardLayout from "../layouts/DashboardLayout";
import { apiRequest } from "../api";

const AI_API_URL = import.meta.env.VITE_AI_API_URL || "http://127.0.0.1:8000";

export default function LivePen() {
  const videoRef = useRef(null);
  const cameraImageRef = useRef(null);
  const overlayCanvasRef = useRef(null);
  const autoCameraAttempted = useRef(false);
  const [cameraConnected, setCameraConnected] = useState(false);
  const [cameraError, setCameraError] = useState(false);
  const [videoDevices, setVideoDevices] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [cameraStream, setCameraStream] = useState(null);
  const [cameraSource, setCameraSource] = useState("device");
  const [rtspConnected, setRtspConnected] = useState(false);
  const [rtspConnecting, setRtspConnecting] = useState(false);
  const [rtspIp, setRtspIp] = useState("");
  const [rtspUsername, setRtspUsername] = useState("");
  const [rtspPassword, setRtspPassword] = useState("");
  const [rtspStreamVersion, setRtspStreamVersion] = useState(0);
  const [cameraPermissionError, setCameraPermissionError] = useState("");
  const [aiStatus, setAiStatus] = useState({ loading: true, connected: false, models: [] });
  const [aiResults, setAiResults] = useState([]);
  const [aiPreviewUrl, setAiPreviewUrl] = useState("");
  const [aiPreviewSize, setAiPreviewSize] = useState(null);
  const [temperatureReadings, setTemperatureReadings] = useState([]);
  const [aiProcessing, setAiProcessing] = useState(false);
  const [aiError, setAiError] = useState("");
  const [autoAnalyze, setAutoAnalyze] = useState(true);
  const cameraActive = cameraSource === "network" ? rtspConnected : cameraConnected && Boolean(cameraStream);
  const latestTemperatureByPigId = temperatureReadings.reduce((readingsByPig, reading) => {
    const previous = readingsByPig.get(reading.pigId);
    if (!previous || new Date(reading.createdAt) > new Date(previous.createdAt)) {
      readingsByPig.set(reading.pigId, reading);
    }
    return readingsByPig;
  }, new Map());
  const liveTemperatureSummary = [...new Set(aiResults.map((pig) => {
    const reading = latestTemperatureByPigId.get(pig.farm_pig_id);
    if (!reading) return null;
    const pigLabel = pig.tag_id ? `Pig ${pig.tag_id}` : pig.model_identity || pig.pig_id || "Pig";
    return `${pigLabel}: ${Number(reading.temperatureC).toFixed(1)}°C`;
  }).filter(Boolean))].join(" · ") || "no linked readings";

  useEffect(() => {
    let active = true;
    const refreshTemperatures = () => {
      apiRequest("/api/pig-temperatures?limit=500")
        .then((readings) => {
          if (active) setTemperatureReadings(readings);
        })
        .catch(() => undefined);
    };

    refreshTemperatures();
    const timer = window.setInterval(refreshTemperatures, 10000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let active = true;

    const loadVideoDevices = async () => {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (!active) return;
      const cameras = devices.filter((device) => device.kind === "videoinput");
      setVideoDevices(cameras);
      setSelectedDeviceId((current) => current || cameras[0]?.deviceId || "");
    };

    loadVideoDevices();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (cameraSource !== "device" || !cameraStream || !videoRef.current) return undefined;
    videoRef.current.srcObject = cameraStream;
    videoRef.current.play().catch(() => undefined);
    return () => {
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [cameraStream, cameraSource]);

  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    const media = cameraSource === "network" ? cameraImageRef.current : videoRef.current;
    if (!canvas || !media) return undefined;

    let animationFrame;
    const drawOverlay = () => {
      const width = media.videoWidth || media.naturalWidth || 640;
      const height = media.videoHeight || media.naturalHeight || 360;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      const context = canvas.getContext("2d");
      context.clearRect(0, 0, width, height);
      const occupiedLabels = [];
      const sortedResults = [...aiResults].sort((left, right) => (left.box?.y1 || 0) - (right.box?.y1 || 0));
      sortedResults.forEach((pig) => {
        const { x1, y1, x2, y2 } = pig.box || {};
        if ([x1, y1, x2, y2].some((value) => typeof value !== "number")) return;
        context.strokeStyle = "#ffcf4a";
        context.lineWidth = Math.max(3, width / 320);
        context.strokeRect(x1, y1, x2 - x1, y2 - y1);
        const fontSize = Math.max(13, Math.min(18, width / 48));
        const lineHeight = fontSize + 5;
        context.font = `700 ${fontSize}px sans-serif`;
        const weightLabel = pig.estimated_weight_kg == null
          ? "Weight: unavailable"
          : `${pig.weight_source === "registered_measurement" ? "Registered" : "Estimated"}: ${pig.estimated_weight_kg} kg`;
        const identityLabel = pig.identity_status === "duplicate-prediction"
          ? "Identity conflict: review"
          : `${pig.tag_id || "Unassigned"} · ${pig.model_identity || pig.pig_id || "Unknown"}`;
        const sensorTemperature = latestTemperatureByPigId.get(pig.farm_pig_id);
        const temperatureLabel = sensorTemperature
          ? `Temperature: ${Number(sensorTemperature.temperatureC).toFixed(1)}°C`
          : "Temperature: no sensor reading";
        const behaviorConfidence = pig.behavior_confidence == null ? "" : ` · ${pig.behavior_confidence}%`;
        const behaviorSource = pig.behavior_source?.includes("OPB") ? "OPB model" : "Motion heuristic";
        const lines = [
          identityLabel,
          temperatureLabel,
          `Behavior: ${pig.behavior_indicator || "Unavailable"}${behaviorConfidence}`,
          `${weightLabel} · ID ${pig.recognition_confidence}% · ${behaviorSource}`,
        ];
        const maxLabelWidth = Math.max(120, Math.min(width - 8, width * 0.68));
        const maxTextWidth = maxLabelWidth - 14;
        const fittedLines = lines.map((line) => {
          if (context.measureText(line).width <= maxTextWidth) return line;
          let shortened = line;
          while (shortened.length > 4 && context.measureText(`${shortened.slice(0, -1)}...`).width > maxTextWidth) {
            shortened = shortened.slice(0, -1);
          }
          return `${shortened.slice(0, -1)}...`;
        });
        const labelWidth = Math.min(maxLabelWidth, Math.max(...fittedLines.map((line) => context.measureText(line).width)) + 14);
        const labelHeight = lineHeight * fittedLines.length + 8;
        const clampX = (value) => Math.max(0, Math.min(width - labelWidth, value));
        const clampY = (value) => Math.max(0, Math.min(height - labelHeight, value));
        const preferredY = y1 - labelHeight >= 0 ? y1 - labelHeight : y2 + 4;
        const candidateXs = [...new Set([clampX(x1), clampX(x2 - labelWidth), clampX(x1 - labelWidth - 4), 0, width - labelWidth])];
        const candidateYs = [clampY(preferredY)];
        for (let offset = labelHeight + 4; offset < height; offset += labelHeight + 4) {
          candidateYs.push(clampY(preferredY - offset), clampY(preferredY + offset));
        }
        let labelPosition = null;
        for (const candidateY of [...new Set(candidateYs)]) {
          for (const candidateX of candidateXs) {
            const overlaps = occupiedLabels.some((label) => (
              candidateX < label.x + label.width + 4
              && candidateX + labelWidth + 4 > label.x
              && candidateY < label.y + label.height + 4
              && candidateY + labelHeight + 4 > label.y
            ));
            if (!overlaps) {
              labelPosition = { x: candidateX, y: candidateY };
              break;
            }
          }
          if (labelPosition) break;
        }
        labelPosition ||= { x: clampX(x1), y: clampY(preferredY) };
        occupiedLabels.push({ ...labelPosition, width: labelWidth, height: labelHeight });
        context.fillStyle = "#ffcf4a";
        context.fillRect(labelPosition.x, labelPosition.y, labelWidth, labelHeight);
        context.fillStyle = "#17232b";
        fittedLines.forEach((line, lineIndex) => {
          const baseline = labelPosition.y + 4 + fontSize + lineIndex * lineHeight;
          context.fillText(line, labelPosition.x + 7, baseline);
        });
      });
      animationFrame = requestAnimationFrame(drawOverlay);
    };

    drawOverlay();
    return () => cancelAnimationFrame(animationFrame);
  }, [aiResults, cameraStream, cameraSource, latestTemperatureByPigId, rtspConnected]);

  useEffect(() => () => {
    cameraStream?.getTracks().forEach((track) => track.stop());
  }, [cameraStream]);

  useEffect(() => {
    const loadAiStatus = async () => {
      try {
        const [healthResponse, statusResponse] = await Promise.all([
          fetch(`${AI_API_URL}/api/health`),
          fetch(`${AI_API_URL}/api/ai-camera/status`),
        ]);
        if (!healthResponse.ok || !statusResponse.ok) throw new Error("AI backend is unavailable");
        const health = await healthResponse.json();
        const status = await statusResponse.json();
        setAiStatus({
          loading: false,
          connected: health.integration_loaded,
          models: [
            status.recognition_model_loaded ? "Identity" : null,
            status.weight_model_loaded ? "Weight" : null,
            status.detector_loaded ? "Detector" : null,
            status.behavior_model_loaded ? "OPB behavior" : null,
          ].filter(Boolean),
        });
      } catch (error) {
        setAiStatus({ loading: false, connected: false, models: [] });
      }
    };

    loadAiStatus();
  }, []);

  useEffect(() => () => {
    if (aiPreviewUrl) URL.revokeObjectURL(aiPreviewUrl);
  }, [aiPreviewUrl]);

  const sendImageToAi = async (file, source = "upload") => {
    setAiProcessing(true);
    setAiError("");
    setAiResults([]);
    setAiPreviewUrl(source === "upload" ? URL.createObjectURL(file) : "");
    setAiPreviewSize(null);
    const formData = new FormData();
    formData.append("image", file);
    formData.append("source", source);

    try {
      const response = await fetch(`${AI_API_URL}/api/observations/analyze-image`, {
        method: "POST",
        body: formData,
      });
      if (!response.ok) throw new Error("The AI backend could not process this image.");
      const result = await response.json();
      setAiResults(result.pigs || []);
    } catch (error) {
      setAiError(error.message || "Unable to connect to the AI backend.");
    } finally {
      setAiProcessing(false);
    }
  };

  const processAiImage = async (event) => {
    const file = event.target.files?.[0];
    if (file) await sendImageToAi(file);
    event.target.value = "";
  };

  const analyzeCurrentFrame = async () => {
    const media = cameraSource === "network" ? cameraImageRef.current : videoRef.current;
    const width = media?.videoWidth || media?.naturalWidth;
    const height = media?.videoHeight || media?.naturalHeight;
    if (!media || !width || !height || aiProcessing) return;

    try {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Unable to prepare a camera frame for analysis.");
      context.drawImage(media, 0, 0, width, height);
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (frame) => frame
            ? resolve(frame)
            : reject(new Error("Unable to capture a camera frame. Check the camera stream permissions.")),
          "image/jpeg",
          0.85,
        );
      });
      await sendImageToAi(new File([blob], "live-camera-frame.jpg", { type: "image/jpeg" }), "camera");
    } catch (error) {
      setAiError(error.message || "Unable to capture the current camera frame.");
    }
  };

  useEffect(() => {
    if (!autoAnalyze || !cameraActive || !aiStatus.connected) return undefined;
    const timer = setInterval(analyzeCurrentFrame, 5000);
    return () => clearInterval(timer);
  }, [autoAnalyze, cameraActive, aiStatus.connected, aiProcessing]);

  const connectDeviceCamera = async (preferredDeviceId = selectedDeviceId) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraPermissionError("Browser camera access is not available here. Use localhost or HTTPS.");
      return;
    }

    try {
      cameraStream?.getTracks().forEach((track) => track.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        video: preferredDeviceId ? { deviceId: { exact: preferredDeviceId } } : true,
        audio: false,
      });
      setCameraStream(stream);
      setSelectedDeviceId(preferredDeviceId || "");
      localStorage.setItem("smart-swine-camera-device", preferredDeviceId || "default");
      localStorage.setItem("smart-swine-camera-autostart", "true");
      setCameraPermissionError("");
      setCameraError(false);
      setCameraConnected(true);

      const devices = await navigator.mediaDevices.enumerateDevices();
      setVideoDevices(devices.filter((device) => device.kind === "videoinput"));
    } catch (error) {
      setCameraPermissionError(error.name === "NotAllowedError" ? "Camera permission was blocked. Allow camera access and try again." : "Unable to connect to this camera.");
      setCameraConnected(false);
    }
  };

  const changeCameraSource = (source) => {
    if (source === cameraSource) return;
    cameraStream?.getTracks().forEach((track) => track.stop());
    setCameraStream(null);
    setCameraConnected(false);
    if (rtspConnected) {
      fetch(`${AI_API_URL}/api/camera/disconnect`, { method: "POST" }).catch(() => undefined);
    }
    setRtspConnected(false);
    setCameraSource(source);
    setCameraPermissionError("");
    setAiResults([]);
  };

  const connectNetworkCamera = async (event) => {
    event.preventDefault();
    setRtspConnecting(true);
    setCameraPermissionError("");
    try {
      const response = await fetch(`${AI_API_URL}/api/camera/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip: rtspIp, username: rtspUsername, password: rtspPassword }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || "Unable to connect to the camera.");
      setRtspConnected(true);
      setRtspStreamVersion(Date.now());
      setRtspPassword("");
      setCameraError(false);
    } catch (error) {
      setRtspConnected(false);
      setCameraPermissionError(error.message || "Unable to connect to the camera.");
    } finally {
      setRtspConnecting(false);
    }
  };

  const disconnectNetworkCamera = async () => {
    try {
      await fetch(`${AI_API_URL}/api/camera/disconnect`, { method: "POST" });
    } finally {
      setRtspConnected(false);
      setAiResults([]);
    }
  };

  useEffect(() => {
    if (cameraSource !== "device" || !videoDevices.length || cameraConnected || autoCameraAttempted.current) return;
    autoCameraAttempted.current = true;
    const savedDeviceId = localStorage.getItem("smart-swine-camera-device");
    const savedDeviceAvailable = videoDevices.some((device) => device.deviceId === savedDeviceId);
    const preferredDeviceId = savedDeviceAvailable
      ? savedDeviceId
      : selectedDeviceId || videoDevices[0].deviceId;
    connectDeviceCamera(preferredDeviceId);
  }, [videoDevices, cameraConnected, cameraSource]);

  return (
    <DashboardLayout>
      <section className="page-hero">
        <div>
            <div className="page-badge">CONTINUOUS PEN TELEMETRY</div>
            <h2>Live Pen View</h2>
            <p>Connect a camera to run real pig detection, identity, behavior, and weight analysis.</p>
        </div>
        <div className="chip-list">
            <span className="chip">{aiStatus.loading ? "Checking AI backend" : aiStatus.connected ? "AI backend connected" : "AI backend unavailable"}</span>
        </div>
      </section>

      <div className="panel-card camera-panel mb-4">
        <div className="card-body">
          <div className="d-flex flex-wrap justify-content-between align-items-center gap-3 mb-3">
            <div>
              <div className="page-badge mb-2">LIVE PEN CAMERA</div>
              <h5 className="fw-bold mb-1">Camera feed</h5>
              <p className="text-muted mb-0">Connect the pen camera here to view the monitored fattening pigs.</p>
            </div>
            <div className={`ai-connection-badge ${cameraActive ? "online" : "offline"}`}>
              <span /> {cameraActive ? "Camera connected" : "Waiting for camera"}
            </div>
          </div>
          <div className="camera-source-switch" role="group" aria-label="Camera source">
            <button type="button" className={cameraSource === "device" ? "active" : ""} aria-pressed={cameraSource === "device"} onClick={() => changeCameraSource("device")}>Device camera</button>
            <button type="button" className={cameraSource === "network" ? "active" : ""} aria-pressed={cameraSource === "network"} onClick={() => changeCameraSource("network")}>TP-Link C230</button>
          </div>
          {cameraSource === "network" ? (
            <form className="camera-source-config" onSubmit={connectNetworkCamera}>
              <label>
                Camera IP
                <input className="form-control" type="text" inputMode="decimal" value={rtspIp} onChange={(event) => setRtspIp(event.target.value)} required disabled={rtspConnecting || rtspConnected} />
              </label>
              <label>
                Camera account
                <input className="form-control" type="text" autoComplete="username" value={rtspUsername} onChange={(event) => setRtspUsername(event.target.value)} required disabled={rtspConnecting || rtspConnected} />
              </label>
              <label>
                Password
                <input className="form-control" type="password" autoComplete="current-password" value={rtspPassword} onChange={(event) => setRtspPassword(event.target.value)} required disabled={rtspConnecting || rtspConnected} />
              </label>
              {rtspConnected ? (
                <button type="button" className="btn btn-outline-secondary" onClick={disconnectNetworkCamera}>Disconnect</button>
              ) : (
                <button type="submit" className="btn btn-primary" disabled={rtspConnecting}>{rtspConnecting ? "Connecting..." : "Connect camera"}</button>
              )}
            </form>
          ) : (
            <div className="camera-source-config">
              <label>
                Device camera
                <select className="form-select" value={selectedDeviceId} onChange={(event) => setSelectedDeviceId(event.target.value)}>
                  {videoDevices.length === 0 && <option value="">No browser cameras found</option>}
                  {videoDevices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}
                </select>
              </label>
              <button type="button" className="btn btn-outline-primary" onClick={() => connectDeviceCamera(selectedDeviceId)} disabled={!selectedDeviceId}>Connect device</button>
            </div>
          )}
          <div className="row g-3 align-items-stretch">
            <div className="col-12">
              {cameraSource === "network" && rtspConnected ? (
                <div className="live-video-stage">
                  <img ref={cameraImageRef} className="live-camera-video" src={`${AI_API_URL}/api/camera/stream.mjpg?v=${rtspStreamVersion}`} crossOrigin="anonymous" alt="TP-Link C230 live feed" onError={() => { setRtspConnected(false); setCameraPermissionError("The camera stream stopped. Reconnect the camera and try again."); }} />
                  <canvas ref={overlayCanvasRef} className="live-ai-overlay" aria-label="Live AI detection boxes" />
                </div>
              ) : cameraSource === "device" && cameraConnected && cameraStream ? (
                <div className="live-video-stage">
                  <video ref={videoRef} className="live-camera-video" autoPlay playsInline muted />
                  <canvas ref={overlayCanvasRef} className="live-ai-overlay" aria-label="Live AI detection boxes" />
                </div>
              ) : (
                <div className="live-camera-placeholder camera-placeholder-compact">
                  <FaCameraRetro size={38} />
                  <strong>{cameraError ? "Unable to play this camera feed" : "Camera is not connected"}</strong>
                  <span>{cameraError ? "Allow camera access and reload the page." : "Waiting for the saved camera to connect."}</span>
                </div>
              )}
            </div>
          </div>
          {cameraPermissionError && <div className="alert alert-warning mt-3 mb-0 small">{cameraPermissionError}</div>}
        </div>
      </div>

      <div className="panel-card ai-camera-panel mb-4">
        <div className="card-body">
          <div className="d-flex flex-wrap justify-content-between align-items-start gap-3 mb-3">
            <div>
              <div className="page-badge mb-2">LIVE AI CAMERA</div>
              <h5 className="fw-bold mb-1">Continuous pig analysis</h5>
              <p className="text-muted mb-0">The camera preview stays live while the AI updates detection boxes, identities, and weights in the same view.</p>
            </div>
            <div className={`ai-connection-badge ${aiStatus.connected ? "online" : "offline"}`}>
              <span /> {aiStatus.loading ? "Checking backend" : aiStatus.connected ? "AI backend online" : "AI backend offline"}
            </div>
          </div>
          <div className="ai-camera-actions">
            <label className="btn btn-success">
              <FaUpload className="me-2" /> {aiProcessing ? "Analyzing live feed..." : "Test with image upload"}
              <input type="file" accept="image/*" onChange={processAiImage} hidden disabled={aiProcessing} />
            </label>
            <button type="button" className="btn btn-outline-primary" onClick={analyzeCurrentFrame} disabled={!cameraActive || aiProcessing || !aiStatus.connected}>
              Analyze now
            </button>
            <label className="form-check form-switch mb-0">
              <input className="form-check-input" type="checkbox" checked={autoAnalyze} onChange={(event) => setAutoAnalyze(event.target.checked)} disabled={!cameraActive || !aiStatus.connected} />
              <span className="form-check-label small">Auto-analyze every 5 seconds</span>
            </label>
              <span className="small text-muted">{autoAnalyze && cameraActive ? "Live analysis active" : "Live analysis paused"} · {aiStatus.models.length ? aiStatus.models.join(", ") : "no models"} · Sensor temperatures: {liveTemperatureSummary}</span>
          </div>
          {aiError && <div className="alert alert-warning mt-3 mb-0">{aiError} Start the FastAPI backend on port 8000 first.</div>}
          {aiPreviewUrl && (
            <div className="ai-preview-wrap mt-3">
              <div className="ai-preview-label">Uploaded image · detection boxes</div>
              <div className="ai-preview-stage">
                <img
                  src={aiPreviewUrl}
                  alt="Uploaded image with AI detection boxes"
                  onLoad={(event) => setAiPreviewSize({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  })}
                />
                {aiPreviewSize && aiResults.map((pig, index) => {
                  const { x1, y1, x2, y2 } = pig.box || {};
                  if (
                    [x1, y1, x2, y2].some((value) => typeof value !== "number" || !Number.isFinite(value))
                    || x2 <= x1
                    || y2 <= y1
                  ) return null;
                  const detection = pig.detection || {};
                  const label = `${detection.class_name || "Pig"} ${Number.isFinite(detection.confidence) ? `${Math.round(detection.confidence * 100)}%` : ""}`.trim();
                  return (
                    <div
                      className="ai-bounding-box"
                      key={`${pig.pig_id}-${index}`}
                      style={{
                        left: `${(x1 / aiPreviewSize.width) * 100}%`,
                        top: `${(y1 / aiPreviewSize.height) * 100}%`,
                        width: `${((x2 - x1) / aiPreviewSize.width) * 100}%`,
                        height: `${((y2 - y1) / aiPreviewSize.height) * 100}%`,
                      }}
                    >
                      <span style={y1 < 25 ? { top: 0 } : undefined}>{label}</span>
                    </div>
                  );
                })}
              </div>
              {aiResults.length === 0 && !aiProcessing && !aiError && (
                <p className="small text-muted mt-2 mb-0">No objects were detected in this image.</p>
              )}
            </div>
          )}
          {aiResults.length > 0 && (
            <div className="ai-results-grid mt-3">
              {aiResults.map((pig, index) => {
                const sensorTemperature = latestTemperatureByPigId.get(pig.farm_pig_id);
                return (
                  <div className="ai-result-card" key={`${pig.pig_id}-${index}`}>
                    <FaRobot />
                    <strong>{pig.identity_status === "duplicate-prediction" ? "Identity conflict: review" : `Pen tag: ${pig.tag_id || "Unassigned"}`}</strong>
                    <span>AI class: {pig.model_identity || pig.pig_id || "Unknown"}</span>
                    <span>{pig.recognition_confidence}% identity confidence</span>
                    <b>{pig.estimated_weight_kg == null ? "Weight unavailable" : `${pig.weight_source === "registered_measurement" ? "Registered weight" : "Estimated weight"}: ${pig.estimated_weight_kg} kg`}</b>
                    <span>Sensor temperature: {sensorTemperature ? `${Number(sensorTemperature.temperatureC).toFixed(1)}°C` : "No reading"}</span>
                    <span>Behavior: {pig.behavior_indicator || "Unavailable"}{pig.behavior_confidence == null ? "" : ` · ${pig.behavior_confidence}%`}</span>
                    <small className="text-muted">{pig.behavior_source || "Movement heuristic"}</small>
                  </div>
                );
              })}
            </div>
          )}
          {!aiProcessing && !aiError && aiResults.length === 0 && <div className="small text-muted mt-3">No AI result yet. Upload a clear image containing one or more pigs.</div>}
        </div>
      </div>

    </DashboardLayout>
  );
}
