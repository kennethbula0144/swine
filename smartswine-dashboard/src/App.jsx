import { BrowserRouter, Routes, Route } from "react-router-dom";

import Dashboard from "./pages/Dashboard";
import PigRecords from "./pages/PigRecords";
import HealthAlerts from "./pages/HealthAlerts";
import Reports from "./pages/Reports";
import Settings from "./pages/Settings";
import LivePen from "./pages/LivePen";
import LiveCamera from "./pages/LiveCamera";
import FeedCosts from "./pages/FeedCosts";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/pig-records" element={<PigRecords />} />
        <Route path="/health-alerts" element={<HealthAlerts />} />
        <Route path="/live-pen" element={<LivePen />} />
        <Route path="/model" element={<LivePen />} />
        <Route path="/live-camera" element={<LiveCamera />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/feed-costs" element={<FeedCosts />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </BrowserRouter>
  );
}