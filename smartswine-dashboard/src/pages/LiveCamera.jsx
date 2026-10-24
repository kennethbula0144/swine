import { useRef, useState } from "react";
import { FaVideo, FaPlug, FaPowerOff, FaCameraRetro } from "react-icons/fa";
import DashboardLayout from "../layouts/DashboardLayout";

export default function LiveCamera() {
  const videoRef = useRef(null);
  const [cameraUrl, setCameraUrl] = useState("");
  const [isConnected, setIsConnected] = useState(false);
  const [lastConnected, setLastConnected] = useState(null);
  const [videoError, setVideoError] = useState(false);

  const handleConnect = () => {
    if (!cameraUrl) return;
    setVideoError(false);
    setLastConnected(null);
    setIsConnected(true);
  };

  const handleDisconnect = () => {
    setIsConnected(false);
  };

  const handleVideoLoaded = () => {
    setLastConnected(new Date());
  };

  const handleVideoTimeUpdate = () => {
    if (!videoRef.current) return;
    if (videoRef.current.currentTime >= 30) {
      videoRef.current.currentTime = 0;
      videoRef.current.play();
    }
  };

  return (
    <DashboardLayout>
      <section className="page-hero">
        <div>
          <div className="page-badge">THERMAL MODULE / LIVE FEED</div>
          <h2>Thermal Screening</h2>
          <p>Review the pen-wide thermal feed used to screen for heat stress and possible fever responses.</p>
        </div>
        <div className="chip-list">
          <span className="chip">MLX90640 pen view</span>
          <span className="chip">MLX90614 confirmation</span>
          <span className="chip">Veterinary review support</span>
        </div>
      </section>

      <div className="panel-card mb-4">
        <div className="card-body">
          <div className="d-flex flex-wrap gap-3 justify-content-between align-items-center mb-4">
            <div>
                <h5 className="fw-bold mb-1">Thermal camera connection</h5>
                <small className="text-muted">Enter the thermal stream URL from the pen system.</small>
            </div>
            <div className="d-flex gap-2 flex-wrap">
              <button
                type="button"
                className={`btn ${isConnected ? "btn-danger" : "btn-success"}`}
                onClick={isConnected ? handleDisconnect : handleConnect}
              >
                {isConnected ? <><FaPowerOff className="me-2" /> Disconnect</> : <><FaPlug className="me-2" /> Connect</>}
              </button>
            </div>
          </div>

          <div className="row g-3">
            <div className="col-md-8">
              <label className="form-label">Thermal stream URL</label>
              <input
                className="form-control"
                placeholder="https://your-thermal-stream-url"
                value={cameraUrl}
                onChange={(event) => setCameraUrl(event.target.value)}
              />
              <div className="text-muted mt-2 small">Connect a compatible thermal video stream URL.</div>
            </div>
            <div className="col-md-4">
              <div className="stat-card p-3 text-center">
                <div className="text-muted mb-2">Thermal link</div>
                <div className={`fw-bold ${isConnected ? "text-success" : "text-danger"}`}>
                  {videoError ? "Stream unavailable" : isConnected ? lastConnected ? "Receiving video" : "Connecting" : "Disconnected"}
                </div>
                <div className="small text-muted mt-2">
                  {lastConnected ? `Last connected ${lastConnected.toLocaleTimeString()}` : "No connection yet"}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="panel-card">
        <div className="card-body">
          <div className="d-flex justify-content-between align-items-center mb-4">
            <div>
              <h5 className="fw-bold mb-1">Camera feed</h5>
              <small className="text-muted">Pen-wide thermal preview for screening and referral support.</small>
            </div>
            <span className="badge bg-info text-dark">{isConnected ? "Live" : "Offline"}</span>
          </div>

          <div className="live-camera-shell">
            {isConnected && cameraUrl && !videoError ? (
              <video
                ref={videoRef}
                className="live-camera-video"
                controls
                autoPlay
                muted
                loop
                src={cameraUrl}
                onLoadedData={handleVideoLoaded}
                onError={() => { setVideoError(true); setIsConnected(false); }}
                onTimeUpdate={handleVideoTimeUpdate}
              >
                Your browser does not support video playback.
              </video>
            ) : (
              <div className="live-camera-placeholder">
                <FaCameraRetro size={48} className="mb-3" />
                <div className="fw-semibold mb-1">
                  {videoError ? "Unable to play the selected thermal stream" : "Thermal camera is not connected"}
                </div>
                <div className="text-muted">
                  {videoError
                    ? "Check the stream URL and confirm it is reachable from this browser."
                    : "Enter a thermal stream URL and press connect to view the screening feed."}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
