import React from "react";
import ReactDOM from "react-dom/client";
import { Toaster } from "sonner";
import { App } from "./App.js";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
    <Toaster
      position="top-right"
      toastOptions={{
        classNames: {
          toast: "win98-toast",
          title: "win98-toast-title",
          description: "win98-toast-description",
          actionButton: "win98-toast-action",
          cancelButton: "win98-toast-cancel"
        }
      }}
    />
  </React.StrictMode>
);
