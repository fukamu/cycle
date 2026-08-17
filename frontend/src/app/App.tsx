import { BrowserRouter, Route, Routes } from "react-router-dom";

import { HomePage } from "../pages/HomePage";
import { PastCycleDetailPage } from "../pages/PastCycleDetailPage";
import { PastCyclesPage } from "../pages/PastCyclesPage";
import { SettingsPage } from "../pages/SettingsPage";
import { AppLayout } from "./AppLayout";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/cycles" element={<PastCyclesPage />} />
          <Route path="/cycles/:cycleId" element={<PastCycleDetailPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
