import React from "react";
import { createRoot } from "react-dom/client";
import App from "../iac-repo-configurator.jsx";
import "./styles.css";

// The component optionally calls a global `sendPrompt(...)` (provided by the
// artifact host). Stub it so the standalone app doesn't break on "Next steps".
if (typeof window.sendPrompt !== "function") {
  window.sendPrompt = (prompt) => {
    console.log("[sendPrompt]", prompt);
    alert("Next step prompt:\n\n" + prompt);
  };
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
