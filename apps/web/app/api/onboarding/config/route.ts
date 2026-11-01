import { NextResponse } from "next/server";
import { agentOnboardingConfig } from "../../../lib/agent-onboarding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(agentOnboardingConfig(), {
    headers: { "Cache-Control": "no-store" },
  });
}
