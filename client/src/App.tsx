import { Routes, Route } from "react-router-dom";
import ComputerPage from "./pages/ComputerPage";
import MobilePage from "./pages/MobilePage";

function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-lg font-medium text-(--color-ink)">Page not found</p>
      <p className="text-sm text-(--color-ink-muted)">
        If you scanned a QR code, ask for a fresh one - the old session may have ended.
      </p>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<ComputerPage />} />
      <Route path="/upload/:sessionId" element={<MobilePage />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
