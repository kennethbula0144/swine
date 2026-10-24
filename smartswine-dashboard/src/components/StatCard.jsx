import React from "react";

const colorMap = {
  success: { bg: "linear-gradient(135deg, #16a34a, #22c55e)", text: "#fff" },
  primary: { bg: "linear-gradient(135deg, #2563eb, #3b82f6)", text: "#fff" },
  warning: { bg: "linear-gradient(135deg, #d97706, #f59e0b)", text: "#fff" },
  info: { bg: "linear-gradient(135deg, #0891b2, #06b6d4)", text: "#fff" },
};

export default function StatCard({ title, value, icon, color = "success" }) {
  const palette = colorMap[color] || colorMap.success;

  return (
    <div className="stat-card h-100">
      <div className="d-flex justify-content-between align-items-center h-100">
        <div>
          <small className="text-muted">{title}</small>
          <h3 className="fw-bold mt-2 mb-0">{value}</h3>
        </div>

        <div
          className="stat-icon"
          style={{ background: palette.bg, color: palette.text }}
        >
          {icon}
        </div>
      </div>
    </div>
  );
}