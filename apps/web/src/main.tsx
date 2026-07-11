import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter, Link, Route, Routes } from "react-router-dom";
import { Topics } from "./pages/Topics";
import { TopicWorkbench } from "./pages/TopicWorkbench";
import { Providers } from "./pages/Providers";
import { Prompts } from "./pages/Prompts";
import "./styles.css";

function App() {
  return (
    <HashRouter>
      <div className="topbar">
        <span className="logo">视频制作一条龙</span>
        <Link to="/">选题</Link>
        <Link to="/providers">引擎管理</Link>
        <Link to="/prompts">平台模板管理</Link>
      </div>
      <Routes>
        <Route path="/" element={<Topics />} />
        <Route path="/topic/:id" element={<TopicWorkbench />} />
        <Route path="/providers" element={<Providers />} />
        <Route path="/prompts" element={<Prompts />} />
      </Routes>
    </HashRouter>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
