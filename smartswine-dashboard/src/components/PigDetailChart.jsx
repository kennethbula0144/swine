export default function PigDetailChart({ weightHistory, tempHistory }) {
  const labels = ["-5W", "-4W", "-3W", "-2W", "-1W", "Now"];
  const width = 560;
  const height = 300;
  const padding = 36;
  const maxWeight = Math.max(...weightHistory, 1) + 8;
  const maxTemp = Math.max(...tempHistory, 40);

  const createPoints = (values, maxValue) =>
    values.map((value, index) => {
      const x = padding + (index * (width - padding * 2)) / (values.length - 1);
      const y = height - padding - (value / maxValue) * (height - padding * 2);
      return { x, y, value };
    });

  const weightPoints = createPoints(weightHistory, maxWeight);
  const tempPoints = createPoints(tempHistory, maxTemp);

  const weightPath = weightPoints.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x},${point.y}`).join(" ");
  const tempPath = tempPoints.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x},${point.y}`).join(" ");

  return (
    <div className="chart-shell w-100" style={{ maxWidth: "760px" }}>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-100" role="img" aria-label="Pig trend chart">
        <defs>
          <linearGradient id="detail-weight-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2563eb" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#2563eb" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="detail-temp-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ef4444" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#ef4444" stopOpacity="0" />
          </linearGradient>
        </defs>

        {[20, 40, 60, 80, 100].map((value) => {
          const y = height - padding - (value / maxTemp) * (height - padding * 2);
          return (
            <g key={value}>
              <line x1={padding} y1={y} x2={width - padding} y2={y} stroke="#e2e8f0" strokeDasharray="4 6" strokeWidth="1" />
              <text x={padding - 10} y={y + 4} textAnchor="end" fontSize="11" fill="#94a3b8">{value}°C</text>
            </g>
          );
        })}

        <path d={`${tempPath} L ${width - padding},${height - padding} L ${padding},${height - padding} Z`} fill="url(#detail-temp-area)" />
        <path d={`${weightPath} L ${width - padding},${height - padding} L ${padding},${height - padding} Z`} fill="url(#detail-weight-area)" />

        <path d={weightPath} fill="none" stroke="#2563eb" strokeWidth="3" strokeLinecap="round" />
        <path d={tempPath} fill="none" stroke="#ef4444" strokeWidth="3" strokeLinecap="round" />

        {weightPoints.map((point, index) => (
          <g key={`w-${index}`}>
            <circle cx={point.x} cy={point.y} r="6" fill="#fff" stroke="#2563eb" strokeWidth="2" />
            <circle cx={point.x} cy={point.y} r="3" fill="#2563eb" />
          </g>
        ))}

        {tempPoints.map((point, index) => (
          <g key={`t-${index}`}>
            <circle cx={point.x} cy={point.y} r="6" fill="#fff" stroke="#ef4444" strokeWidth="2" />
            <circle cx={point.x} cy={point.y} r="3" fill="#ef4444" />
          </g>
        ))}

        {labels.map((label, index) => {
          const x = padding + (index * (width - padding * 2)) / (labels.length - 1);
          return (
            <text key={label} x={x} y={height - 10} textAnchor="middle" fontSize="11" fill="#64748b">{label}</text>
          );
        })}
      </svg>
    </div>
  );
}
