export default function TempHumidityChart({ temperature, humidity }) {
  const labels = ["12AM", "4AM", "8AM", "12PM", "4PM", "8PM"];
  const width = 560;
  const height = 300;
  const padding = 36;
  const maxTemp = 40;
  const maxHumidity = 100;

  const createPoints = (values, maxValue) =>
    values.map((value, index) => {
      const x = padding + (index * (width - padding * 2)) / (labels.length - 1);
      const y = height - padding - (value / maxValue) * (height - padding * 2);
      return { x, y, value };
    });

  const tempPoints = createPoints(temperature, maxTemp);
  const humidityPoints = createPoints(humidity, maxHumidity);

  const tempPath = tempPoints.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x},${point.y}`).join(" ");
  const humidityPath = humidityPoints.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x},${point.y}`).join(" ");

  return (
    <div className="chart-shell w-100" style={{ maxWidth: "760px" }}>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-100" role="img" aria-label="Temperature and humidity trend chart">
        <defs>
          <linearGradient id="temp-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ef4444" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#ef4444" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="humidity-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
          </linearGradient>
        </defs>

        {[20, 40, 60, 80, 100].map((value) => {
          const y = height - padding - (value / maxHumidity) * (height - padding * 2);
          return (
            <g key={value}>
              <line x1={padding} y1={y} x2={width - padding} y2={y} stroke="#e2e8f0" strokeDasharray="4 6" strokeWidth="1" />
              <text x={padding - 10} y={y + 4} textAnchor="end" fontSize="11" fill="#94a3b8">{value}%</text>
            </g>
          );
        })}

        <path d={`${humidityPath} L ${width - padding},${height - padding} L ${padding},${height - padding} Z`} fill="url(#humidity-area)" />
        <path d={`${tempPath} L ${width - padding},${height - padding} L ${padding},${height - padding} Z`} fill="url(#temp-area)" />

        <path d={tempPath} fill="none" stroke="#ef4444" strokeWidth="3" strokeLinecap="round" />
        <path d={humidityPath} fill="none" stroke="#3b82f6" strokeWidth="3" strokeLinecap="round" />

        {tempPoints.map((point, index) => (
          <g key={`temp-${index}`}>
            <circle cx={point.x} cy={point.y} r="6" fill="#fff" stroke="#ef4444" strokeWidth="2" />
            <circle cx={point.x} cy={point.y} r="3" fill="#ef4444" />
          </g>
        ))}

        {humidityPoints.map((point, index) => (
          <g key={`hum-${index}`}>
            <circle cx={point.x} cy={point.y} r="6" fill="#fff" stroke="#3b82f6" strokeWidth="2" />
            <circle cx={point.x} cy={point.y} r="3" fill="#3b82f6" />
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