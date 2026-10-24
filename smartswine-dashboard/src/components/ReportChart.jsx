export default function ReportChart({ labels, data }) {
  const width = 560;
  const height = 300;
  const padding = 34;
  const maxValue = Math.max(...data, 1);
  const barWidth = 54;
  const gap = 30;

  return (
    <div className="chart-shell w-100" style={{ maxWidth: "760px" }}>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-100" role="img" aria-label="Average weight by growth stage chart">
        <defs>
          {data.map((_, index) => (
            <linearGradient key={index} id={`bar-grad-${index}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={index % 2 === 0 ? "#2563eb" : "#16a34a"} stopOpacity="0.92" />
              <stop offset="100%" stopColor={index % 2 === 0 ? "#2563eb" : "#16a34a"} stopOpacity="0.3" />
            </linearGradient>
          ))}
        </defs>

        {[20, 40, 60, 80, 100].map((value) => {
          const y = height - padding - (value / maxValue) * (height - padding * 2);
          return (
            <g key={value}>
              <line x1={padding} y1={y} x2={width - padding} y2={y} stroke="#e2e8f0" strokeDasharray="4 6" strokeWidth="1" />
              <text x={padding - 10} y={y + 4} textAnchor="end" fontSize="11" fill="#94a3b8">{value}</text>
            </g>
          );
        })}

        {data.map((value, index) => {
          const barHeight = (value / maxValue) * (height - padding * 2);
          const x = padding + index * (barWidth + gap);
          const y = height - padding - barHeight;

          return (
            <g key={labels[index]}>
              <rect x={x} y={y} width={barWidth} height={barHeight} rx="14" fill={`url(#bar-grad-${index})`} />
              <text x={x + barWidth / 2} y={y - 10} textAnchor="middle" fontSize="12" fill="#0f172a" fontWeight="700">{value}</text>
              <text x={x + barWidth / 2} y={height - 10} textAnchor="middle" fontSize="11" fill="#64748b">{labels[index]}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}