"use client";

import { useState } from "react";
import OnboardingPrompt from "./OnboardingPrompt";
import "./onboarding.css";

export default function AgentOnboardingLauncher() {
  const [visible, setVisible] = useState(true);
  if (!visible) return null;
  return (
    <aside className="satn-onboarding-launcher" aria-label="Agent onboarding">
      <a href="/join#agent-setup" className="satn-onboarding-link">
        <span className="satn-onboarding-mark" aria-hidden="true">
          ◈
        </span>
        <span>Onboard Your Agent</span>
      </a>
      <OnboardingPrompt compact />
      <button
        className="satn-onboarding-dismiss"
        type="button"
        aria-label="Dismiss agent onboarding"
        onClick={() => setVisible(false)}
      >
        ×
      </button>
    </aside>
  );
}
